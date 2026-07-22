// openrouter-agent — run a named OpenRouter instance (e.g. Kimi, GLM) as a
// bounded tool-use agent, then store its full result in routiner_runs (the Log).
//
// Why this exists: Routiner's Claude accounts fire agentic Claude Code sessions;
// the built-in "OpenRouter" account runs Perplexity lead enrichment. This adds a
// THIRD executor — a user-addable OpenRouter "agent" account whose named
// instances each run a chosen model in a small tool loop that can:
//   • read the owner's Routiner data (routines / notes / staged leads),
//   • do web / deep research (Perplexity via OpenRouter),
//   • write into the owner's apps (a Routiner note, or find+save leads into
//     Command's Review tab via the lead-enrichment engine),
//   • work on code (the "code" tool group): read repo files, inspect PRs, and
//     propose a fix as a pull request / merge it — via the GitHub REST API, so
//     a non-Claude model can fix & merge code with no Claude session and no
//     shell/sandbox. Gated on a GITHUB_TOKEN edge secret (merge additionally on
//     AGENT_ALLOW_MERGE); see the code-tools section below.
//
// Key resolution (per call): the account's own OpenRouter key
// (routiner_settings.accounts[account].key) if the owner set one, else the
// server-side OPENROUTER_API_KEY edge secret. The key never reaches the browser.
//
// Auth (hard — the function is NOT world-callable):
//   1. RESPONDER_SECRET (Bearer or x-responder-secret), when that edge secret is set, OR
//   2. SUPABASE_SERVICE_ROLE_KEY as Bearer (scheduler / server callers), OR
//   3. a valid Supabase user JWT (Authorization Bearer, or body.accessToken so the
//      browser can authenticate without a CORS preflight — see agentPost in app.js).
// Owner user_id is resolved from the JWT when present, else routineId, else the
// single-owner fallback. GitHub write tools still require GITHUB_TOKEN; merge
// still requires AGENT_ALLOW_MERGE. Models may open PRs freely once authorized.
//
// Request (POST JSON):
//   Fresh run:  { prompt, model?, tools?: ("read"|"research"|"write"|"code")[], account?,
//                 triggerKey?, routineId?, title?, source?, ping? }
//   Continue:   { runId, prompt }   — resumes that stored run's transcript with
//               its own model/account/trigger/tools; the follow-up is `prompt`.
// Response:
//   { ok: true, runId, output, steps?, cost, model, keySource }   (ping: { ok, keySource, model })
//   { ok: false, error }
// The full message transcript is persisted on the run row (routiner_runs.messages)
// so the app can render the whole exchange and continue it (issues #51, #52).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const DEFAULT_MODEL = "moonshotai/kimi-k2.7-code";
const RESEARCH_MODEL = Deno.env.get("AGENT_RESEARCH_MODEL") || "perplexity/sonar-pro";

// Models this agent will bill against. Mirrors the OpenRouter ids offered in the
// app's instance picker (js/model-router.js MODELS). Override with the
// AGENT_ALLOWED_MODELS edge secret (comma-separated) to add/restrict.
const AGENT_DEFAULT_ALLOWED = [
  "openrouter/auto",
  "openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/gpt-5.6-luna",
  "google/gemini-3.1-pro-preview", "google/gemini-3.5-flash", "google/gemini-3-flash-preview",
  "deepseek/deepseek-chat", "moonshotai/kimi-k2.7-code",
  "meta-llama/llama-3.3-70b-instruct", "z-ai/glm-4.7", "z-ai/glm-5",
];
const allowedModels = (): Set<string> => {
  const raw = Deno.env.get("AGENT_ALLOWED_MODELS");
  const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : AGENT_DEFAULT_ALLOWED;
  return new Set(list);
};

// Tunables (all optional env overrides).
const num = (name: string, def: number) => Number(Deno.env.get(name)) || def;
const MAX_STEPS = num("AGENT_MAX_STEPS", 6);          // tool-loop turns before we stop
const CODE_MAX_STEPS = num("AGENT_CODE_MAX_STEPS", 12); // coding needs read→fix→merge room
// Coding runs need more turns to read the repo, write files, and open/merge a PR.
const stepBudgetFor = (enabled: Set<string>) => enabled.has("code") ? Math.max(MAX_STEPS, CODE_MAX_STEPS) : MAX_STEPS;
const MAX_TOKENS = Math.min(num("AGENT_MAX_TOKENS", 4096), 8192);
const CALL_TIMEOUT_MS = num("AGENT_CALL_TIMEOUT_MS", 90_000);
const DEADLINE_MS = num("AGENT_DEADLINE_MS", 130_000); // overall wall-clock budget
const TOOL_RESULT_CAP = num("AGENT_TOOL_RESULT_CAP", 6000);
const OUTPUT_CAP = num("AGENT_OUTPUT_CAP", 60_000);    // full-length, but sane

