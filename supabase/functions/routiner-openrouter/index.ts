// routiner-openrouter — OpenRouter proxy for Routiner routine sessions.
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
// Auth: deployed with verify_jwt=true, so the Supabase gateway requires the
// project's publishable/anon key (already public in the app). That keeps the
// OpenRouter key fully server-side while letting any signed app/routine call it.
//
// Request  (POST JSON): { prompt: string, model?: string, max_tokens?: number,
//                         system?: string, temperature?: number }
// Response (JSON):       { ok: true, content: string, model: string }
//                   or   { ok: false, error: string }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "moonshotai/kimi-k2.7-code";
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
        messages,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      return json({ ok: false, error: data?.error?.message || `OpenRouter HTTP ${resp.status}` }, 502);
    }
    const content = (data?.choices?.[0]?.message?.content || "").trim();
    return json({ ok: true, content: content || "(empty)", model: data?.model || model });
  } catch (e) {
    return json({ ok: false, error: "Request to OpenRouter failed: " + (e as Error).message }, 502);
  }
});
