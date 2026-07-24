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
  "deepseek/deepseek-chat", "moonshotai/kimi-k2.7-code", "moonshotai/kimi-k3",
  "meta-llama/llama-3.3-70b-instruct", "z-ai/glm-4.7", "z-ai/glm-5", "z-ai/glm-5.2",
];
const allowedModels = (): Set<string> => {
  const raw = Deno.env.get("AGENT_ALLOWED_MODELS");
  const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : AGENT_DEFAULT_ALLOWED;
  return new Set(list);
};

// Tunables (all optional env overrides).
const num = (name: string, def: number) => Number(Deno.env.get(name)) || def;
// Per-invocation step budget. Long jobs continue via auto-continue chains
// (see MAX_AUTO_CONTINUES) so one fire can span several edge invocations.
const MAX_STEPS = num("AGENT_MAX_STEPS", 5);
const CODE_MAX_STEPS = num("AGENT_CODE_MAX_STEPS", 12);
const stepBudgetFor = (enabled: Set<string>) => enabled.has("code") ? Math.max(MAX_STEPS, CODE_MAX_STEPS) : MAX_STEPS;
const MAX_TOKENS = Math.min(num("AGENT_MAX_TOKENS", 3072), 8192);
// Per-call cap. Reasoning models need headroom; still leave room for tools + save.
const CALL_TIMEOUT_MS = num("AGENT_CALL_TIMEOUT_MS", 50_000);
// Never start a model call with less than this — a 5s timeout always fails on
// Kimi/GLM and was being treated as a hard error (killing auto-continue).
const MIN_MODEL_CALL_MS = Math.min(num("AGENT_MIN_MODEL_CALL_MS", 25_000), CALL_TIMEOUT_MS);
// Wall budget for ONE edge invocation. Must stay under Supabase's ~150s idle
// limit so we can return JSON and/or spawn the next auto-continue segment.
const DEADLINE_MS = num("AGENT_DEADLINE_MS", 100_000);
// Smaller tool payloads → less context bloat → more steps fit before timeout.
// Non-file tools stay modest; gh_read_file uses GH_READ_RESULT_CAP (was 3500 for
// everything, which made the model report "file too large" on any real source file).
const TOOL_RESULT_CAP = num("AGENT_TOOL_RESULT_CAP", 8_000);
// File reads need room for real source (js/app.js alone is ~136k). Still capped so
// a single blob can't explode the context window.
const GH_READ_RESULT_CAP = Math.min(num("AGENT_GH_READ_RESULT_CAP", 120_000), 400_000);
const OUTPUT_CAP = num("AGENT_OUTPUT_CAP", 60_000);
// How many background segments after the first (total segments = 1 + this).
// 5 × ~100s ≈ set-and-forget multi-minute jobs without blowing one request.
const MAX_AUTO_CONTINUES = Math.min(num("AGENT_MAX_AUTO_CONTINUES", 5), 12);
// Consecutive auto-continue segments with zero progress (no tools, no real text)
// before we stop the chain instead of burning the full continue budget on timeouts.
const MAX_NO_PROGRESS = Math.min(num("AGENT_MAX_NO_PROGRESS", 2), 10);
// Reasoning-model control: GLM burns max_tokens thinking unless effort is capped.
// low/medium/high → { effort, exclude:true }; off/none → { enabled:false }; unset → omit.
const AGENT_REASONING_EFFORT = (Deno.env.get("AGENT_REASONING_EFFORT") || "low").trim();
// In-call retries for a transient OpenRouter failure ("Provider returned error",
// 5xx, timeouts). Without these ONE flaky response ended the whole run — the
// single biggest source of "the agent never finishes" in the run log.
const MODEL_RETRIES = Math.min(num("AGENT_MODEL_RETRIES", 2), 5);
// When the chosen model keeps failing transiently, finish the segment on a model
// known to be reliable rather than dying. Set to "" to disable falling back.
const FALLBACK_MODEL = (Deno.env.get("AGENT_FALLBACK_MODEL") ?? "moonshotai/kimi-k2.7-code").trim();
// Total characters of tool output kept at FULL size in the model's context. A
// single gh_read_file can now return 120k chars, so "keep the last 6 in full"
// could push ~700k chars (~180k tokens) into one request — which times out or
// 400s. This budget is what actually protects the context window.
const CONTEXT_TOOL_BUDGET = num("AGENT_CONTEXT_TOOL_BUDGET", 60_000);
const AUTO_CONTINUE_PROMPT =
  "[auto-continue] Resume the task from the transcript. Do NOT re-read files or re-list directories you already saw. Prefer finishing work (gh_propose_edit / write tools) over exploring — if you have read enough to make the change, make it now. When done, reply with a short final summary including any PR links — use no further tools if the work is complete.";

// ── GitHub (the "code" tool group) ───────────────────────────────────────────
// Lets a non-Claude instance read the repo, inspect PRs, and — the whole point —
// propose a fix as a PR and merge it, entirely through the GitHub REST API (no
// shell/sandbox needed). Guard-railed: it only works when GITHUB_TOKEN is set,
// only touches allowed repos, and won't merge unless AGENT_ALLOW_MERGE is on.
const GH_API = "https://api.github.com";
const GH_TOKEN = () => Deno.env.get("GITHUB_TOKEN") || Deno.env.get("GH_TOKEN") || "";
const GH_DEFAULT_REPO = () => (Deno.env.get("GITHUB_REPO") || "").trim();
const GH_ALLOW_MERGE = () => /^(1|true|yes|on)$/i.test(Deno.env.get("AGENT_ALLOW_MERGE") || "");
// Caps on agent writes (gh_propose_change) — keep PRs reviewable and limit blast radius.
const GH_MAX_FILES = Math.min(num("AGENT_GH_MAX_FILES", 10), 30);
const GH_MAX_FILE_CHARS = Math.min(num("AGENT_GH_MAX_FILE_CHARS", 400_000), 1_000_000);
// Default window when the model pages a large file with start_line/max_lines.
const GH_READ_DEFAULT_LINES = Math.min(num("AGENT_GH_READ_DEFAULT_LINES", 400), 2_000);
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
// Block high-risk write paths (CI secrets exfil, env keys, credential dumps). Reads stay open.
function deniedWritePath(rawPath: string): string | null {
  const path = String(rawPath || "").replace(/^\/+/, "").replace(/\\/g, "/");
  if (!path || path.split("/").some((seg) => seg === ".." || seg === "")) {
    return "invalid path (empty segment or '..' not allowed)";
  }
  const lower = path.toLowerCase();
  if (lower === ".github" || lower.startsWith(".github/")) {
    return "writes under .github/ are blocked (workflows can exfiltrate secrets)";
  }
  if (/(^|\/)\.env($|\.|\/)/.test(lower) || lower.endsWith(".env")) {
    return ".env files are blocked";
  }
  if (/\.(pem|key|p12|pfx|jks)$/i.test(path)) return "key/cert files are blocked";
  if (/(^|\/)(id_rsa|id_ed25519|id_ecdsa|credentials\.json|service[-_]?account)/i.test(path)) {
    return "credential-like files are blocked";
  }
  return null;
}
// Agent branches must live under agent/ so merges can't target arbitrary long-lived branches.
function normalizeAgentBranch(raw: string): string {
  let b = String(raw || "").trim().replace(/[^a-zA-Z0-9._/-]/g, "-");
  if (!b || b.includes("..")) b = `agent/${Date.now().toString(36)}`;
  if (!b.startsWith("agent/")) b = `agent/${b}`;
  // Collapse accidental agent/agent/…
  b = b.replace(/^(agent\/)+/, "agent/");
  return b.slice(0, 200);
}
const ghPath = (p: string) => String(p).replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
// UTF-8-safe base64 both directions (GitHub contents API is base64).
const b64encode = (s: string) => btoa(unescape(encodeURIComponent(s)));
const b64decode = (s: string) => decodeURIComponent(escape(atob(String(s).replace(/\n/g, ""))));
async function gh(method: string, path: string, body?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<{ ok: boolean; status: number; data: any }> {
  const token = GH_TOKEN();
  const tMs = Math.max(3_000, Math.min(timeoutMs, CALL_TIMEOUT_MS));
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
      signal: AbortSignal.timeout(tMs),
    });
    const text = await r.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    const msg = e instanceof DOMException && e.name === "TimeoutError" ? `GitHub call timed out (${tMs}ms)` : (e as Error).message;
    return { ok: false, status: 0, data: { message: msg } };
  }
}

