// ============================================================================
// lead-enrichment — autonomous Perplexity → Review-tab lead sourcing.
//
// The engine behind the ZPARX lead flywheel. On each invocation it:
//   1. Resolves target(s): a single targetId, an ad-hoc {niche,location,…}, or
//      ALL enabled rows in lead_enrichment_targets.
//   2. Runs Perplexity deep research per target via OpenRouter (the key stays
//      server-side, same as dynamic-responder — no key in any session/cron).
//   3. Parses + validates the result into the shared EnrichedLead shape,
//      de-dupes against existing staged_leads + companies, and inserts the new
//      ones as `pending` into staged_leads → they appear in Command's Review tab
//      with NO Claude in the hot path.
//   4. Optionally mirrors each lead into Abstrax `competitors` (RoiCal) as a
//      prospect — gated on the ROICAL_SERVICE_ROLE_KEY edge secret.
//   5. Logs OpenRouter spend to routiner_openrouter_usage and posts a run recap
//      to routiner-admin (lands in the app Log/History).
//
// Edge secrets (Supabase → Edge Functions → Secrets):
//   OPENROUTER_API_KEY        (required) sk-or-… — reused from dynamic-responder.
//   RESPONDER_SECRET          (optional) shared gate; when set callers must send
//                             it (Authorization: Bearer / x-responder-secret).
//   ROICAL_SERVICE_ROLE_KEY   (optional) RoiCal service role — enables Abstrax sync.
//   ROICAL_URL                (optional) RoiCal project URL; defaults to the ref below.
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  (auto-injected) — staged_leads writes.
//
// Request (POST JSON), all optional:
//   { targetId?, niche?, location?, count?, model?, dmTitles?, vertical?,
//     syncAbstrax?, dryRun?, report? }
// Response: { ok, runs: [{ target, requested, parsed, inserted, skipped,
//             mirrored, model, cost, error? }], totals: {...} }
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { EnrichedLead } from "../_shared/lead-schema.ts";
import { toStagedLead, toCompetitor } from "../_shared/lead-schema.ts";
import { buildResearchPrompt, parseLeads } from "../_shared/lead-parse.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const ROICAL_DEFAULT_URL = "https://pqnycfugadzwcuntfhjp.supabase.co";

// Only research/search models are billable here — bounds cost the same way
// dynamic-responder's allowlist does. Override with LEAD_ENRICHMENT_MODELS.
const DEFAULT_ALLOWED = [
  "perplexity/sonar",
  "perplexity/sonar-pro",
  "perplexity/sonar-reasoning",
  "perplexity/sonar-reasoning-pro",
  "perplexity/sonar-deep-research",
  "openrouter/auto",
];
const allowedModels = (): Set<string> => {
  const raw = Deno.env.get("LEAD_ENRICHMENT_MODELS");
  const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_ALLOWED;
  return new Set(list);
};

const COUNT_CAP = 25; // per target, per run — cost/scale guardrail
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, apikey, x-responder-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function callerSecret(req: Request): string {
  const h = req.headers.get("authorization") || "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  return bearer || (req.headers.get("x-responder-secret") || "").trim();
}

// ── Supabase REST helpers (service role, on the local zparx-dashboard project) ─
async function sbGet(path: string): Promise<any[]> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}
async function sbInsert(table: string, rows: unknown[], url = SB_URL, key = SB_KEY): Promise<void> {
  if (rows.length === 0) return;
  const r = await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}`, Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`INSERT ${table} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
async function sbPatch(table: string, filter: string, patch: unknown): Promise<void> {
  await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  }).catch(() => {});
}

interface Target {
  id: string | null;
  label: string;
  niche: string;
  location: string | null;
  target_vertical: string | null;
  count: number;
  dm_titles: string[];
  model: string;
  sync_abstrax: boolean;
  to_command: boolean; // write to Command's staged_leads (Review tab). Default true.
}

