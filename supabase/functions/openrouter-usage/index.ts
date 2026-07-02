// openrouter-usage — read-only usage meter for Routiner's OpenRouter spend.
//
// One endpoint that both the CLI (scripts/usage-meter.mjs) and the web
// dashboard (usage.html) call. It combines two sources:
//
//   1. The LIVE credit balance from OpenRouter's own GET /api/v1/key
//      (total used, limit, remaining) — using the key held in edge secrets,
//      so the key never leaves Supabase. Same trust model as dynamic-responder.
//   2. OUR per-call ledger (routiner_openrouter_usage, written by
//      dynamic-responder) — which is where today / month / by-model / recent
//      breakdowns come from, since OpenRouter's /key only gives a running total.
//
// Auth: deployed with verify_jwt=false (like dynamic-responder), so the CLI and
// a static page can read it with no token. It exposes only aggregate spend, no
// secrets. Flip verify_jwt on if you want to gate it behind the publishable key.
//
// Request  (GET, optional ?limit=N for the recent list, default 20, max 100)
// Response (JSON):
//   { ok: true,
//     key:   { usage, limit, limit_remaining, is_free_tier, label } | null,
//     totals:{ today:{cost,tokens,calls}, month:{…} },  // from our ledger
//     // (lifetime spend on the key lives in key.usage, which predates the ledger)
//     by_model: [ { model, cost, tokens, calls } … ],
//     recent:   [ { created_at, model, total_tokens, cost, account, trigger_key } … ] }
//   or { ok: false, error: string }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key".replace(/[<>]/g, "");

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, apikey",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });

type Row = {
  created_at: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number;
  account: string | null;
  trigger_key: string | null;
  ok?: boolean;
  error?: string | null;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: cors });
  if (req.method !== "GET") return json({ ok: false, error: "Use GET." }, 405);

  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);

  // 1) Live credit balance from OpenRouter (optional — null if key absent/erroring).
  let keyInfo: Record<string, unknown> | null = null;
  const orKey = Deno.env.get("OPENROUTER_API_KEY");
  if (orKey) {
    try {
      const r = await fetch(OPENROUTER_KEY_URL, { headers: { authorization: `Bearer ${orKey}` } });
      if (r.ok) {
        const d = await r.json();
        const k = d?.data || {};
        keyInfo = {
          label: k.label ?? null,
          usage: Number(k.usage) || 0,
          limit: k.limit == null ? null : Number(k.limit),
          limit_remaining: k.limit_remaining == null ? null : Number(k.limit_remaining),
          is_free_tier: !!k.is_free_tier,
        };
      }
    } catch { /* leave keyInfo null */ }
  }

  // 2) Our ledger → aggregates. Pull a generous recent window for month math.
  const supaUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  let rows: Row[] = [];
  if (supaUrl && serviceKey) {
    try {
      const since = new Date();
      since.setUTCDate(1);
      since.setUTCHours(0, 0, 0, 0); // start of this UTC month
      const q = new URL(`${supaUrl}/rest/v1/routiner_openrouter_usage`);
      q.searchParams.set("select", "created_at,model,prompt_tokens,completion_tokens,total_tokens,cost,account,trigger_key,ok,error");
      q.searchParams.set("created_at", `gte.${since.toISOString()}`);
      q.searchParams.set("order", "created_at.desc");
      q.searchParams.set("limit", "5000");
      const r = await fetch(q.toString(), {
        headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
      });
      if (r.ok) rows = await r.json();
    } catch { /* leave rows empty */ }
  }

  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setUTCHours(0, 0, 0, 0);
  const dayBucket = { cost: 0, tokens: 0, calls: 0, errors: 0 };
  const monthBucket = { cost: 0, tokens: 0, calls: 0, errors: 0 };
  const byModel: Record<string, { model: string; cost: number; tokens: number; calls: number }> = {};

  for (const row of rows) {
    const failed = row.ok === false;
    const inDay = new Date(row.created_at) >= startOfDay;
    if (failed) {
      // Failed calls carry no cost/tokens — count them as errors only, so spend
      // and call totals stay clean while failure rates are still visible.
      monthBucket.errors += 1;
      if (inDay) dayBucket.errors += 1;
      continue;
    }
    const cost = Number(row.cost) || 0;
    const tokens = Number(row.total_tokens) || 0;
    monthBucket.cost += cost; monthBucket.tokens += tokens; monthBucket.calls += 1; // window = this month
    if (inDay) {
      dayBucket.cost += cost; dayBucket.tokens += tokens; dayBucket.calls += 1;
    }
    const m = (byModel[row.model] ||= { model: row.model || "(unknown)", cost: 0, tokens: 0, calls: 0 });
    m.cost += cost; m.tokens += tokens; m.calls += 1;
  }

  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  const tidy = (b: { cost: number; tokens: number; calls: number; errors: number }) =>
    ({ cost: round(b.cost), tokens: b.tokens, calls: b.calls, errors: b.errors });

  return json({
    ok: true,
    key: keyInfo,
    totals: { today: tidy(dayBucket), month: tidy(monthBucket) },
    by_model: Object.values(byModel).sort((a, b) => b.cost - a.cost).map((m) => ({ ...m, cost: round(m.cost) })),
    recent: rows.slice(0, limit).map((r) => ({
      created_at: r.created_at,
      model: r.model,
      total_tokens: Number(r.total_tokens) || 0,
      cost: round(Number(r.cost) || 0),
      account: r.account,
      trigger_key: r.trigger_key,
      ok: r.ok !== false,
      error: r.error ?? null,
    })),
  });
});