// A 404 on a read is usually wrong casing, not a missing file ("todo.md" when
// the repo has "TODO.md"). Models were burning 3-4 of their ~12 steps guessing.
// Look the name up in its parent directory and either correct it or hand back
// the real listing, so one wrong guess costs one step instead of several.
async function resolveCasePath(
  repo: string,
  path: string,
  ref: string | undefined,
  tMs: number,
): Promise<{ path?: string; candidates?: string[] }> {
  const lastSlash = path.lastIndexOf("/");
  const parent = lastSlash === -1 ? "" : path.slice(0, lastSlash);
  const basename = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  const encodedParent = parent ? parent.split("/").map(encodeURIComponent).join("/") : "";
  const url = `/repos/${repo}/contents/${encodedParent}${ref ? `?ref=${encodeURIComponent(String(ref))}` : ""}`;
  try {
    const res = await gh("GET", url, undefined, tMs);
    if (!res.ok || !Array.isArray(res.data)) return {};
    const target = basename.toLowerCase();
    const matches = res.data.filter((e: any) => String(e?.name || "").toLowerCase() === target);
    if (matches.length === 1) return { path: String(matches[0].path) };
    if (matches.length > 1) return { candidates: matches.map((e: any) => String(e.path)) };
    return { candidates: res.data.slice(0, 20).map((e: any) => String(e.path)) };
  } catch {
    return {};
  }
}

// Apply literal find/replace edits to a file's text. Returns an error string
// instead of throwing so the model gets an actionable message back as a tool
// result (and can fix its own edit) rather than the run dying.
function applyEdits(
  text: string,
  edits: Array<{ old_string?: unknown; new_string?: unknown; replace_all?: unknown }>,
  path: string,
): { content?: string; error?: string } {
  let out = text;
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i] || {};
    const oldStr = String(e.old_string ?? "");
    const newStr = String(e.new_string ?? "");
    if (!oldStr) return { error: `edit ${i + 1} for '${path}' has an empty old_string.` };
    if (oldStr === newStr) return { error: `edit ${i + 1} for '${path}' is a no-op (old_string === new_string).` };
    const parts = out.split(oldStr);
    const hits = parts.length - 1;
    if (hits === 0) {
      return {
        error: `edit ${i + 1} for '${path}': old_string not found. It must match the file EXACTLY, including indentation and line breaks. Re-read the file and copy the text verbatim.`,
      };
    }
    if (hits > 1 && e.replace_all !== true) {
      return {
        error: `edit ${i + 1} for '${path}': old_string matches ${hits} times. Include more surrounding lines to make it unique, or pass replace_all: true.`,
      };
    }
    // Join the split parts rather than String.replace: replace() would treat
    // "$&", "$1" etc. in new_string as substitution patterns and silently
    // mangle any code containing a dollar sign (template literals, jQuery, …).
    out = e.replace_all === true ? parts.join(newStr) : parts[0] + newStr + parts[1];
  }
  return { content: out };
}