// ── research one target via Perplexity/OpenRouter ─────────────────────────────
async function research(t: Target, key: string): Promise<{ text: string; usage: any; model: string; error?: string }> {
  const count = Math.max(1, Math.min(t.count || 10, COUNT_CAP));
  const { system, user } = buildResearchPrompt({
    niche: t.niche, location: t.location, count, dmTitles: t.dm_titles ?? [],
  });
  const maxTokens = Math.min(4000, 500 + count * 130);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 110_000);
  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://routiner.zparx.app",
        "X-Title": "Routiner Lead Enrichment",
      },
      body: JSON.stringify({
        model: t.model,
        max_tokens: maxTokens,
        temperature: 0.1,
        usage: { include: true },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
      signal: ctrl.signal,
    });
    const data = await resp.json();
    if (!resp.ok) return { text: "", usage: null, model: t.model, error: data?.error?.message || `OpenRouter ${resp.status}` };
    return {
      text: (data?.choices?.[0]?.message?.content || "").trim(),
      usage: data?.usage || null,
      model: data?.model || t.model,
    };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "research timed out (110s)" : (e as Error).message;
    return { text: "", usage: null, model: t.model, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function logUsage(model: string, usage: any, ok: boolean, error: string | null) {
  if (!SB_URL || !SB_KEY) return;
  const row = {
    model,
    prompt_tokens: Number(usage?.prompt_tokens) || 0,
    completion_tokens: Number(usage?.completion_tokens) || 0,
    total_tokens: Number(usage?.total_tokens) || 0,
    cost: Number(usage?.cost) || 0,
    account: "zparxmarketing",
    trigger_key: "lead-enrichment",
    source: "lead-enrichment",
    ok,
    error: error ? String(error).slice(0, 500) : null,
  };
  await fetch(`${SB_URL}/rest/v1/routiner_openrouter_usage`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, Prefer: "return=minimal" },
    body: JSON.stringify(row),
  }).catch(() => {});
}

// De-dupe keys already in the CRM: staged pending/imported leads + companies.
async function existingKeys(): Promise<{ domains: Set<string>; phones: Set<string>; names: Set<string> }> {
  const domains = new Set<string>(), phones = new Set<string>(), names = new Set<string>();
  const add = (rows: any[], d: string, p: string, n: string) => {
    for (const r of rows) {
      if (r[d]) domains.add(String(r[d]).toLowerCase());
      if (r[p]) phones.add(String(r[p]).replace(/[^\d]/g, ""));
      if (r[n]) names.add(String(r[n]).trim().toLowerCase());
    }
  };
  try {
    add(await sbGet("staged_leads?select=website_domain,phone_e164,business_name&status=in.(pending,imported)&limit=5000"),
      "website_domain", "phone_e164", "business_name");
  } catch { /* best-effort */ }
  try {
    add(await sbGet("companies?select=domain,name&limit=5000"), "domain", "phone_e164", "name");
  } catch { /* best-effort */ }
  return { domains, phones, names };
}

function isDupe(l: EnrichedLead, k: { domains: Set<string>; phones: Set<string>; names: Set<string> }): boolean {
  if (l.website_domain && k.domains.has(l.website_domain.toLowerCase())) return true;
  if (l.phone_e164 && k.phones.has(l.phone_e164.replace(/[^\d]/g, ""))) return true;
  if (k.names.has(l.business_name.trim().toLowerCase())) return true;
  return false;
}