// ── GitHub (the "code" tool group) ───────────────────────────────────────────
// Lets a non-Claude instance read the repo, inspect PRs, and — the whole point —
// propose a fix as a PR and merge it, entirely through the GitHub REST API (no
// shell/sandbox needed). Guard-railed: it only works when GITHUB_TOKEN is set,
// only touches allowed repos, and won't merge unless AGENT_ALLOW_MERGE is on.
const GH_API = "https://api.github.com";
const GH_TOKEN = () => Deno.env.get("GITHUB_TOKEN") || Deno.env.get("GH_TOKEN") || "";
const GH_DEFAULT_REPO = () => (Deno.env.get("GITHUB_REPO") || "").trim();
const GH_ALLOW_MERGE = () => /^(1|true|yes|on)$/i.test(Deno.env.get("AGENT_ALLOW_MERGE") || "");
// null = "only the default repo is allowed"; a set = that explicit allowlist.
const ghAllowedRepos = (): Set<string> | null => {
  const raw = Deno.env.get("GITHUB_ALLOWED_REPOS");
  if (!raw) return null;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? new Set(list.map((s) => s.toLowerCase())) : null;
};
// Resolve + authorize the repo for a code tool call.
function resolveRepo(arg?: unknown): { repo?: string; error?: string } {
  const def = GH_DEFAULT_REPO();
  const allow = ghAllowedRepos();
  const want = (typeof arg === "string" && arg.trim()) ? arg.trim() : def;
  if (!want) return { error: "no repo: set the GITHUB_REPO edge secret or pass repo as 'owner/name'." };
  if (!/^[^/\s]+\/[^/\s]+$/.test(want)) return { error: `bad repo '${want}' — want 'owner/name'.` };
  if (allow) { if (!allow.has(want.toLowerCase())) return { error: `repo '${want}' is not in GITHUB_ALLOWED_REPOS.` }; }
  else if (def && want.toLowerCase() !== def.toLowerCase()) return { error: `repo '${want}' not allowed (only '${def}'); set GITHUB_ALLOWED_REPOS to widen.` };
  return { repo: want };
}
const ghPath = (p: string) => String(p).replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
// UTF-8-safe base64 both directions (GitHub contents API is base64).
const b64encode = (s: string) => btoa(unescape(encodeURIComponent(s)));
const b64decode = (s: string) => decodeURIComponent(escape(atob(String(s).replace(/\n/g, ""))));
async function gh(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const token = GH_TOKEN();
  try {
    const r = await fetch(`${GH_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "routiner-openrouter-agent",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const text = await r.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    const msg = e instanceof DOMException && e.name === "TimeoutError" ? `GitHub call timed out (${CALL_TIMEOUT_MS}ms)` : (e as Error).message;
    return { ok: false, status: 0, data: { message: msg } };
  }
}

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, apikey, x-responder-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });

function bearerToken(req: Request): string {
  const h = req.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

// Verify a Supabase user access token via GoTrue. Returns the user id or null.
async function verifyUserJwt(token: string): Promise<string | null> {
  if (!token || !SB_URL) return null;
  // Service role or anon both work as apikey for /auth/v1/user when Authorization
  // is the user's JWT; prefer service role (always present on edge functions).
  const apikey = Deno.env.get("SUPABASE_ANON_KEY") || SB_KEY;
  if (!apikey) return null;
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return null;
    const u = await r.json();
    return typeof u?.id === "string" && u.id ? u.id : null;
  } catch {
    return null;
  }
}

// Hard auth for every call. Prevents the open internet from driving GITHUB_TOKEN /
// OPENROUTER_API_KEY even though verify_jwt is false at the gateway (needed so
// the browser can use a simple CORS POST with the token in the JSON body).
async function authorizeCaller(
  req: Request,
  body: Record<string, unknown>,
): Promise<{ ok: true; userId: string | null; via: string } | { ok: false; error: string }> {
  const bearer = bearerToken(req);
  const headerSecret = (req.headers.get("x-responder-secret") || "").trim();
  const gate = (Deno.env.get("RESPONDER_SECRET") || "").trim();

  if (gate && (bearer === gate || headerSecret === gate)) {
    return { ok: true, userId: null, via: "responder-secret" };
  }
  if (SB_KEY && bearer === SB_KEY) {
    return { ok: true, userId: null, via: "service-role" };
  }

  // Prefer header JWT; fall back to body.accessToken (CORS-simple browser path).
  const bodyTok = typeof body.accessToken === "string" ? body.accessToken.trim()
    : (typeof body.access_token === "string" ? body.access_token.trim() : "");
  const candidates = [bearer, bodyTok].filter((t) => t && t !== SB_KEY && t !== gate);
  for (const tok of candidates) {
    const userId = await verifyUserJwt(tok);
    if (userId) return { ok: true, userId, via: "user-jwt" };
  }

  return {
    ok: false,
    error: "Unauthorized — sign in, or call with the service role / RESPONDER_SECRET.",
  };
}

// ── Supabase REST helpers (service role) ─────────────────────────────────────
const rest = (path: string) => `${SB_URL}/rest/v1/${path}`;
const H = () => ({ apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json" });
async function sbGet(path: string): Promise<any[]> {
  const r = await fetch(rest(path), { headers: H() });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

// Map a tool function name → tool-group id (must match Settings checkboxes).
function toolGroupOf(name: string): string | null {
  if (name === "read_routines" || name === "read_notes" || name === "read_leads") return "read";
  if (name === "web_research") return "research";
  if (name === "write_note" || name === "find_and_save_leads") return "write";
  if (name.startsWith("gh_")) return "code";
  return null;
}

// The single owner user_id, resolved from a routineId when given (so the run row
// inherits the right owner + title), else inferred from existing rows — the same
// single-tenant fallback routiner-admin uses.
async function resolveOwner(routineId?: string): Promise<{ userId: string | null; title: string }> {
  if (routineId) {
    try {
      const rows = await sbGet(`routiner_routines?id=eq.${encodeURIComponent(routineId)}&select=user_id,title&limit=1`);
      if (rows?.[0]?.user_id) return { userId: rows[0].user_id, title: rows[0].title || "" };
    } catch { /* fall through */ }
  }
  for (const path of ["routiner_routines?select=user_id&limit=1", "routiner_notes?select=user_id&limit=1", "routiner_settings?select=user_id&limit=1"]) {
    try { const rows = await sbGet(path); if (rows?.[0]?.user_id) return { userId: rows[0].user_id, title: "" }; } catch { /* try next */ }
  }
  return { userId: null, title: "" };
}

// The account's per-account OpenRouter key override (else null → server key).
async function accountKeyOverride(userId: string | null, account?: string): Promise<string | null> {
  if (!account) return null;
  try {
    const q = userId ? `routiner_settings?user_id=eq.${encodeURIComponent(userId)}&select=accounts&limit=1`
                     : `routiner_settings?select=accounts&limit=1`;
    const rows = await sbGet(q);
    const accts = rows?.[0]?.accounts;
    if (!Array.isArray(accts)) return null;
    const a = accts.find((x: any) => x && x.id === account);
    const key = a && typeof a.key === "string" ? a.key.trim() : "";
    return key || null;
  } catch { return null; }
}

// ── OpenRouter ────────────────────────────────────────────────────────────────
async function openrouter(
  key: string,
  model: string,
  messages: unknown[],
  opts: { tools?: unknown[]; maxTokens?: number } = {},
): Promise<{ ok: boolean; message?: any; usage?: any; error?: string }> {
  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://routiner.zparx.app",
        "X-Title": "Routiner Agent",
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? MAX_TOKENS,
        usage: { include: true },
        ...(opts.tools && opts.tools.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
        messages,
      }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const data = await resp.json();
    if (!resp.ok) return { ok: false, error: data?.error?.message || `OpenRouter HTTP ${resp.status}` };
    return { ok: true, message: data?.choices?.[0]?.message || {}, usage: data?.usage || null };
  } catch (e) {
    const msg = e instanceof DOMException && e.name === "TimeoutError" ? `OpenRouter call timed out (${CALL_TIMEOUT_MS}ms)` : (e as Error).message;
    return { ok: false, error: msg };
  }
}

async function logUsage(model: string, usage: any, account: string | null, triggerKey: string | null, ok = true, error: string | null = null) {
  if (!SB_URL || !SB_KEY) return;
  const row = {
    model,
    prompt_tokens: Number(usage?.prompt_tokens) || 0,
    completion_tokens: Number(usage?.completion_tokens) || 0,
    total_tokens: Number(usage?.total_tokens) || 0,
    cost: Number(usage?.cost) || 0,
    account, trigger_key: triggerKey, source: "openrouter-agent", ok,
    error: error ? String(error).slice(0, 500) : null,
  };
  await fetch(rest("routiner_openrouter_usage"), {
    method: "POST", headers: { ...H(), Prefer: "return=minimal" }, body: JSON.stringify(row),
  }).catch(() => {});
}

async function todaySpend(): Promise<number | null> {
  if (!SB_URL || !SB_KEY) return null;
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  try {
    const rows = await sbGet(`routiner_openrouter_usage?select=cost&created_at=gte.${since.toISOString()}&limit=100000`);
    return rows.reduce((s, r: any) => s + (Number(r.cost) || 0), 0);
  } catch { return null; }
}

// ── Tools ─────────────────────────────────────────────────────────────────────
// Build the OpenAI-style tool specs for the enabled tool groups.
function toolSpecs(enabled: Set<string>): unknown[] {
  const specs: unknown[] = [];
  if (enabled.has("read")) {
    specs.push(
      { type: "function", function: { name: "read_routines", description: "List the owner's Routiner routines (title, prompt, status, schedule).",
        parameters: { type: "object", properties: { limit: { type: "number", description: "max rows (default 20)" } } } } },
      { type: "function", function: { name: "read_notes", description: "List the owner's Routiner board notes.",
        parameters: { type: "object", properties: { limit: { type: "number", description: "max rows (default 30)" } } } } },
      { type: "function", function: { name: "read_leads", description: "List recent leads in the CRM (Command's Review tab / staged_leads).",
        parameters: { type: "object", properties: { limit: { type: "number", description: "max rows (default 25)" } } } } },
    );
  }
  if (enabled.has("research")) {
    specs.push({ type: "function", function: { name: "web_research", description: "Run live web / deep research on a query via Perplexity and return the findings.",
      parameters: { type: "object", required: ["query"], properties: { query: { type: "string", description: "what to research" } } } } });
  }
  if (enabled.has("write")) {
    specs.push(
      { type: "function", function: { name: "write_note", description: "Save a note onto the owner's Routiner board (for later planning / reuse).",
        parameters: { type: "object", required: ["body"], properties: { body: { type: "string", description: "note text (markdown ok)" } } } } },
      { type: "function", function: { name: "find_and_save_leads", description: "Find businesses matching a niche/location and save the new ones into Command's Review tab (staged_leads).",
        parameters: { type: "object", required: ["niche"], properties: {
          niche: { type: "string" }, location: { type: "string" }, count: { type: "number", description: "how many (max 25)" },
          dmTitles: { type: "array", items: { type: "string" }, description: "decision-maker title hints" },
        } } } },
    );
  }
  // Code (GitHub) — only offered when a token is configured, so the model never
  // reaches for a capability the deployment can't back.
  if (enabled.has("code") && GH_TOKEN()) {
    const repoProp = { repo: { type: "string", description: "owner/name; omit to use the configured default repo" } };
    specs.push(
      { type: "function", function: { name: "gh_read_file", description: "Read a file (or list a directory) from the repo. Returns the text and its blob sha. Use this to understand code before changing it.",
        parameters: { type: "object", required: ["path"], properties: { ...repoProp,
          path: { type: "string", description: "path within the repo, e.g. js/app.js (a directory path returns a listing)" },
          ref: { type: "string", description: "branch, tag, or commit sha (default: the repo's default branch)" } } } } },
      { type: "function", function: { name: "gh_list_prs", description: "List pull requests in the repo (number, title, state, branches).",
        parameters: { type: "object", properties: { ...repoProp, state: { type: "string", enum: ["open", "closed", "all"], description: "default open" } } } } },
      { type: "function", function: { name: "gh_read_pr", description: "Read one pull request: its metadata, mergeability, and per-file diffs (patches).",
        parameters: { type: "object", required: ["number"], properties: { ...repoProp, number: { type: "number", description: "the PR number" } } } } },
      { type: "function", function: { name: "gh_propose_change", description: "Fix code: create a branch off the base, write the given file(s) in full, and open a pull request. Provide the COMPLETE new content of each file, not a diff.",
        parameters: { type: "object", required: ["title", "changes"], properties: { ...repoProp,
          title: { type: "string", description: "PR title / commit message" },
          body: { type: "string", description: "PR description (markdown)" },
          base: { type: "string", description: "base branch to target (default: the repo's default branch)" },
          branch: { type: "string", description: "new branch name (default: an auto-generated agent/… name)" },
          changes: { type: "array", description: "files to write", items: { type: "object", required: ["path", "content"],
            properties: { path: { type: "string" }, content: { type: "string", description: "the FULL new file contents" } } } } } } } },
      { type: "function", function: { name: "gh_comment_pr", description: "Post a comment on a pull request or issue (e.g. to explain a proposed fix or leave review notes).",
        parameters: { type: "object", required: ["number", "body"], properties: { ...repoProp, number: { type: "number" }, body: { type: "string" } } } } },
      { type: "function", function: { name: "gh_merge_pr", description: "Merge a pull request. Only works when the deployment has enabled merging (AGENT_ALLOW_MERGE). Prefer squash.",
        parameters: { type: "object", required: ["number"], properties: { ...repoProp, number: { type: "number" },
          method: { type: "string", enum: ["squash", "merge", "rebase"], description: "default squash" } } } } },
    );
  }
  return specs;
}

// Execute a single tool call. Returns a string result (capped by the caller).
// `enabled` is re-checked here so a model cannot invoke a tool group that was
// not offered for this run (e.g. hallucinating gh_* when code is off).
async function runTool(
  name: string,
  args: Record<string, any>,
  ctx: { userId: string | null; key: string; account: string | null; triggerKey: string | null; enabled: Set<string> },
): Promise<string> {
  const group = toolGroupOf(name);
  if (!group || !ctx.enabled.has(group)) {
    return `error: tool '${name}' is not enabled for this run.`;
  }
  // Defense in depth: never hit GitHub without a token even if code is enabled.
  if (group === "code" && !GH_TOKEN()) {
    return "error: no GITHUB_TOKEN configured on the deployment.";
  }
  const owner = ctx.userId ? `user_id=eq.${encodeURIComponent(ctx.userId)}&` : "";
  try {
    switch (name) {
      case "read_routines": {
        const lim = Math.min(Number(args.limit) || 20, 100);
        const rows = await sbGet(`routiner_routines?${owner}select=id,title,prompt,status,recurrence,scheduled_at,account,model&order=updated_at.desc&limit=${lim}`);
        return JSON.stringify(rows);
      }
      case "read_notes": {
        const lim = Math.min(Number(args.limit) || 30, 200);
        const rows = await sbGet(`routiner_notes?${owner}select=id,body,status&order=created_at.desc&limit=${lim}`);
        return JSON.stringify(rows);
      }
      case "read_leads": {
        const lim = Math.min(Number(args.limit) || 25, 200);
        const rows = await sbGet(`staged_leads?select=business_name,website_domain,phone_e164,vertical,status,created_at&order=created_at.desc&limit=${lim}`);
        return JSON.stringify(rows);
      }
      case "web_research": {
        const query = String(args.query || "").trim();
        if (!query) return "error: empty query";
        const r = await openrouter(ctx.key, RESEARCH_MODEL,
          [{ role: "system", content: "You are a precise research assistant. Answer with well-sourced, specific findings." }, { role: "user", content: query }],
          { maxTokens: 2000 });
        await logUsage(RESEARCH_MODEL, r.usage, ctx.account, ctx.triggerKey, r.ok, r.error ?? null);
        if (!r.ok) return `error: ${r.error}`;
        return (r.message?.content || "(empty)").toString();
      }
      case "write_note": {
        const bodyText = String(args.body || "").trim();
        if (!bodyText) return "error: empty note body";
        if (!ctx.userId) return "error: could not resolve owner to save the note";
        const res = await fetch(rest("routiner_notes"), {
          method: "POST", headers: { ...H(), Prefer: "return=minimal" },
          body: JSON.stringify({ user_id: ctx.userId, body: bodyText, status: "brainstorm" }),
        });
        return res.ok ? "saved note to the board (status: brainstorm)" : `error: insert failed (${res.status})`;
      }
      case "find_and_save_leads": {
        const niche = String(args.niche || "").trim();
        if (!niche) return "error: missing niche";
        const res = await fetch(`${SB_URL}/functions/v1/lead-enrichment`, {
          method: "POST", headers: { ...H() },
          body: JSON.stringify({
            niche, location: args.location ?? null, count: Math.min(Number(args.count) || 10, 25),
            dmTitles: Array.isArray(args.dmTitles) ? args.dmTitles : [], toCommand: true, syncAbstrax: false, report: false,
          }),
          signal: AbortSignal.timeout(150_000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) return `error: ${data.error || `enrichment HTTP ${res.status}`}`;
        const t = data.totals || {};
        return `saved ${t.inserted ?? 0} new lead(s) to Command's Review tab (~$${Number(t.cost || 0).toFixed(4)}).`;
      }

      // ── Code (GitHub) ─────────────────────────────────────────────────────
      case "gh_read_file": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const path = String(args.path || "").trim(); if (!path) return "error: missing path";
        const ref = args.ref ? `?ref=${encodeURIComponent(String(args.ref))}` : "";
        const r = await gh("GET", `/repos/${repo}/contents/${ghPath(path)}${ref}`);
        if (!r.ok) return `error: read ${path} → ${r.status}: ${String(r.data?.message || "").slice(0, 160)}`;
        if (Array.isArray(r.data)) return `directory ${path}:\n` + r.data.map((e: any) => `${e.type === "dir" ? "dir " : "file"}  ${e.path}`).join("\n");
        if (r.data?.encoding !== "base64") return `error: ${path} is not a readable text file.`;
        return `path: ${r.data.path}\nsha: ${r.data.sha}\n\n${b64decode(r.data.content)}`;
      }
      case "gh_list_prs": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const state = ["open", "closed", "all"].includes(args.state) ? args.state : "open";
        const r = await gh("GET", `/repos/${repo}/pulls?state=${state}&per_page=20`);
        if (!r.ok) return `error: list PRs → ${r.status}: ${String(r.data?.message || "").slice(0, 160)}`;
        return JSON.stringify((r.data || []).map((p: any) => ({ number: p.number, title: p.title, state: p.state, head: p.head?.ref, base: p.base?.ref, draft: p.draft, url: p.html_url })));
      }
      case "gh_read_pr": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const n = Number(args.number); if (!n) return "error: missing PR number";
        const pr = await gh("GET", `/repos/${repo}/pulls/${n}`);
        if (!pr.ok) return `error: read PR ${n} → ${pr.status}: ${String(pr.data?.message || "").slice(0, 160)}`;
        const files = await gh("GET", `/repos/${repo}/pulls/${n}/files?per_page=50`);
        const fileList = (files.ok && Array.isArray(files.data))
          ? files.data.map((f: any) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: String(f.patch || "").slice(0, 2000) }))
          : [];
        return JSON.stringify({ number: pr.data.number, title: pr.data.title, body: String(pr.data.body || "").slice(0, 1000),
          state: pr.data.state, mergeable: pr.data.mergeable, mergeable_state: pr.data.mergeable_state,
          head: pr.data.head?.ref, base: pr.data.base?.ref, files: fileList });
      }
      case "gh_propose_change": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const changes = Array.isArray(args.changes) ? args.changes.filter((c: any) => c && c.path) : [];
        if (!changes.length) return "error: no changes provided (need at least one { path, content }).";
        const title = String(args.title || "").trim() || "Routiner agent change";
        let base = String(args.base || "").trim();
        if (!base) { const meta = await gh("GET", `/repos/${repo}`); base = meta.data?.default_branch || "main"; }
        const baseRef = await gh("GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
        if (!baseRef.ok) return `error: base branch '${base}' not found (${baseRef.status}).`;
        const baseSha = baseRef.data?.object?.sha;
        const branch = (String(args.branch || "").trim() || `agent/${Date.now().toString(36)}`).replace(/[^a-zA-Z0-9._/-]/g, "-");
        const mk = await gh("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
        if (!mk.ok && mk.status !== 422) return `error: create branch '${branch}' → ${mk.status}: ${String(mk.data?.message || "").slice(0, 160)}`;
        for (const c of changes) {
          const p = String(c.path || "").replace(/^\/+/, "");
          const cur = await gh("GET", `/repos/${repo}/contents/${ghPath(p)}?ref=${encodeURIComponent(branch)}`);
          const sha = (cur.ok && !Array.isArray(cur.data)) ? cur.data.sha : undefined;
          const put = await gh("PUT", `/repos/${repo}/contents/${ghPath(p)}`, {
            message: `${title} — ${p}`, branch, content: b64encode(String(c.content ?? "")), ...(sha ? { sha } : {}),
          });
          if (!put.ok) return `error: write ${p} → ${put.status}: ${String(put.data?.message || "").slice(0, 160)}`;
        }
        const pr = await gh("POST", `/repos/${repo}/pulls`, {
          title, head: branch, base, body: `${String(args.body || "")}\n\n— proposed by a Routiner OpenRouter agent`.trim(),
        });
        if (!pr.ok) return `error: open PR → ${pr.status}: ${String(pr.data?.message || "").slice(0, 200)}`;
        return `opened PR #${pr.data.number}: ${pr.data.html_url} (branch ${branch} → ${base}, ${changes.length} file(s))`;
      }
      case "gh_comment_pr": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const n = Number(args.number); if (!n) return "error: missing PR/issue number";
        const bodyText = String(args.body || "").trim(); if (!bodyText) return "error: empty comment";
        const r = await gh("POST", `/repos/${repo}/issues/${n}/comments`, { body: bodyText });
        return r.ok ? `commented on #${n}: ${r.data?.html_url || "ok"}` : `error: comment #${n} → ${r.status}: ${String(r.data?.message || "").slice(0, 160)}`;
      }
      case "gh_merge_pr": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        if (!GH_ALLOW_MERGE()) return "error: merging is disabled. Set the AGENT_ALLOW_MERGE edge secret to 'true' to allow it.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const n = Number(args.number); if (!n) return "error: missing PR number";
        const method = ["squash", "merge", "rebase"].includes(args.method) ? args.method : "squash";
        const r = await gh("PUT", `/repos/${repo}/pulls/${n}/merge`, { merge_method: method });
        if (!r.ok) return `error: merge #${n} → ${r.status}: ${String(r.data?.message || "").slice(0, 200)}`;
        return `merged PR #${n} (${method})${r.data?.sha ? ` — commit ${String(r.data.sha).slice(0, 7)}` : ""}.`;
      }

      default:
        return `error: unknown tool '${name}'`;
    }
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