// Branch → write files → open PR. Shared by gh_propose_change (model supplies
// whole files) and gh_propose_edit (server derives whole files from find/replace
// edits), so both get the same path/branch/base guard rails.
async function openPrWithFiles(
  repo: string,
  args: Record<string, any>,
  files: Array<{ path: string; content: string }>,
  tMs: number,
): Promise<string> {
  if (files.length > GH_MAX_FILES) {
    return `error: too many files (${files.length}); max is ${GH_MAX_FILES} per PR. Split the work.`;
  }
  for (const f of files) {
    const deny = deniedWritePath(f.path);
    if (deny) return `error: blocked path '${f.path}': ${deny}`;
    if (f.content.length > GH_MAX_FILE_CHARS) {
      return `error: '${f.path}' is too large to write (${f.content.length} chars); max is ${GH_MAX_FILE_CHARS}. Split the change or raise AGENT_GH_MAX_FILE_CHARS (hard max 1e6).`;
    }
  }
  const title = String(args.title || "").trim() || "Routiner agent change";
  // Resolve default branch; only allow PRs targeting that branch (not release/* etc.).
  const meta = await gh("GET", `/repos/${repo}`, undefined, tMs);
  const defaultBranch = (meta.ok && meta.data?.default_branch) ? String(meta.data.default_branch) : "main";
  let base = String(args.base || "").trim() || defaultBranch;
  if (base.toLowerCase() !== defaultBranch.toLowerCase()) {
    return `error: base branch must be the repo default ('${defaultBranch}'); got '${base}'.`;
  }
  base = defaultBranch; // use canonical casing from GitHub
  const baseRef = await gh("GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`, undefined, tMs);
  if (!baseRef.ok) return `error: base branch '${base}' not found (${baseRef.status}).`;
  const baseSha = baseRef.data?.object?.sha;
  // Always under agent/; never silently write onto a pre-existing branch (422).
  const branch = normalizeAgentBranch(String(args.branch || "").trim() || `agent/${Date.now().toString(36)}`);
  const mk = await gh("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha }, tMs);
  if (!mk.ok) {
    if (mk.status === 422) {
      return `error: branch '${branch}' already exists — pick a new name (or omit branch for an auto name). Refusing to overwrite.`;
    }
    return `error: create branch '${branch}' → ${mk.status}: ${String(mk.data?.message || "").slice(0, 160)}`;
  }
  for (const f of files) {
    const cur = await gh("GET", `/repos/${repo}/contents/${ghPath(f.path)}?ref=${encodeURIComponent(branch)}`, undefined, tMs);
    const sha = (cur.ok && !Array.isArray(cur.data)) ? cur.data.sha : undefined;
    const put = await gh("PUT", `/repos/${repo}/contents/${ghPath(f.path)}`, {
      message: `${title} — ${f.path}`, branch, content: b64encode(f.content), ...(sha ? { sha } : {}),
    }, tMs);
    if (!put.ok) return `error: write ${f.path} → ${put.status}: ${String(put.data?.message || "").slice(0, 160)}`;
  }
  const pr = await gh("POST", `/repos/${repo}/pulls`, {
    title, head: branch, base, body: `${String(args.body || "")}\n\n— proposed by a Routiner OpenRouter agent`.trim(),
  }, tMs);
  if (!pr.ok) return `error: open PR → ${pr.status}: ${String(pr.data?.message || "").slice(0, 200)}`;
  return `opened PR #${pr.data.number}: ${pr.data.html_url} (branch ${branch} → ${base}, ${files.length} file(s))`;
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
  if (name === "read_routines" || name === "read_notes" || name === "read_leads" || name === "read_runs") return "read";
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
// Build OpenRouter's `reasoning` body field from an effort string (or omit).
// OpenRouter drops unsupported params on non-reasoning models, so this is safe
// for Kimi/DeepSeek/Llama. Returns null → omit the field entirely.
function parseReasoningEffort(v: string): Record<string, unknown> | null {
  const s = String(v || "").toLowerCase().trim();
  if (!s || s === "unset" || s === "default") return null;
  if (s === "off" || s === "none") return { enabled: false };
  // exclude:false so reasoning text is returned for the History "Thoughts" panel.
  // Effort still caps hidden-token spend; low is the default.
  if (s === "low" || s === "medium" || s === "high") return { effort: s, exclude: false };
  return { effort: "low", exclude: false };
}

// Pull human-readable thoughts from an OpenRouter assistant message.
function extractReasoning(msg: any): string {
  if (!msg || typeof msg !== "object") return "";
  if (typeof msg.reasoning === "string" && msg.reasoning.trim()) return msg.reasoning.trim();
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) return msg.reasoning_content.trim();
  if (Array.isArray(msg.reasoning_details)) {
    return msg.reasoning_details
      .map((d: any) => (typeof d?.text === "string" ? d.text : (typeof d?.summary === "string" ? d.summary : "")))
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  return "";
}

// Build the assistant transcript entry, preserving reasoning for the UI + tool loops.
function assistantTurn(msg: any, toolCalls?: any[]): Record<string, unknown> {
  const content = (msg?.content ?? "").toString();
  const turn: Record<string, unknown> = { role: "assistant", content };
  if (toolCalls && toolCalls.length) turn.tool_calls = toolCalls;
  const reasoning = extractReasoning(msg);
  if (reasoning) turn.reasoning = reasoning;
  if (Array.isArray(msg?.reasoning_details) && msg.reasoning_details.length) {
    turn.reasoning_details = msg.reasoning_details;
  }
  return turn;
}
// Resolve per-call reasoning: explicit opts.reasoning wins (string | object | null).
// null = omit; undefined = use AGENT_REASONING_EFFORT env (default low).
function resolveReasoning(
  override?: string | Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (override === null) return null;
  if (override !== undefined) {
    if (typeof override === "object") return override;
    return parseReasoningEffort(String(override));
  }
  return parseReasoningEffort(AGENT_REASONING_EFFORT);
}

type OrOpts = {
  tools?: unknown[];
  maxTokens?: number;
  timeoutMs?: number;
  /** string effort, full object, or null to omit (default: AGENT_REASONING_EFFORT) */
  reasoning?: string | Record<string, unknown> | null;
  /** transient-failure retries (default 0 — callers in the loop opt in) */
  retries?: number;
  /** absolute epoch-ms wall deadline; no retry is started that can't fit */
  deadlineAt?: number;
};
type OrResult = { ok: boolean; message?: any; usage?: any; error?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retrying wrapper. OpenRouter routes to third-party providers, so a single call
// failing ("Provider returned error", 502/503, a slow cold start) says nothing
// about whether the next one will — retry before giving up on the whole run.
// Permanent failures (bad key, spend limit, unknown model) fail fast, unretried.
async function openrouter(
  key: string,
  model: string,
  messages: unknown[],
  opts: OrOpts = {},
): Promise<OrResult> {
  const retries = Math.max(0, opts.retries ?? 0);
  const deadlineAt = opts.deadlineAt ?? Number.POSITIVE_INFINITY;
  let last: OrResult = { ok: false, error: "no attempt was made" };

  for (let attempt = 0; attempt <= retries; attempt++) {
    const perAttempt = Math.max(3_000, Math.min(opts.timeoutMs ?? CALL_TIMEOUT_MS, CALL_TIMEOUT_MS));
    // Only start an attempt that can actually finish inside the wall budget.
    if (attempt > 0 && Date.now() + perAttempt > deadlineAt) break;

    const r = await openrouterOnce(key, model, messages, { ...opts, timeoutMs: perAttempt });
    if (r.ok) return r;
    last = r;
    // A permanent error repeats identically — don't burn budget or spend on it.
    if (!isTransientModelError(r.error || "")) return r;
    if (attempt < retries) {
      const backoff = Math.min(4_000, 750 * 2 ** attempt);
      if (Date.now() + backoff + 3_000 > deadlineAt) break;
      await sleep(backoff);
    }
  }
  return last;
}

async function openrouterOnce(
  key: string,
  model: string,
  messages: unknown[],
  opts: OrOpts = {},
): Promise<OrResult> {
  const tMs = Math.max(3_000, Math.min(opts.timeoutMs ?? CALL_TIMEOUT_MS, CALL_TIMEOUT_MS));
  const reasoning = resolveReasoning(opts.reasoning);
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
        ...(reasoning ? { reasoning } : {}),
        ...(opts.tools && opts.tools.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
        messages,
      }),
      signal: AbortSignal.timeout(tMs),
    });
    const data = await resp.json();
    if (!resp.ok) return { ok: false, error: data?.error?.message || `OpenRouter HTTP ${resp.status}` };
    return { ok: true, message: data?.choices?.[0]?.message || {}, usage: data?.usage || null };
  } catch (e) {
    const msg = e instanceof DOMException && e.name === "TimeoutError" ? `OpenRouter call timed out (${tMs}ms)` : (e as Error).message;
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
      { type: "function", function: { name: "read_runs", description: "Read the agent run log (Routiner History): status, model, and the final output/error of past runs — including your own. Use this to diagnose why runs are failing before proposing a fix.",
        parameters: { type: "object", properties: {
          limit: { type: "number", description: "max rows (default 20, max 100)" },
          status: { type: "string", enum: ["success", "error", "running", "cancelled", "missed"], description: "filter to one status, e.g. 'error'" },
          since_hours: { type: "number", description: "only runs fired within the last N hours" },
        } } } },
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
      { type: "function", function: { name: "gh_read_file", description: "Read a file (or list a directory) from the repo. Returns the text and its blob sha. For large files, pass start_line + max_lines to page through (do not claim the file is unreadable — page it).",
        parameters: { type: "object", required: ["path"], properties: { ...repoProp,
          path: { type: "string", description: "path within the repo, e.g. js/app.js (a directory path returns a listing)" },
          ref: { type: "string", description: "branch, tag, or commit sha (default: the repo's default branch)" },
          start_line: { type: "number", description: "1-based line to start at (optional; use with max_lines for large files)" },
          max_lines: { type: "number", description: `how many lines to return (default ${GH_READ_DEFAULT_LINES} when start_line is set; omit both to try the whole file up to the size cap)` } } } } },
      { type: "function", function: { name: "gh_list_prs", description: "List pull requests in the repo (number, title, state, branches).",
        parameters: { type: "object", properties: { ...repoProp, state: { type: "string", enum: ["open", "closed", "all"], description: "default open" } } } } },
      { type: "function", function: { name: "gh_read_pr", description: "Read one pull request: its metadata, mergeability, and per-file diffs (patches).",
        parameters: { type: "object", required: ["number"], properties: { ...repoProp, number: { type: "number", description: "the PR number" } } } } },
      { type: "function", function: { name: "gh_read_issue", description: "Read one GitHub issue: its title, body, labels, state and recent comments. Use this whenever the task references an issue number or an issues/ URL.",
        parameters: { type: "object", required: ["number"], properties: { ...repoProp, number: { type: "number", description: "the issue number" } } } } },
      { type: "function", function: { name: "gh_list_issues", description: "List issues in the repo (number, title, state). Pull requests are flagged with is_pull_request.",
        parameters: { type: "object", properties: { ...repoProp, state: { type: "string", enum: ["open", "closed", "all"], description: "default open" } } } } },
      { type: "function", function: { name: "gh_propose_edit", description: "PREFERRED way to fix code. Change part of one or more files with exact find/replace edits and open a pull request — you do NOT need the whole file, so this works on large files. The server reads the current file, applies your edits, and commits the result.",
        parameters: { type: "object", required: ["title", "edits"], properties: { ...repoProp,
          title: { type: "string", description: "PR title / commit message" },
          body: { type: "string", description: "PR description (markdown)" },
          base: { type: "string", description: "base branch to target (default: the repo's default branch)" },
          branch: { type: "string", description: "new branch name (default: an auto-generated agent/… name)" },
          edits: { type: "array", description: "find/replace edits, applied in order", items: { type: "object", required: ["path", "old_string", "new_string"],
            properties: {
              path: { type: "string", description: "file to edit" },
              old_string: { type: "string", description: "text to find — must match the file EXACTLY (indentation included) and be unique unless replace_all is true" },
              new_string: { type: "string", description: "replacement text" },
              replace_all: { type: "boolean", description: "replace every occurrence (default false)" },
            } } } } } } },
      { type: "function", function: { name: "gh_propose_change", description: "Replace whole file(s) and open a pull request. Requires the COMPLETE new content of each file — for changing part of an existing file prefer gh_propose_edit, which does not.",
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
  ctx: { userId: string | null; key: string; account: string | null; triggerKey: string | null; enabled: Set<string>; timeoutMs?: number; runId?: string | null },
): Promise<string> {
  const group = toolGroupOf(name);
  if (!group || !ctx.enabled.has(group)) {
    return `error: tool '${name}' is not enabled for this run.`;
  }
  // Defense in depth: never hit GitHub without a token even if code is enabled.
  if (group === "code" && !GH_TOKEN()) {
    return "error: no GITHUB_TOKEN configured on the deployment.";
  }
  const tMs = ctx.timeoutMs ?? CALL_TIMEOUT_MS;
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
      case "read_runs": {
        // The agent's own telemetry. Without this an agent asked to "find out why
        // runs fail" can only guess — it cannot see History at all.
        const lim = Math.min(Number(args.limit) || 20, 100);
        const st = typeof args.status === "string" && args.status.trim()
          ? `status=eq.${encodeURIComponent(args.status.trim())}&` : "";
        let since = "";
        const hrs = Number(args.since_hours);
        if (hrs > 0) {
          since = `fired_at=gte.${encodeURIComponent(new Date(Date.now() - hrs * 3_600_000).toISOString())}&`;
        }
        // Exclude the caller's own row. A diagnosis run checkpoints its actions
        // to `output` as it goes, so without this it reads itself: its own recap
        // comes back as the newest "error", crowding out the real failures. The
        // first self-repair run reported exactly that — "the returned run list
        // was truncated by the currently running self-repair run recursively
        // echoing its own actions".
        const notSelf = ctx.runId ? `id=neq.${encodeURIComponent(ctx.runId)}&` : "";
        const rows = await sbGet(
          `routiner_runs?${owner}${notSelf}${st}${since}select=id,title,status,model,fired_at,output&order=fired_at.desc&limit=${lim}`,
        );
        // Trim each output — a full transcript tail would blow the tool cap and
        // crowd out the rest of the diagnosis.
        const trimmed = (rows || []).map((r: any) => ({
          ...r,
          output: String(r.output || "").slice(0, 1200),
        }));
        return JSON.stringify(trimmed);
      }
      case "read_leads": {
        const lim = Math.min(Number(args.limit) || 25, 200);
        const rows = await sbGet(`staged_leads?select=business_name,website_domain,phone_e164,vertical,status,created_at&order=created_at.desc&limit=${lim}`);
        return JSON.stringify(rows);
      }
      case "web_research": {
        const query = String(args.query || "").trim();
        if (!query) return "error: empty query";
        // Research is slow; starting one with a few seconds left just guarantees
        // a timeout and wastes the step. Defer it to the next segment instead.
        if (tMs < 12_000) {
          return "error: not enough time left in this segment to research. Do it first thing next segment, or finish with what you already have.";
        }
        const r = await openrouter(ctx.key, RESEARCH_MODEL,
          [{ role: "system", content: "You are a precise research assistant. Answer with well-sourced, specific findings." }, { role: "user", content: query }],
          { maxTokens: 2000, timeoutMs: tMs });
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
        // Cap enrichment wait so a single tool can't blow the whole agent budget.
        const enrichMs = Math.min(90_000, Math.max(10_000, tMs));
        const res = await fetch(`${SB_URL}/functions/v1/lead-enrichment`, {
          method: "POST", headers: { ...H() },
          body: JSON.stringify({
            niche, location: args.location ?? null, count: Math.min(Number(args.count) || 10, 25),
            dmTitles: Array.isArray(args.dmTitles) ? args.dmTitles : [], toCommand: true, syncAbstrax: false, report: false,
          }),
          signal: AbortSignal.timeout(enrichMs),
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
        // An omitted/"."/"/" path means "show me the repo root" — that's what the
        // model wants, and erroring here just cost it a step.
        let path = String(args.path ?? "").trim().replace(/^\.\/+/, "");
        if (path === "." || path === "/") path = "";
        const refQ = args.ref ? `?ref=${encodeURIComponent(String(args.ref))}` : "";
        let r = await gh("GET", `/repos/${repo}/contents/${ghPath(path)}${refQ}`, undefined, tMs);
        // 404 is usually a casing miss. Resolve it against the parent listing
        // instead of making the model guess again.
        if (!r.ok && r.status === 404 && path) {
          const fix = await resolveCasePath(repo!, path, args.ref ? String(args.ref) : undefined, tMs);
          if (fix.path && fix.path !== path) {
            const retry = await gh("GET", `/repos/${repo}/contents/${ghPath(fix.path)}${refQ}`, undefined, tMs);
            if (retry.ok) { path = fix.path; r = retry; }
          } else if (fix.candidates?.length) {
            return `error: '${path}' not found. That directory contains:\n${fix.candidates.join("\n")}\n\nUse one of these exact paths (they are case-sensitive).`;
          }
        }
        if (!r.ok) return `error: read ${path || "/"} → ${r.status}: ${String(r.data?.message || "").slice(0, 160)}`;
        if (Array.isArray(r.data)) {
          return `directory ${path || "/"}:\n` + r.data.map((e: any) => `${e.type === "dir" ? "dir " : "file"}  ${e.path}`).join("\n");
        }
        // Contents API omits body for files > ~1MB — fall back to the Git Blobs API.
        let text = "";
        const blobSha = r.data?.sha ? String(r.data.sha) : "";
        if (r.data?.encoding === "base64" && r.data?.content) {
          try { text = b64decode(r.data.content); } catch {
            return `error: ${path} could not be decoded as UTF-8 text.`;
          }
        } else if (blobSha) {
          const blob = await gh("GET", `/repos/${repo}/git/blobs/${blobSha}`, undefined, tMs);
          if (!blob.ok) return `error: read blob ${path} → ${blob.status}: ${String(blob.data?.message || "").slice(0, 160)}`;
          if (blob.data?.encoding === "base64" && blob.data?.content) {
            try { text = b64decode(blob.data.content); } catch {
              return `error: ${path} could not be decoded as UTF-8 text.`;
            }
          } else {
            return `error: ${path} is not a readable text file (size ${r.data?.size ?? "?"}).`;
          }
        } else {
          return `error: ${path} is not a readable text file.`;
        }
        const lines = text.split("\n");
        const totalLines = lines.length;
        const totalChars = text.length;
        const hasStart = args.start_line != null && Number(args.start_line) > 0;
        const hasMax = args.max_lines != null && Number(args.max_lines) > 0;
        // Auto-page when the whole file would exceed the read cap and the model
        // didn't already request a window — never return a silent partial file.
        let start = hasStart ? Math.max(1, Math.floor(Number(args.start_line))) : 1;
        let maxLines = hasMax
          ? Math.max(1, Math.min(Math.floor(Number(args.max_lines)), 5_000))
          : (hasStart ? GH_READ_DEFAULT_LINES : totalLines);
        if (!hasStart && !hasMax && totalChars > GH_READ_RESULT_CAP) {
          maxLines = GH_READ_DEFAULT_LINES;
          start = 1;
        }
        const end = Math.min(totalLines, start + maxLines - 1);
        const slice = lines.slice(start - 1, end).join("\n");
        const header = [
          `path: ${r.data.path || path}`,
          `sha: ${blobSha}`,
          `lines: ${start}-${end} of ${totalLines}`,
          `chars: ${slice.length} of ${totalChars}`,
        ].join("\n");
        let body = `${header}\n\n${slice}`;
        if (end < totalLines) {
          body += `\n\n…[more content after line ${end}. Re-call gh_read_file with start_line=${end + 1} and max_lines=${GH_READ_DEFAULT_LINES} (or a larger max_lines). For a full rewrite you need the complete file — page until lines cover 1-${totalLines}, or target a smaller change.]`;
        }
        return body;
      }
      case "gh_list_prs": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const state = ["open", "closed", "all"].includes(args.state) ? args.state : "open";
        const r = await gh("GET", `/repos/${repo}/pulls?state=${state}&per_page=20`, undefined, tMs);
        if (!r.ok) return `error: list PRs → ${r.status}: ${String(r.data?.message || "").slice(0, 160)}`;
        return JSON.stringify((r.data || []).map((p: any) => ({ number: p.number, title: p.title, state: p.state, head: p.head?.ref, base: p.base?.ref, draft: p.draft, url: p.html_url })));
      }
      case "gh_read_pr": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const n = Number(args.number); if (!n) return "error: missing PR number";
        const pr = await gh("GET", `/repos/${repo}/pulls/${n}`, undefined, tMs);
        if (!pr.ok) return `error: read PR ${n} → ${pr.status}: ${String(pr.data?.message || "").slice(0, 160)}`;
        const files = await gh("GET", `/repos/${repo}/pulls/${n}/files?per_page=50`, undefined, tMs);
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
        if (!changes.length) {
          return "error: no changes provided (need at least one { path, content }). If you only want to alter part of a file, use gh_propose_edit instead — it does not need the whole file.";
        }
        const files = changes.map((c: any) => ({
          path: String(c.path || "").replace(/^\/+/, "").replace(/\\/g, "/"),
          content: String(c.content ?? ""),
        }));
        return await openPrWithFiles(repo!, args, files, tMs);
      }
      case "gh_propose_edit": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const rawEdits = Array.isArray(args.edits) ? args.edits.filter((e: any) => e && e.path) : [];
        if (!rawEdits.length) return "error: no edits provided (need at least one { path, old_string, new_string }).";
        // Group by file so several edits to one file are applied in sequence.
        const byPath = new Map<string, any[]>();
        for (const e of rawEdits) {
          const p = String(e.path || "").replace(/^\/+/, "").replace(/\\/g, "/");
          if (!byPath.has(p)) byPath.set(p, []);
          byPath.get(p)!.push(e);
        }
        if (byPath.size > GH_MAX_FILES) {
          return `error: too many files (${byPath.size}); max is ${GH_MAX_FILES} per PR. Split the work.`;
        }
        const files: Array<{ path: string; content: string }> = [];
        for (const [p, edits] of byPath) {
          const deny = deniedWritePath(p);
          if (deny) return `error: blocked path '${p}': ${deny}`;
          // Read the CURRENT file from the base branch — the agent never has to
          // reproduce it, which is what made whole-file rewrites fail on big files.
          const cur = await gh("GET", `/repos/${repo}/contents/${ghPath(p)}`, undefined, tMs);
          if (!cur.ok) return `error: read ${p} → ${cur.status}: ${String(cur.data?.message || "").slice(0, 160)}`;
          if (Array.isArray(cur.data)) return `error: '${p}' is a directory, not a file.`;
          let text = "";
          if (cur.data?.encoding === "base64" && cur.data?.content) {
            try { text = b64decode(cur.data.content); } catch { return `error: ${p} is not UTF-8 text.`; }
          } else {
            const blob = cur.data?.sha ? await gh("GET", `/repos/${repo}/git/blobs/${cur.data.sha}`, undefined, tMs) : null;
            if (!blob?.ok || blob.data?.encoding !== "base64") return `error: ${p} is not a readable text file.`;
            try { text = b64decode(blob.data.content); } catch { return `error: ${p} is not UTF-8 text.`; }
          }
          const applied = applyEdits(text, edits, p);
          if (applied.error) return `error: ${applied.error}`;
          files.push({ path: p, content: applied.content! });
        }
        return await openPrWithFiles(repo!, args, files, tMs);
      }
      case "gh_read_issue": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const n = Number(args.number); if (!n) return "error: missing issue number";
        const r = await gh("GET", `/repos/${repo}/issues/${n}`, undefined, tMs);
        if (!r.ok) return `error: read issue #${n} → ${r.status}: ${String(r.data?.message || "").slice(0, 160)}`;
        const cm = await gh("GET", `/repos/${repo}/issues/${n}/comments?per_page=20`, undefined, tMs);
        const comments = (cm.ok && Array.isArray(cm.data))
          ? cm.data.map((c: any) => ({ user: c.user?.login, body: String(c.body || "").slice(0, 2000) }))
          : [];
        return JSON.stringify({
          number: r.data.number, title: r.data.title, state: r.data.state,
          is_pull_request: !!r.data.pull_request,
          labels: (r.data.labels || []).map((l: any) => (typeof l === "string" ? l : l?.name)).filter(Boolean),
          body: String(r.data.body || "").slice(0, 8000),
          url: r.data.html_url, comments,
        });
      }
      case "gh_list_issues": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const state = ["open", "closed", "all"].includes(args.state) ? args.state : "open";
        const r = await gh("GET", `/repos/${repo}/issues?state=${state}&per_page=30`, undefined, tMs);
        if (!r.ok) return `error: list issues → ${r.status}: ${String(r.data?.message || "").slice(0, 160)}`;
        // The issues endpoint also returns PRs; mark them so the model can tell.
        return JSON.stringify((r.data || []).map((i: any) => ({
          number: i.number, title: i.title, state: i.state,
          is_pull_request: !!i.pull_request, url: i.html_url,
        })));
      }
      case "gh_comment_pr": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const n = Number(args.number); if (!n) return "error: missing PR/issue number";
        const bodyText = String(args.body || "").trim(); if (!bodyText) return "error: empty comment";
        const r = await gh("POST", `/repos/${repo}/issues/${n}/comments`, { body: bodyText }, tMs);
        return r.ok ? `commented on #${n}: ${r.data?.html_url || "ok"}` : `error: comment #${n} → ${r.status}: ${String(r.data?.message || "").slice(0, 160)}`;
      }
      case "gh_merge_pr": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        if (!GH_ALLOW_MERGE()) return "error: merging is disabled. Set the AGENT_ALLOW_MERGE edge secret to 'true' to allow it.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const n = Number(args.number); if (!n) return "error: missing PR number";
        // Only merge agent-created branches — never an arbitrary open PR in the repo.
        const prMeta = await gh("GET", `/repos/${repo}/pulls/${n}`, undefined, tMs);
        if (!prMeta.ok) return `error: read PR #${n} → ${prMeta.status}: ${String(prMeta.data?.message || "").slice(0, 160)}`;
        const headRef = String(prMeta.data?.head?.ref || "");
        if (!headRef.startsWith("agent/")) {
          return `error: can only merge PRs whose head branch starts with 'agent/' (PR #${n} head is '${headRef || "?"}'). Open a new agent PR or merge manually.`;
        }
        if (prMeta.data?.state && prMeta.data.state !== "open") {
          return `error: PR #${n} is not open (state: ${prMeta.data.state}).`;
        }
        const method = ["squash", "merge", "rebase"].includes(args.method) ? args.method : "squash";
        const r = await gh("PUT", `/repos/${repo}/pulls/${n}/merge`, { merge_method: method }, tMs);
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
  return `You are a Routiner agent instance running the model ${model}. You complete the user's task fully — like a coding agent that keeps going until the job is done. Results are saved to Routiner History; the user can also reply later.
You have these tool capabilities: ${toolList}.

Efficiency rules (critical — you have limited steps per segment):
- Prefer acting over exploring. A 404 on a read is corrected for you automatically when it's only a casing difference, and otherwise comes back with the real directory listing — read that listing instead of guessing again.
- Do not re-read a file you already have in the transcript. Call gh_read_file with path "." only when you truly don't know the layout.
- Large files: gh_read_file supports start_line + max_lines. If a read says "more content after line N", page with start_line=N+1 — do NOT say the file is too large or unreadable.
- To change part of a file, use gh_propose_edit with exact find/replace edits. You do NOT need to have read the whole file, and you must never reproduce a large file just to change a few lines. Copy old_string verbatim from what you read, including indentation, and include enough surrounding lines to make it unique.
- Use gh_propose_change (whole-file) only for a new file or a total rewrite.
- If the task mentions an issue number or an issues/ URL, call gh_read_issue to get its contents — do not ask the user to paste it.
- For code fixes: read the target region → gh_propose_edit → stop tools and summarize with the PR URL.
- One focused change set per task. Do not start a second unrelated fix in the same run.
- Use read_* / web_research only when needed for the task. Skip them for pure code edits when the user already named the file/repo.
- gh_merge_pr only if merge is enabled and the head is agent/*; when unsure, open the PR and stop.
- When the work is done (PR opened, note saved, research answered), write a concise final summary and call NO more tools.

Do not claim to have done something a tool did not confirm.`;
}

