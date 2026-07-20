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
//     Command's Review tab via the lead-enrichment engine).
// It is NOT a coding agent (no files/git/shell) — that needs a compute sandbox
// this app doesn't have.
//
// Key resolution (per call): the account's own OpenRouter key
// (routiner_settings.accounts[account].key) if the owner set one, else the
// server-side OPENROUTER_API_KEY edge secret. The key never reaches the browser.
//
// Auth: deployed with verify_jwt=false and gated by the publishable key at the
// gateway, exactly like routiner-admin / dynamic-responder / lead-enrichment.
// Owner user_id is resolved from routineId (else the single-owner fallback), the
// same model those functions use. An optional RESPONDER_SECRET gate is honored.
//
// Request (POST JSON):
//   { prompt, model?, tools?: ("read"|"research"|"write")[], account?, triggerKey?,
//     routineId?, title?, source?, ping? }
// Response:
//   { ok: true, output, steps, cost, model, keySource }   (ping: { ok, keySource, model })
//   { ok: false, error }

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
const MAX_TOKENS = Math.min(num("AGENT_MAX_TOKENS", 4096), 8192);
const CALL_TIMEOUT_MS = num("AGENT_CALL_TIMEOUT_MS", 90_000);
const DEADLINE_MS = num("AGENT_DEADLINE_MS", 130_000); // overall wall-clock budget
const TOOL_RESULT_CAP = num("AGENT_TOOL_RESULT_CAP", 6000);
const OUTPUT_CAP = num("AGENT_OUTPUT_CAP", 60_000);    // full-length, but sane

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, apikey, x-responder-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });

function callerSecret(req: Request): string {
  const h = req.headers.get("authorization") || "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  return bearer || (req.headers.get("x-responder-secret") || "").trim();
}

// ── Supabase REST helpers (service role) ─────────────────────────────────────
const rest = (path: string) => `${SB_URL}/rest/v1/${path}`;
const H = () => ({ apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json" });
async function sbGet(path: string): Promise<any[]> {
  const r = await fetch(rest(path), { headers: H() });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
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
      parameters: { type: "object", required: ["query"], properties: { query: { type: "string", description: "what to research" } } } });
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
  return specs;
}

// Execute a single tool call. Returns a string result (capped by the caller).
async function runTool(name: string, args: Record<string, any>, ctx: { userId: string | null; key: string; account: string | null; triggerKey: string | null }): Promise<string> {
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
      default:
        return `error: unknown tool '${name}'`;
    }
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);

  const gate = Deno.env.get("RESPONDER_SECRET");
  if (gate && callerSecret(req) !== gate) return json({ ok: false, error: "Unauthorized." }, 401);

  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* empty ok */ }

  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : DEFAULT_MODEL;
  const allow = allowedModels();
  if (!allow.has(model)) return json({ ok: false, error: `Model "${model}" is not allowed. Allowed: ${[...allow].join(", ")}.` }, 400);

  const account = typeof body.account === "string" ? body.account : null;
  const triggerKey = typeof body.triggerKey === "string" ? body.triggerKey : (typeof body.trigger_key === "string" ? body.trigger_key : null);
  const routineId = typeof body.routineId === "string" ? body.routineId : (typeof body.routine_id === "string" ? body.routine_id : "");

  // Resolve owner + the OpenRouter key (per-account override, else server secret).
  const { userId, title: routineTitle } = await resolveOwner(routineId);
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

  const enabled = new Set<string>(
    Array.isArray(body.tools) ? body.tools.filter((t: unknown) => typeof t === "string") : ["read", "research", "write"],
  );
  const tools = toolSpecs(enabled);
  const toolList = enabled.size ? [...enabled].join(", ") : "none";

  const system = `You are a Routiner agent instance running the model ${model}. You complete the user's task and return a clear, useful written result that will be saved to the Routiner Log for reuse.
You have these tool capabilities: ${toolList}.
- Use read_* tools to ground your work in the owner's real data before acting.
- Use web_research for anything you need current facts on.
- Use write_note to save durable notes, and find_and_save_leads to source prospects into Command.
Take the actions the task calls for, then finish with a concise summary of what you found and did. Do not claim to have done something a tool did not confirm.`;

  const messages: any[] = [{ role: "system", content: system }, { role: "user", content: prompt }];
  const actions: string[] = [];
  let cost = 0;
  let steps = 0;
  let finalText = "";
  const started = Date.now();

  for (let i = 0; i < MAX_STEPS; i++) {
    steps = i + 1;
    const r = await openrouter(key, model, messages, { tools });
    cost += Number(r.usage?.cost) || 0;
    await logUsage(model, r.usage, account, triggerKey, r.ok, r.error ?? null);
    if (!r.ok) { finalText = `⚠ Model error on step ${steps}: ${r.error}`; break; }

    const msg = r.message || {};
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!toolCalls.length) { finalText = (msg.content || "").toString().trim(); break; }

    // Record the assistant turn (with its tool calls), then run each tool.
    messages.push({ role: "assistant", content: msg.content || "", tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const name = tc?.function?.name || "";
      let args: Record<string, any> = {};
      try { args = JSON.parse(tc?.function?.arguments || "{}"); } catch { /* leave empty */ }
      const result = (await runTool(name, args, { userId, key, account, triggerKey })).slice(0, TOOL_RESULT_CAP);
      actions.push(`${name}(${JSON.stringify(args).slice(0, 200)}) → ${result.split("\n")[0].slice(0, 120)}`);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
    if (Date.now() - started > DEADLINE_MS) { finalText = (finalText || "Stopped: hit the time budget before a final answer.").toString(); break; }
  }
  if (!finalText) finalText = "Stopped after the maximum number of tool steps without a final answer.";

  // Compose the full-length output stored in the Log: the result, plus a short
  // recap of the actions taken (so the run is auditable).
  const recap = actions.length ? `\n\n---\n**Actions (${actions.length})**\n\n${actions.map((a) => `- ${a}`).join("\n")}` : "";
  const output = `${finalText}${recap}`.slice(0, OUTPUT_CAP);

  // Persist the run (full-length) — the single writer for both Run-now and the
  // scheduler, so output lands in the Log the same way regardless of trigger.
  const status = finalText.startsWith("⚠") ? "error" : "success";
  const title = (typeof body.title === "string" && body.title.trim()) ? body.title.trim() : (routineTitle || `${model} run`);
  if (userId) {
    await fetch(rest("routiner_runs"), {
      method: "POST", headers: { ...H(), Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: userId, routine_id: routineId || null, title, status, output }),
    }).catch(() => {});
  }

  return json({ ok: true, output, steps, cost: Number(cost.toFixed(6)), model, keySource });
});
