// dynamic-responder — OpenRouter proxy for Routiner routine sessions.
// (Deployed slug is `dynamic-responder`; the dashboard display name may read
//  "routiner-openrouter". The invoke URL uses the slug.)
//
// Why this exists: a fired Claude Code routine session has NO OpenRouter key
// in its environment, and Supabase *edge secrets* are only readable by edge
// functions (not by REST or by the session). So this function holds the key
// inside Supabase and proxies the call: routines POST a prompt here, the key
// never leaves Supabase.
//
// Edge secrets (Supabase → Project Settings → Edge Functions → Secrets):
//   OPENROUTER_API_KEY – your sk-or-… key. (required)
//   RESPONDER_SECRET   – OPTIONAL shared secret. When set, callers MUST present
//                        it (Authorization: Bearer <secret>, or the header
//                        x-responder-secret: <secret>) or the call is rejected
//                        401. When unset the proxy stays open (dev/local), same
//                        as before. scripts/glm.mjs forwards $RESPONDER_SECRET
//                        automatically when present.
//   MAX_DAILY_SPEND    – OPTIONAL daily USD cap. When set (>0), the proxy sums
//                        today's cost from routiner_openrouter_usage and refuses
//                        once the cap is hit, bounding runaway-loop / abuse cost.
//   ALLOWED_MODELS     – OPTIONAL comma-separated model allowlist that REPLACES
//                        the built-in DEFAULT_ALLOWED set below. Use it to add or
//                        restrict models without editing code.
//
// Auth model: even with RESPONDER_SECRET set, the OpenRouter key stays fully
// server-side; spend is bounded by your OpenRouter credit, MAX_TOKENS_CAP, the
// model allowlist, and MAX_DAILY_SPEND. The function is deployed with
// verify_jwt=false so no Supabase auth header is needed; RESPONDER_SECRET is the
// gate. Flip verify_jwt on for an additional publishable-key layer if you want.
//
// Request  (POST JSON): { prompt: string, model?: string, max_tokens?: number,
//                         system?: string, temperature?: number,
//                         account?: string, trigger_key?: string }  // optional attribution
// Response (JSON):       { ok: true, content: string, model: string, usage?: {…} }
//                   or   { ok: false, error: string }
//
// Every successful call is logged (best-effort) to routiner_openrouter_usage
// with tokens + dollar cost, so the usage meter (openrouter-usage function +
// scripts/usage-meter.mjs + usage.html) can show spend over time.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// .replace strips stray angle brackets that some editors add when pasting URLs.
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions".replace(/[<>]/g, "");
// Coding-default model: matches CLAUDE.md so a routine that omits `model` gets
// the documented cheap coding default instead of silently falling back to kimi.
const DEFAULT_MODEL = "z-ai/glm-4.7";
const MAX_TOKENS_CAP = 8192; // guardrail against runaway cost

// The models this proxy is willing to bill against. A caller can request any of
// these; anything else is rejected 400 (instead of quietly running an expensive
// model). Mirrors the documented set in CLAUDE.md / js/model-router.js. Override
// with the ALLOWED_MODELS edge secret (comma-separated) to add/restrict models.
const DEFAULT_ALLOWED = [
  "z-ai/glm-4.7",
  "z-ai/glm-5",
  "moonshotai/kimi-k2.7-code",
  "deepseek/deepseek-chat",
  "meta-llama/llama-3.3-70b-instruct",
  "openrouter/auto",
];
const allowedModels = (): Set<string> => {
  const raw = Deno.env.get("ALLOWED_MODELS");
  const list = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_ALLOWED;
  return new Set(list);
};

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, apikey, x-responder-secret",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });

// Extract a caller-supplied secret from either the bearer token or the dedicated
// header (the header survives even if verify_jwt is later flipped on, which would
// consume Authorization at the gateway).
function callerSecret(req: Request): string {
  const h = req.headers.get("authorization") || "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  return bearer || (req.headers.get("x-responder-secret") || "").trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);

  // Optional shared-secret gate. Only enforced when RESPONDER_SECRET is set, so
  // an unconfigured (dev/local) proxy keeps working exactly as before.
  const gate = Deno.env.get("RESPONDER_SECRET");
  if (gate && callerSecret(req) !== gate) {
    return json({ ok: false, error: "Unauthorized — missing or invalid responder secret." }, 401);
  }

  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) return json({ ok: false, error: "OPENROUTER_API_KEY not set in edge secrets" }, 500);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) return json({ ok: false, error: "Missing 'prompt'." }, 400);

  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : DEFAULT_MODEL;
  const allow = allowedModels();
  if (!allow.has(model)) {
    return json({
      ok: false,
      error: `Model "${model}" is not allowed. Allowed: ${[...allow].join(", ")}.`,
    }, 400);
  }

  const maxTokens = Math.min(Number(body.max_tokens) || 2048, MAX_TOKENS_CAP);
  const account = typeof body.account === "string" ? body.account : null;     // optional attribution
  const triggerKey = typeof body.trigger_key === "string" ? body.trigger_key : null;

  // Optional daily spend cap. Best-effort: if the ledger is unreadable we fail
  // open (availability over a hard block), since the secret + allowlist +
  // OpenRouter's own credit limit still bound the damage.
  const capRaw = Deno.env.get("MAX_DAILY_SPEND");
  const cap = capRaw ? Number(capRaw) : 0;
  if (cap > 0) {
    const spent = await todaySpend();
    if (spent != null && spent >= cap) {
      return json({
        ok: false,
        error: `Daily spend cap reached ($${spent.toFixed(4)} of $${cap.toFixed(2)}). Resets at UTC midnight.`,
      }, 429);
    }
  }

  const messages: { role: string; content: string }[] = [];
  if (typeof body.system === "string" && body.system.trim()) messages.push({ role: "system", content: body.system });
  messages.push({ role: "user", content: prompt });

  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://routiner.zparx.app",
        "X-Title": "Routiner",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(body.temperature != null ? { temperature: Number(body.temperature) } : {}),
        // Ask OpenRouter to return token counts AND the dollar cost of this call,
        // so the usage meter can track spend without guessing per-model prices.
        usage: { include: true },
        messages,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      return json({ ok: false, error: data?.error?.message || `OpenRouter HTTP ${resp.status}` }, 502);
    }
    const content = (data?.choices?.[0]?.message?.content || "").trim();
    const servedModel = data?.model || model;
    const usage = data?.usage || null;

    // Best-effort: log this call to the usage ledger. Never let logging failure
    // break the actual response the routine is waiting on.
    logUsage(servedModel, usage, account, triggerKey).catch(() => {});

    return json({ ok: true, content: content || "(empty)", model: servedModel, usage });
  } catch (e) {
    return json({ ok: false, error: "Request to OpenRouter failed: " + (e as Error).message }, 502);
  }
});

// Sum today's spend (UTC day) from routiner_openrouter_usage via the service
// role. Returns the dollar total, or null when the ledger can't be read (so the
// caller can decide to fail open). PostgREST has no cheap SUM here, so we pull
// the day's `cost` column and add it up — bounded, since it's one day of calls.
async function todaySpend(): Promise<number | null> {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return null; // can't measure → caller fails open

  const since = new Date();
  since.setUTCHours(0, 0, 0, 0); // start of the current UTC day

  const q = new URL(`${url}/rest/v1/routiner_openrouter_usage`);
  q.searchParams.set("select", "cost");
  q.searchParams.set("created_at", `gte.${since.toISOString()}`);
  q.searchParams.set("limit", "100000");

  try {
    const r = await fetch(q.toString(), {
      headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
    });
    if (!r.ok) return null;
    const rows = await r.json() as Array<{ cost: number }>;
    return rows.reduce((sum, row) => sum + (Number(row.cost) || 0), 0);
  } catch {
    return null;
  }
}

// Insert one row into routiner_openrouter_usage via the Supabase REST API using
// the service-role key (both are auto-injected into the edge runtime). Fire and
// forget — callers don't await the result and errors are swallowed upstream.
async function logUsage(
  model: string,
  usage: Record<string, unknown> | null,
  account: string | null,
  triggerKey: string | null,
) {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return; // not configured to log; skip silently

  const row = {
    model,
    prompt_tokens: Number(usage?.prompt_tokens) || 0,
    completion_tokens: Number(usage?.completion_tokens) || 0,
    total_tokens: Number(usage?.total_tokens) || 0,
    cost: Number(usage?.cost) || 0,
    account,
    trigger_key: triggerKey,
    source: "dynamic-responder",
  };

  await fetch(`${url}/rest/v1/routiner_openrouter_usage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
}