// Shrink old tool payloads so long runs don't blow the context window / latency.
// Budget-based, not count-based: newest tool results are kept in full until
// `budget` characters are spent, then everything older is cut to a small floor.
// (Counting messages instead of characters is what let three large file reads
// put ~360k chars into a single request.) Never mutates the input.
const TOOL_FLOOR_CHARS = 400;
function compactMessages(messages: any[], budget: number = CONTEXT_TOOL_BUDGET): any[] {
  const cap = Number.isFinite(budget) && budget > 0 ? budget : 0;
  const out = messages.slice();
  let spent = 0;
  // Newest → oldest, so the model always keeps the results it's reasoning about.
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m?.role !== "tool") continue;
    const c = String(m.content ?? "");
    if (c.length <= TOOL_FLOOR_CHARS) { spent += c.length; continue; }
    if (spent + c.length <= cap) { spent += c.length; continue; }
    out[i] = { ...m, content: c.slice(0, TOOL_FLOOR_CHARS) + "\n…[truncated for context]" };
    spent += TOOL_FLOOR_CHARS;
  }
  return out;
}

// Did THIS tool call actually open a pull request?
//
// This must key off the tool that ran, not off text appearing somewhere in a
// result. Testing `/opened PR #/` against every result meant an agent that
// merely READ a file containing that phrase — including this very function,
// whose success message is `opened PR #${n}` — was treated as having opened
// one: tools were disabled and the run reported a PR that never existed.
// Only a PR-opening tool counts, only from its own success line, and the URL
// is taken from the tool's output so the claim is always grounded.
const PR_OPENING_TOOLS = new Set(["gh_propose_change", "gh_propose_edit"]);
function detectOpenedPr(toolName: string, result: string): { opened: boolean; url: string } {
  if (!PR_OPENING_TOOLS.has(toolName)) return { opened: false, url: "" };
  const m = /^opened PR #\d+:\s*(\S+)/i.exec(String(result || "").trim());
  return m ? { opened: true, url: m[1] } : { opened: false, url: "" };
}

