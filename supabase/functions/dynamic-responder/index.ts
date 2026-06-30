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
// Edge secret (Supabase → Project Settings → Edge Functions → Secrets):
//   OPENROUTER_API_KEY – your sk-or-… key.
//
// Auth: currently deployed with verify_jwt=false, so callers need no auth
// header. The OpenRouter key stays fully server-side regardless; spend is
// bounded by your OpenRouter credit and MAX_TOKENS_CAP. Flip verify_jwt on to
// require the project's publishable key if you want a tighter gate.
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

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, apikey",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);

  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) return json({ ok: false, error: "OPENROUTER_API_KEY not set in edge secrets" }, 500);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) return json({ ok: false, error: "Missing 'prompt'." }, 400);

  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : DEFAULT_MODEL;
  const maxTokens = Math.min(Number(body.max_tokens) || 2048, MAX_TOKENS_CAP);
  const account = typeof body.account === "string" ? body.account : null;     // optional attribution
  const triggerKey = typeof body.trigger_key === "string" ? body.trigger_key : null;
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