// The system prompt that frames an instance. Shared by fresh runs and by the
// reconstruction path for legacy runs that predate stored transcripts.
function buildSystem(model: string, toolList: string): string {
  return `You are a Routiner agent instance running the model ${model}. You complete the user's task and return a clear, useful written result that is saved to the Routiner History for reuse, and which the user can reply to to keep the conversation going.
You have these tool capabilities: ${toolList}.
- Use read_* tools to ground your work in the owner's real data before acting.
- Use web_research for anything you need current facts on.
- Use write_note to save durable notes, and find_and_save_leads to source prospects into Command.
- Use the gh_* tools to work on code: gh_read_file / gh_list_prs / gh_read_pr to understand the repo, gh_propose_change to fix code by opening a pull request (always read the current file first and send the COMPLETE new contents, never a partial diff), gh_comment_pr to explain your reasoning, and gh_merge_pr to merge when it's ready. Make small, focused, correct changes; if you're unsure a change is safe, open the PR but do not merge — say why and let the user decide.
Take the actions the task calls for, then finish with a concise summary of what you found and did (include any PR links). If you need the user to clarify something or grant permission before acting, say so plainly and stop — they can reply and you'll pick up from there. Do not claim to have done something a tool did not confirm.`;
}

// Run the bounded tool-use loop over `messages` (mutated in place so the caller
// keeps the full transcript, final assistant turn included). Returns the final
// text, a recap of tool actions, accumulated cost, and step count.
async function runAgentLoop(opts: {
  key: string; model: string; tools: unknown[]; messages: any[]; maxSteps?: number;
  ctx: { userId: string | null; account: string | null; triggerKey: string | null; enabled: Set<string> };
}): Promise<{ finalText: string; actions: string[]; cost: number; steps: number }> {
  const { key, model, tools, messages, ctx } = opts;
  const stepBudget = Math.max(1, opts.maxSteps || MAX_STEPS);
  const actions: string[] = [];
  let cost = 0, steps = 0, finalText = "";
  const started = Date.now();
  for (let i = 0; i < stepBudget; i++) {
    steps = i + 1;
    const r = await openrouter(key, model, messages, { tools });
    cost += Number(r.usage?.cost) || 0;
    await logUsage(model, r.usage, ctx.account, ctx.triggerKey, r.ok, r.error ?? null);
    if (!r.ok) { finalText = `⚠ Model error on step ${steps}: ${r.error}`; break; }

    const msg = r.message || {};
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!toolCalls.length) {
      finalText = (msg.content || "").toString().trim();
      // Keep the final answer in the transcript so it displays and so a later
      // continuation has the model's own last turn as context.
      messages.push({ role: "assistant", content: msg.content || "" });
      break;
    }

    // Record the assistant turn (with its tool calls), then run each tool.
    messages.push({ role: "assistant", content: msg.content || "", tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const name = tc?.function?.name || "";
      let args: Record<string, any> = {};
      try { args = JSON.parse(tc?.function?.arguments || "{}"); } catch { /* leave empty */ }
      const result = (await runTool(name, args, {
        userId: ctx.userId, key, account: ctx.account, triggerKey: ctx.triggerKey, enabled: ctx.enabled,
      })).slice(0, TOOL_RESULT_CAP);
      actions.push(`${name}(${JSON.stringify(args).slice(0, 200)}) → ${result.split("\n")[0].slice(0, 120)}`);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
    if (Date.now() - started > DEADLINE_MS) { finalText = (finalText || "Stopped: hit the time budget before a final answer.").toString(); break; }
  }
  if (!finalText) finalText = "Stopped after the maximum number of tool steps without a final answer.";
  return { finalText, actions, cost, steps };
}

// ── Handler ─────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);

  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* empty ok */ }

  // Never leave tokens in anything we might echo later.
  const accessTokenForAuth = body.accessToken ?? body.access_token;
  delete body.accessToken;
  delete body.access_token;

  const auth = await authorizeCaller(req, { accessToken: accessTokenForAuth });
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);

  const allow = allowedModels();
  const runId = typeof body.runId === "string" ? body.runId.trim()
              : (typeof body.run_id === "string" ? body.run_id.trim() : "");

  // ── Continuation: reopen a stored run and keep the same conversation going ──
  // The follow-up carries only { runId, prompt }; model, account, trigger and
  // enabled tools all come from the stored run so it resumes with the same
  // context and capabilities. Persists back onto the same row.
  if (runId) {
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt.trim()) return json({ ok: false, error: "Missing 'prompt' (the follow-up message)." }, 400);

    let row: any = null;
    try {
      const rows = await sbGet(`routiner_runs?id=eq.${encodeURIComponent(runId)}&select=id,user_id,routine_id,title,status,output,messages,model,account,trigger_key,tools&limit=1`);
      row = rows?.[0] || null;
    } catch (e) { return json({ ok: false, error: `Could not load the run: ${(e as Error).message}` }, 502); }
    if (!row) return json({ ok: false, error: "Run not found." }, 404);

    // Signed-in callers may only continue their own runs (service/secret may continue any).
    if (auth.via === "user-jwt" && auth.userId && row.user_id && row.user_id !== auth.userId) {
      return json({ ok: false, error: "Unauthorized — that run belongs to another user." }, 403);
    }

    const userId = row.user_id || auth.userId || null;
    const account = typeof row.account === "string" ? row.account : null;
    const triggerKey = typeof row.trigger_key === "string" ? row.trigger_key : null;
    let model = typeof row.model === "string" && row.model.trim() ? row.model.trim() : DEFAULT_MODEL;
    if (!allow.has(model)) model = DEFAULT_MODEL;             // stored model was removed from the allowlist
    const enabled = new Set<string>(
      Array.isArray(row.tools) && row.tools.length ? row.tools.filter((t: unknown) => typeof t === "string") : ["read", "research", "write"],
    );
    const tools = toolSpecs(enabled);
    const toolList = enabled.size ? [...enabled].join(", ") : "none";

    const override = await accountKeyOverride(userId, account || undefined);
    const serverKey = Deno.env.get("OPENROUTER_API_KEY") || "";
    const key = override || serverKey;
    const keySource = override ? "account" : "server";
    if (!key) return json({ ok: false, error: "No OpenRouter key available to continue this run." }, 500);

    const capRaw = Deno.env.get("MAX_DAILY_SPEND");
    const cap = capRaw ? Number(capRaw) : 0;
    if (cap > 0) { const spent = await todaySpend(); if (spent != null && spent >= cap) return json({ ok: false, error: `Daily spend cap reached ($${spent.toFixed(4)} of $${cap.toFixed(2)}).` }, 429); }

    // Seed from the stored transcript; reconstruct a minimal one for legacy runs
    // that predate stored messages (single assistant turn = their saved output).
    let messages: any[] = Array.isArray(row.messages) && row.messages.length ? row.messages.slice() : [];
    if (!messages.length) {
      messages = [{ role: "system", content: buildSystem(model, toolList) }];
      if (row.output) messages.push({ role: "assistant", content: String(row.output) });
    } else if (messages[0]?.role !== "system") {
      messages.unshift({ role: "system", content: buildSystem(model, toolList) });
    }
    messages.push({ role: "user", content: prompt });

    const { finalText, actions, cost } = await runAgentLoop({
      key, model, tools, messages, maxSteps: stepBudgetFor(enabled),
      ctx: { userId, account, triggerKey, enabled },
    });
    const recap = actions.length ? `\n\n---\n**Actions (${actions.length})**\n\n${actions.map((a) => `- ${a}`).join("\n")}` : "";
    const output = `${finalText}${recap}`.slice(0, OUTPUT_CAP);
    const status = finalText.startsWith("⚠") ? "error" : "success";

    await fetch(rest(`routiner_runs?id=eq.${encodeURIComponent(runId)}`), {
      method: "PATCH", headers: { ...H(), Prefer: "return=minimal" },
      body: JSON.stringify({ status, output, messages, model, fired_at: new Date().toISOString() }),
    }).catch(() => {});

    return json({ ok: true, runId, output, cost: Number(cost.toFixed(6)), model, keySource });
  }

  // ── Fresh run ──
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : DEFAULT_MODEL;
  if (!allow.has(model)) return json({ ok: false, error: `Model "${model}" is not allowed. Allowed: ${[...allow].join(", ")}.` }, 400);

  const account = typeof body.account === "string" ? body.account : null;
  const triggerKey = typeof body.triggerKey === "string" ? body.triggerKey : (typeof body.trigger_key === "string" ? body.trigger_key : null);
  const routineId = typeof body.routineId === "string" ? body.routineId : (typeof body.routine_id === "string" ? body.routine_id : "");

  // Resolve owner: prefer authenticated user, else routineId / single-tenant fallback.
  const fromRoutine = await resolveOwner(routineId);
  const userId = auth.userId || fromRoutine.userId;
  const routineTitle = fromRoutine.title;
  const override = await accountKeyOverride(userId, account || undefined);
  const serverKey = Deno.env.get("OPENROUTER_API_KEY") || "";
  const key = override || serverKey;
  const keySource = override ? "account" : "server";
  if (!key) return json({ ok: false, error: "No OpenRouter key: set OPENROUTER_API_KEY (edge secret) or paste a key on the account." }, 500);

  // Ping: cheap reachability check for the Settings "Save & test run" button.
  if (body.ping) {
    const r = await openrouter(key, model, [{ role: "user", content: "ping" }], { maxTokens: 1 });
    await logUsage(model, r.usage, account, triggerKey, r.ok, r.error ?? null);
    return r.ok ? json({ ok: true, keySource, model }) : json({ ok: false, error: r.error }, 502);
  }

  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) return json({ ok: false, error: "Missing 'prompt'." }, 400);

  // Optional daily spend cap (fail-open if the ledger is unreadable).
  const capRaw = Deno.env.get("MAX_DAILY_SPEND");
  const cap = capRaw ? Number(capRaw) : 0;
  if (cap > 0) {
    const spent = await todaySpend();
    if (spent != null && spent >= cap) return json({ ok: false, error: `Daily spend cap reached ($${spent.toFixed(4)} of $${cap.toFixed(2)}).` }, 429);
  }

  // Solo-friendly: trust the caller's tool list once they're authenticated.
  // Models keep free rein to open PRs when `code` is included and GITHUB_TOKEN is set.
  const enabled = new Set<string>(
    Array.isArray(body.tools) ? body.tools.filter((t: unknown) => typeof t === "string") : ["read", "research", "write"],
  );
  const tools = toolSpecs(enabled);
  const toolList = enabled.size ? [...enabled].join(", ") : "none";

  const messages: any[] = [{ role: "system", content: buildSystem(model, toolList) }, { role: "user", content: prompt }];
  const { finalText, actions, cost, steps } = await runAgentLoop({
    key, model, tools, messages, maxSteps: stepBudgetFor(enabled),
    ctx: { userId, account, triggerKey, enabled },
  });

  // Compose the full-length output stored in History: the result, plus a short
  // recap of the actions taken (so the run is auditable).
  const recap = actions.length ? `\n\n---\n**Actions (${actions.length})**\n\n${actions.map((a) => `- ${a}`).join("\n")}` : "";
  const output = `${finalText}${recap}`.slice(0, OUTPUT_CAP);

  // Persist the run (full transcript included) — the single writer for both
  // Run-now and the scheduler, so a run lands in History the same way regardless
  // of trigger. return=representation so we can hand the new run id back for
  // an immediate follow-up.
  const status = finalText.startsWith("⚠") ? "error" : "success";
  const title = (typeof body.title === "string" && body.title.trim()) ? body.title.trim() : (routineTitle || `${model} run`);
  let newRunId: string | null = null;
  if (userId) {
    const ins = await fetch(rest("routiner_runs"), {
      method: "POST", headers: { ...H(), Prefer: "return=representation" },
      body: JSON.stringify({ user_id: userId, routine_id: routineId || null, title, status, output,
        messages, model, account, trigger_key: triggerKey, tools: [...enabled] }),
    }).catch(() => null);
    if (ins && ins.ok) { const rows = await ins.json().catch(() => []); newRunId = rows?.[0]?.id || null; }
  }

  return json({ ok: true, runId: newRunId, output, steps, cost: Number(cost.toFixed(6)), model, keySource });
});