function isBudgetStop(text: string): boolean {
  return /time budget|maximum number of tool steps|mid-tools|Paused on step|will continue|Continuing in the background/i.test(text || "");
}

function isHardError(text: string): boolean {
  if (!/^⚠\s*Model error/i.test(text || "")) return false;
  // Timeouts / rate limits are recoverable — auto-continue should still fire.
  if (/timed out|timeout|rate.?limit|overloaded|temporar/i.test(text)) return false;
  return true;
}

// Worth another attempt. Deliberately broad: OpenRouter surfaces upstream
// provider flakiness through several unrelated strings, and treating any of them
// as fatal ends a run that would have succeeded on the next call. Anything NOT
// matched here is treated as permanent and fails fast — keep real
// configuration errors (bad key, spend cap, unknown model) out of this list.
function isTransientModelError(err: string): boolean {
  const e = err || "";
  // Never retry these, even though some contain retryable-looking words.
  if (/key limit exceeded|insufficient credit|quota exceeded|daily spend cap|not allowed|invalid api key|unauthorized|no auth credentials/i.test(e)) {
    return false;
  }
  return /timed out|timeout|rate.?limit|overloaded|temporar|capacity|try again|provider returned error|no endpoints|no allowed providers|internal server error|service unavailable|bad gateway|gateway time|fetch failed|connection|socket|stream|econnreset|429|500|502|503|504|520|522|524|529/i
    .test(e);
}