async function loadTargets(body: Record<string, unknown>): Promise<Target[]> {
  const mk = (r: any): Target => ({
    id: r.id ?? null,
    label: r.label ?? r.niche ?? "ad-hoc",
    niche: r.niche,
    location: r.location ?? null,
    target_vertical: r.target_vertical ?? r.vertical ?? null,
    count: Number(r.count) || 10,
    dm_titles: Array.isArray(r.dm_titles) ? r.dm_titles : Array.isArray(r.dmTitles) ? r.dmTitles : [],
    model: typeof r.model === "string" && r.model.trim() ? r.model.trim() : "perplexity/sonar-pro",
    sync_abstrax: Boolean(r.sync_abstrax ?? r.syncAbstrax ?? false),
    // Default true so table targets + legacy callers still populate Command;
    // an OpenRouter routine can set toCommand:false to write Abstrax-only.
    to_command: (r.to_command ?? r.toCommand) !== false,
  });
  if (body.targetId) {
    const rows = await sbGet(`lead_enrichment_targets?id=eq.${body.targetId}&limit=1`);
    return rows.map(mk);
  }
  if (typeof body.niche === "string" && body.niche.trim()) {
    return [mk(body)];
  }
  const rows = await sbGet("lead_enrichment_targets?enabled=is.true&order=created_at.asc&limit=50");
  return rows.map(mk);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);

  const gate = Deno.env.get("RESPONDER_SECRET");
  if (gate && callerSecret(req) !== gate) return json({ ok: false, error: "Unauthorized." }, 401);

  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) return json({ ok: false, error: "OPENROUTER_API_KEY not set." }, 500);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty ok */ }
  const dryRun = Boolean(body.dryRun);
  const allow = allowedModels();

  let targets: Target[];
  try {
    targets = await loadTargets(body);
  } catch (e) {
    return json({ ok: false, error: `Could not load targets: ${(e as Error).message}` }, 500);
  }
  if (targets.length === 0) {
    return json({ ok: true, runs: [], totals: { inserted: 0 }, note: "No enabled targets and no ad-hoc niche given." });
  }

  // Abstrax mirror config (only used when a target opts in AND the key is set).
  const roicalKey = Deno.env.get("ROICAL_SERVICE_ROLE_KEY") || "";
  const roicalUrl = Deno.env.get("ROICAL_URL") || ROICAL_DEFAULT_URL;

  const known = await existingKeys();
  const runs: any[] = [];
  const foundAt = new Date().toISOString();
  let totalInserted = 0, totalCost = 0;

  for (const t of targets) {
    if (!t.niche) { runs.push({ target: t.label, error: "missing niche" }); continue; }
    if (!allow.has(t.model)) {
      runs.push({ target: t.label, model: t.model, error: `model not allowed (allowed: ${[...allow].join(", ")})` });
      continue;
    }

    const { text, usage, model, error } = await research(t, key);
    const cost = Number(usage?.cost) || 0;
    totalCost += cost;
    await logUsage(model, usage, !error, error ?? null);
    if (error || !text) {
      runs.push({ target: t.label, model, cost, error: error || "empty research result" });
      if (t.id) await sbPatch("lead_enrichment_targets", `id=eq.${t.id}`, { last_run_at: foundAt, last_result: { error: error || "empty", cost } });
      continue;
    }

    const vertical = t.target_vertical || t.niche;
    let leads = parseLeads(text, { niche: t.niche, location: t.location, model, foundAt })
      .map((l) => ({ ...l, vertical, categories: [vertical] }));
    const parsed = leads.length;
    // Dedupe within this batch AND against the CRM.
    const fresh: EnrichedLead[] = [];
    for (const l of leads) {
      if (isDupe(l, known)) continue;
      fresh.push(l);
      if (l.website_domain) known.domains.add(l.website_domain.toLowerCase());
      if (l.phone_e164) known.phones.add(l.phone_e164.replace(/[^\d]/g, ""));
      known.names.add(l.business_name.trim().toLowerCase());
    }
    const skipped = parsed - fresh.length;

    let inserted = 0, mirrored = 0, insErr: string | undefined;
    if (!dryRun && fresh.length) {
      // Command (staged_leads) and Abstrax (competitors) are independent
      // destinations — a routine can target either or both.
      if (t.to_command) {
        try {
          await sbInsert("staged_leads", fresh.map(toStagedLead));
          inserted = fresh.length;
          totalInserted += inserted;
        } catch (e) { insErr = (e as Error).message; }
      }

      if (t.sync_abstrax && roicalKey) {
        try {
          await sbInsert("competitors", fresh.map(toCompetitor), roicalUrl, roicalKey);
          mirrored = fresh.length;
        } catch (e) { insErr = (insErr ? insErr + "; " : "") + `abstrax: ${(e as Error).message}`; }
      } else if (t.sync_abstrax && !roicalKey) {
        insErr = (insErr ? insErr + "; " : "") + "abstrax: ROICAL_SERVICE_ROLE_KEY not set";
      }
    }

    const result = { requested: t.count, parsed, inserted: dryRun ? 0 : inserted, skipped, mirrored, cost };
    runs.push({ target: t.label, model, ...result, ...(insErr ? { error: insErr } : {}), ...(dryRun ? { dryRun: true, sample: fresh.slice(0, 3) } : {}) });
    if (t.id) await sbPatch("lead_enrichment_targets", `id=eq.${t.id}`, { last_run_at: foundAt, last_result: result });
  }

  // Best-effort recap into the Routiner Log (ad-hoc unless a routineId is passed).
  if (body.report !== false && SB_URL) {
    const lines = runs.map((r) => `- **${r.target}**: ${r.error ? `⚠ ${r.error}` : `${r.inserted} new / ${r.parsed} found (${r.skipped} dup)`}${r.mirrored ? `, ${r.mirrored}→Abstrax` : ""}`);
    fetch(`${SB_URL}/functions/v1/routiner-admin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "report",
        routineId: body.routineId ?? undefined,
        status: runs.some((r) => r.error && !r.inserted) ? "error" : "success",
        summary: `Lead enrichment: ${totalInserted} new lead(s) into the Review tab across ${targets.length} target(s) (~$${totalCost.toFixed(4)}).`,
        details: lines.join("\n"),
        models: [...new Set(runs.map((r) => r.model).filter(Boolean))],
      }),
    }).catch(() => {});
  }

  return json({ ok: true, runs, totals: { targets: targets.length, inserted: totalInserted, cost: Number(totalCost.toFixed(4)), dryRun } });
});