// Persist transcript mid-run so History shows progress and auto-continue can resume.
// Never overwrites a user-cancelled run (status=cancelled) with running/success/error.
// Returns { cancelled } so a caller can detect a Stop for free (no separate read):
// a non-cancel patch that updates 0 rows means the row is no longer "running" —
// the status=neq.cancelled filter excluded it (Stop) or the row was deleted.
// `&select=id` keeps the returned payload tiny (never the big messages/output).
async function checkpointRun(
  runId: string | null,
  patch: Record<string, unknown>,
): Promise<{ cancelled: boolean }> {
  if (!runId) return { cancelled: false };
  const id = encodeURIComponent(runId);
  const isCancelPatch = patch.status === "cancelled";
  // Cancelling always wins; other patches only apply while not cancelled.
  const filter = isCancelPatch
    ? `routiner_runs?id=eq.${id}&select=id`
    : `routiner_runs?id=eq.${id}&status=neq.cancelled&select=id`;
  try {
    const res = await fetch(rest(filter), {
      method: "PATCH", headers: { ...H(), Prefer: "return=representation" },
      body: JSON.stringify({ ...patch, fired_at: new Date().toISOString() }),
    });
    if (isCancelPatch) return { cancelled: true };
    // Fail open on any transport/HTTP error — don't stop a live run on a blip;
    // the explicit isRunCancelled checks still catch a real cancel.
    if (!res.ok) return { cancelled: false };
    const rows = await res.json().catch(() => null);
    if (!Array.isArray(rows)) return { cancelled: false };
    return { cancelled: rows.length === 0 };
  } catch {
    return { cancelled: false };
  }
}

async function getRunStatus(runId: string | null): Promise<string | null> {
  if (!runId) return null;
  try {
    const rows = await sbGet(
      `routiner_runs?id=eq.${encodeURIComponent(runId)}&select=status&limit=1`,
    );
    return rows?.[0]?.status ? String(rows[0].status) : null;
  } catch {
    return null;
  }
}

async function isRunCancelled(runId: string | null): Promise<boolean> {
  const s = await getRunStatus(runId);
  return s === "cancelled";
}

// Spawn another openrouter-agent invocation on the same run (service role).
// Uses EdgeRuntime.waitUntil when available so work continues after we respond.
// `noProgress` is the consecutive no-progress streak (carried in the POST body
// like continueDepth — no DB state needed).
function scheduleAutoContinue(runId: string, depth: number, noProgress = 0): boolean {
  if (!SB_URL || !SB_KEY || !runId) return false;
  if (depth >= MAX_AUTO_CONTINUES) return false;
  const url = `${SB_URL}/functions/v1/openrouter-agent`;
  const work = fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: SB_KEY,
      authorization: `Bearer ${SB_KEY}`,
    },
    body: JSON.stringify({
      runId,
      prompt: AUTO_CONTINUE_PROMPT,
      autoContinue: true,
      continueDepth: depth + 1,
      noProgress,
    }),
  }).then(async (r) => {
    const t = await r.text().catch(() => "");
    if (!r.ok) console.error("auto-continue failed", r.status, t.slice(0, 200));
  }).catch((e) => console.error("auto-continue error", e));

  const ER = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (ER && typeof ER.waitUntil === "function") {
    ER.waitUntil(work);
  }
  // If waitUntil is missing, still fire-and-forget (best effort on this platform).
  return true;
}

// A segment made progress if tools actually ran OR the model produced real text
// (not a budget-stop / "Paused on step…" / empty). GLM empty/timeout loops hit
// the no-progress path so we don't burn the full auto-continue chain.
function segmentMadeProgress(actions: string[], finalText: string): boolean {
  if (actions.length > 0) return true;
  const t = (finalText || "").trim();
  if (!t) return false;
  if (isBudgetStop(t)) return false;
  if (/^\(empty/i.test(t)) return false;
  return true;
}

function noProgressStopMessage(streak: number): string {
  return `Stopped: ${streak} consecutive segments made no progress (model timing out or returning nothing). Try a faster model (kimi-k2.7-code, deepseek-chat) or reply to retry.`;
}

// Ran out of auto-continue segments with the task still unfinished. Reported as
// an error, not a success, so History reflects what actually happened.
function exhaustedMessage(depth: number): string {
  return `⚠ Ran out of time: used all ${depth + 1} segment(s) of the auto-continue budget without finishing. Partial progress is saved — open this run and **Retry** (or reply "continue") to pick up where it stopped. If this keeps happening, narrow the task or raise AGENT_MAX_AUTO_CONTINUES.`;
}

type LoopResult = {
  finalText: string;
  actions: string[];
  cost: number;
  steps: number;
  incomplete: boolean; // true → worth auto-continuing
  openedPr: boolean;
  modelUsed: string;   // may differ from the requested model after a fallback
};

// Run the bounded tool-use loop over `messages` (mutated in place).
async function runAgentLoop(opts: {
  key: string; model: string; tools: unknown[]; messages: any[]; maxSteps?: number;
  runId?: string | null;
  ctx: { userId: string | null; account: string | null; triggerKey: string | null; enabled: Set<string> };
}): Promise<LoopResult> {
  const { key, model, tools, messages, ctx } = opts;
  const runId = opts.runId || null;
  const stepBudget = Math.max(1, opts.maxSteps || MAX_STEPS);
  const actions: string[] = [];
  let cost = 0, steps = 0, finalText = "";
  let openedPr = false;
  let prUrl = ""; // captured from the PR tool's own output — never asserted without it
  let incomplete = false;
  // The model actually used right now — may switch to FALLBACK_MODEL once if the
  // configured one is failing transiently. Reported back so History is honest.
  let activeModel = model;
  let fellBack = false;
  const started = Date.now();
  const hardStop = started + DEADLINE_MS;
  const remaining = () => Math.max(0, hardStop - Date.now());
  // Reserve 8s to checkpoint + spawn auto-continue; never go below MIN_MODEL_CALL_MS
  // (a 5s model call always fails on Kimi/GLM and used to kill the chain).
  const callBudget = () => {
    const raw = remaining() - 8_000;
    if (raw < MIN_MODEL_CALL_MS) return 0;
    return Math.min(CALL_TIMEOUT_MS, raw);
  };

  // Returns true if the checkpoint revealed the run was cancelled (Stop pressed),
  // so the loop can halt with no extra DB read.
  const saveProgress = async (status: string, note: string): Promise<boolean> => {
    const recap = actions.length ? `\n\n---\n**Actions (${actions.length})**\n\n${actions.map((a) => `- ${a}`).join("\n")}` : "";
    const { cancelled } = await checkpointRun(runId, {
      status,
      output: `${note}${recap}`.slice(0, OUTPUT_CAP),
      messages,
    });
    return cancelled;
  };

  for (let i = 0; i < stepBudget; i++) {
    steps = i + 1;
    const budget = callBudget();
    if (budget < MIN_MODEL_CALL_MS) {
      finalText = finalText || "Stopped: hit the time budget before a final answer.";
      incomplete = true;
      break;
    }

    const forModel = compactMessages(messages);
    // After a PR is opened, force a text-only wrap-up (no more tools).
    const useTools = openedPr ? [] : tools;
    const r = await openrouter(key, activeModel, forModel, {
      tools: useTools.length ? useTools : undefined,
      timeoutMs: budget,
      retries: MODEL_RETRIES,
      deadlineAt: hardStop,
    });
    cost += Number(r.usage?.cost) || 0;
    await logUsage(activeModel, r.usage, ctx.account, ctx.triggerKey, r.ok, r.error ?? null);
    if (!r.ok) {
      const err = String(r.error || "unknown");
      // Retries inside openrouter() are already spent by here. If the chosen
      // model is the thing that's broken, finish the job on a reliable one
      // instead of ending the run — the user cares about the task, not the model.
      const canFallBack = isTransientModelError(err) && !fellBack && FALLBACK_MODEL &&
        FALLBACK_MODEL !== activeModel && allowedModels().has(FALLBACK_MODEL) &&
        callBudget() >= MIN_MODEL_CALL_MS;
      if (canFallBack) {
        fellBack = true;
        actions.push(`model fallback: ${activeModel} → ${FALLBACK_MODEL} after "${err.slice(0, 120)}"`);
        activeModel = FALLBACK_MODEL;
        continue; // costs one step; far cheaper than losing the run
      }
      if (isTransientModelError(err)) {
        // Soft stop — checkpoint + auto-continue (do not mark as hard failure).
        finalText = `Paused on step ${steps}: ${err}. Continuing in the background if possible.`;
        incomplete = true;
      } else {
        finalText = `⚠ Model error on step ${steps}: ${err}`;
        incomplete = false;
      }
      break;
    }

    // Honour Stop: user (or UI) flipped the row to cancelled mid-loop.
    if (await isRunCancelled(runId)) {
      finalText = "⏹ Stopped by you. Partial progress is saved — Retry to resume.";
      incomplete = false;
      break;
    }

    const msg = r.message || {};
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!toolCalls.length || openedPr) {
      finalText = (msg.content || "").toString().trim() || (openedPr ? `Opened a pull request: ${prUrl}` : "");
      messages.push(assistantTurn({ ...msg, content: msg.content || finalText }));
      incomplete = false;
      break;
    }

    messages.push(assistantTurn(msg, toolCalls));
    for (const tc of toolCalls) {
      const toolBudget = callBudget();
      if (toolBudget < 5_000) {
        finalText = finalText || "Stopped: hit the time budget mid-tools; partial progress is in the transcript.";
        incomplete = true;
        break;
      }
      const name = tc?.function?.name || "";
      let args: Record<string, any> = {};
      try { args = JSON.parse(tc?.function?.arguments || "{}"); } catch { /* leave empty */ }
      const raw = await runTool(name, args, {
        userId: ctx.userId, key, account: ctx.account, triggerKey: ctx.triggerKey, enabled: ctx.enabled, runId,
        timeoutMs: toolBudget,
      });
      // File reads get a much higher cap; other tools stay small for context.
      const cap = name === "gh_read_file" ? GH_READ_RESULT_CAP : TOOL_RESULT_CAP;
      const result = raw.length > cap
        ? raw.slice(0, cap) + `\n\n…[truncated at ${cap} chars of ${raw.length}. For files, re-call gh_read_file with start_line/max_lines to page.]`
        : raw;
      const line = `${name}(${JSON.stringify(args).slice(0, 200)}) → ${result.split("\n")[0].slice(0, 120)}`;
      actions.push(line);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      const pr = detectOpenedPr(name, result);
      if (pr.opened) { openedPr = true; prUrl = pr.url; }
    }
    // Checkpoint after every tool batch so History stays live — and reuse its
    // result to honour a Stop pressed mid-batch, with no extra DB round-trip.
    const cancelledMidBatch = await saveProgress(
      "running",
      openedPr
        ? "Working… pull request opened; writing summary…"
        : `Working… step ${steps}/${stepBudget}`,
    );
    if (cancelledMidBatch) {
      finalText = "⏹ Stopped by you. Partial progress is saved — Retry to resume.";
      incomplete = false;
      break;
    }

    if (openedPr) {
      // Next loop iteration will call the model with tools disabled for a final summary.
      continue;
    }
    if (finalText || callBudget() < MIN_MODEL_CALL_MS) {
      if (!finalText) {
        finalText = "Stopped: hit the time budget before a final answer.";
        incomplete = true;
      }
      break;
    }
  }

  if (!finalText) {
    finalText = "Stopped after the maximum number of tool steps without a final answer.";
    incomplete = !openedPr;
  }
  // Budget / step stops are incomplete unless we already landed a PR and summary.
  if (isBudgetStop(finalText) && !openedPr) incomplete = true;
  if (openedPr && isBudgetStop(finalText)) {
    finalText = `Opened a pull request: ${prUrl} — the model ran out of budget before writing a summary.`;
    incomplete = false;
  }
  if (isHardError(finalText)) incomplete = false;
  // Final cancel check so we never auto-continue a stopped run.
  if (await isRunCancelled(runId)) {
    finalText = "⏹ Stopped by you. Partial progress is saved — Retry to resume.";
    incomplete = false;
  }

  return { finalText, actions, cost, steps, incomplete, openedPr, modelUsed: activeModel };
}

async function insertRunningRun(row: Record<string, unknown>): Promise<string | null> {
  const ins = await fetch(rest("routiner_runs"), {
    method: "POST", headers: { ...H(), Prefer: "return=representation" },
    body: JSON.stringify(row),
  }).catch(() => null);
  if (!ins || !ins.ok) return null;
  const rows = await ins.json().catch(() => []);
  return rows?.[0]?.id || null;
}

// ── Handler ─────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  try {
    return await handleRequest(req);
  } catch (e) {
    // Uncaught throws become empty gateway 502s; always return JSON for the scheduler.
    return json({ ok: false, error: `Agent crashed: ${(e as Error).message || String(e)}` }, 500);
  }
});

async function handleRequest(req: Request): Promise<Response> {
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

  const continueDepth = Math.max(0, Number(body.continueDepth) || 0);
  // Consecutive no-progress streak for auto-continue (human replies start at 0).
  const noProgressIn = Math.max(0, Number(body.noProgress) || 0);
  const isAutoContinue = body.autoContinue === true;

  // ── Continuation / stop: reopen a stored run ──
  // Human reply: { runId, prompt }. Auto-continue: { runId, prompt, autoContinue, continueDepth, noProgress }.
  // Stop: { runId, action: "stop" } — flips status to cancelled so the live loop + chain halt.
  if (runId) {
    const wantStop = body.action === "stop" || body.stop === true;
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!wantStop && !prompt.trim() && !isAutoContinue) {
      return json({ ok: false, error: "Missing 'prompt' (the follow-up message)." }, 400);
    }

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

    if (wantStop) {
      const stopMsg = "⏹ Stopped by you. Partial progress is saved — Retry to resume.";
      const prev = String(row.output || "");
      const output = (stopMsg + (prev && !prev.startsWith("⏹") ? "\n\n" + prev : "")).slice(0, OUTPUT_CAP);
      // Unconditional cancel (even if already error/success — idempotent enough).
      await fetch(rest(`routiner_runs?id=eq.${encodeURIComponent(runId)}`), {
        method: "PATCH", headers: { ...H(), Prefer: "return=minimal" },
        body: JSON.stringify({
          status: "cancelled",
          output,
          fired_at: new Date().toISOString(),
        }),
      }).catch(() => {});
      return json({ ok: true, runId, stopped: true, status: "cancelled", output });
    }

    // Already stopped — don't resurrect via auto-continue (human Retry still works with a prompt).
    if (isAutoContinue && row.status === "cancelled") {
      return json({
        ok: true, runId, stopped: true, status: "cancelled",
        output: row.output || "⏹ Stopped by you.",
        continuing: false,
      });
    }

    const userId = row.user_id || auth.userId || null;
    const account = typeof row.account === "string" ? row.account : null;
    const triggerKey = typeof row.trigger_key === "string" ? row.trigger_key : null;
    let model = typeof row.model === "string" && row.model.trim() ? row.model.trim() : DEFAULT_MODEL;
    if (!allow.has(model)) model = DEFAULT_MODEL;
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

    let messages: any[] = Array.isArray(row.messages) && row.messages.length ? row.messages.slice() : [];
    if (!messages.length) {
      messages = [{ role: "system", content: buildSystem(model, toolList) }];
      if (row.output) messages.push({ role: "assistant", content: String(row.output) });
    } else if (messages[0]?.role !== "system") {
      messages.unshift({ role: "system", content: buildSystem(model, toolList) });
    } else {
      // Refresh system prompt so efficiency rules apply to old transcripts.
      messages[0] = { role: "system", content: buildSystem(model, toolList) };
    }
    const userTurn = (prompt.trim() || AUTO_CONTINUE_PROMPT);
    messages.push({ role: "user", content: userTurn });

    await checkpointRun(runId, { status: "running", output: isAutoContinue ? `Continuing… (segment ${continueDepth + 1})` : "Working…" });

    const loop = await runAgentLoop({
      key, model, tools, messages, maxSteps: stepBudgetFor(enabled), runId,
      ctx: { userId, account, triggerKey, enabled },
    });
    let { finalText, actions, cost, steps, incomplete, openedPr, modelUsed } = loop;
    const recap = actions.length ? `\n\n---\n**Actions (${actions.length})**\n\n${actions.map((a) => `- ${a}`).join("\n")}` : "";

    // Progress streak: human follow-ups reset; auto-continue carries noProgressIn.
    const baseStreak = isAutoContinue ? noProgressIn : 0;
    const nextNoProgress = segmentMadeProgress(actions, finalText) ? 0 : baseStreak + 1;

    const wasCancelled = /Stopped by you/i.test(finalText) || (await isRunCancelled(runId));

    let continuing = false;
    let noProgressStop = false;
    if (!wasCancelled && incomplete && !isHardError(finalText)) {
      if (nextNoProgress >= MAX_NO_PROGRESS) {
        noProgressStop = true;
        finalText = noProgressStopMessage(nextNoProgress);
      } else {
        continuing = scheduleAutoContinue(runId, continueDepth, nextNoProgress);
      }
    }
    // Out of segments with the task unfinished. This used to be filed as
    // "success", so History showed green on runs that did nothing.
    const exhausted = !wasCancelled && incomplete && !continuing && !noProgressStop && !isHardError(finalText);
    if (exhausted) finalText = `${finalText}\n\n${exhaustedMessage(continueDepth)}`;

    const status = wasCancelled
      ? "cancelled"
      : (isHardError(finalText) || noProgressStop || exhausted) ? "error" : (continuing ? "running" : "success");
    const note = continuing
      ? `${finalText}\n\n_Still working in the background (auto-continue ${continueDepth + 1}/${MAX_AUTO_CONTINUES})…_`
      : finalText;
    const output = `${note}${recap}`.slice(0, OUTPUT_CAP);

    await checkpointRun(runId, { status, output, messages, model: modelUsed });

    return json({
      ok: true, runId, output, steps, cost: Number(cost.toFixed(6)), model: modelUsed, keySource,
      continuing, openedPr, continueDepth, noProgress: nextNoProgress,
      stopped: wasCancelled,
    });
  }

  // ── Fresh run ──
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : DEFAULT_MODEL;
  if (!allow.has(model)) return json({ ok: false, error: `Model "${model}" is not allowed. Allowed: ${[...allow].join(", ")}.` }, 400);

  const account = typeof body.account === "string" ? body.account : null;
  const triggerKey = typeof body.triggerKey === "string" ? body.triggerKey : (typeof body.trigger_key === "string" ? body.trigger_key : null);
  const routineId = typeof body.routineId === "string" ? body.routineId : (typeof body.routine_id === "string" ? body.routine_id : "");

  const fromRoutine = await resolveOwner(routineId);
  const userId = auth.userId || fromRoutine.userId;
  const routineTitle = fromRoutine.title;
  const override = await accountKeyOverride(userId, account || undefined);
  const serverKey = Deno.env.get("OPENROUTER_API_KEY") || "";
  const key = override || serverKey;
  const keySource = override ? "account" : "server";
  if (!key) return json({ ok: false, error: "No OpenRouter key: set OPENROUTER_API_KEY (edge secret) or paste a key on the account." }, 500);

  if (body.ping) {
    const r = await openrouter(key, model, [{ role: "user", content: "ping" }], { maxTokens: 1 });
    await logUsage(model, r.usage, account, triggerKey, r.ok, r.error ?? null);
    return r.ok ? json({ ok: true, keySource, model }) : json({ ok: false, error: r.error }, 502);
  }

  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) return json({ ok: false, error: "Missing 'prompt'." }, 400);

  const capRaw = Deno.env.get("MAX_DAILY_SPEND");
  const cap = capRaw ? Number(capRaw) : 0;
  if (cap > 0) {
    const spent = await todaySpend();
    if (spent != null && spent >= cap) return json({ ok: false, error: `Daily spend cap reached ($${spent.toFixed(4)} of $${cap.toFixed(2)}).` }, 429);
  }

  const enabled = new Set<string>(
    Array.isArray(body.tools) ? body.tools.filter((t: unknown) => typeof t === "string") : ["read", "research", "write"],
  );
  const tools = toolSpecs(enabled);
  const toolList = enabled.size ? [...enabled].join(", ") : "none";
  const title = (typeof body.title === "string" && body.title.trim()) ? body.title.trim() : (routineTitle || `${model} run`);

  const messages: any[] = [{ role: "system", content: buildSystem(model, toolList) }, { role: "user", content: prompt }];

  // Insert the run *before* the loop so History shows "running" and auto-continue can resume.
  let newRunId: string | null = null;
  if (userId) {
    newRunId = await insertRunningRun({
      user_id: userId,
      routine_id: routineId || null,
      title,
      status: "running",
      output: "Working…",
      messages,
      model,
      account,
      trigger_key: triggerKey,
      tools: [...enabled],
    });
  }

  const loop = await runAgentLoop({
    key, model, tools, messages, maxSteps: stepBudgetFor(enabled), runId: newRunId,
    ctx: { userId, account, triggerKey, enabled },
  });
  let { finalText, actions, cost, steps, incomplete, openedPr, modelUsed } = loop;

  const recap = actions.length ? `\n\n---\n**Actions (${actions.length})**\n\n${actions.map((a) => `- ${a}`).join("\n")}` : "";

  // Fresh run: streak starts at 0; no progress → 1 and may continue once more.
  const nextNoProgress = segmentMadeProgress(actions, finalText) ? 0 : 1;
  const wasCancelled = /Stopped by you/i.test(finalText) || (newRunId ? await isRunCancelled(newRunId) : false);

  let continuing = false;
  let noProgressStop = false;
  if (newRunId && !wasCancelled && incomplete && !isHardError(finalText)) {
    if (nextNoProgress >= MAX_NO_PROGRESS) {
      noProgressStop = true;
      finalText = noProgressStopMessage(nextNoProgress);
    } else {
      continuing = scheduleAutoContinue(newRunId, 0, nextNoProgress);
    }
  }
  const exhausted = !wasCancelled && incomplete && !continuing && !noProgressStop && !isHardError(finalText);
  if (exhausted) finalText = `${finalText}\n\n${exhaustedMessage(0)}`;

  const status = wasCancelled
    ? "cancelled"
    : (isHardError(finalText) || noProgressStop || exhausted) ? "error" : (continuing ? "running" : "success");
  const note = continuing
    ? `${finalText}\n\n_Still working in the background (auto-continue 1/${MAX_AUTO_CONTINUES})…_`
    : finalText;
  const output = `${note}${recap}`.slice(0, OUTPUT_CAP);

  if (newRunId) {
    await checkpointRun(newRunId, { status, output, messages, model: modelUsed });
  } else if (userId) {
    // Fallback: no early id (insert failed) — try one final insert.
    newRunId = await insertRunningRun({
      user_id: userId, routine_id: routineId || null, title, status, output,
      messages, model: modelUsed, account, trigger_key: triggerKey, tools: [...enabled],
    });
  }

  return json({
    ok: true, runId: newRunId, output, steps, cost: Number(cost.toFixed(6)), model: modelUsed, keySource,
    continuing, openedPr, continueDepth: 0, noProgress: nextNoProgress,
    stopped: wasCancelled,
  });
}
