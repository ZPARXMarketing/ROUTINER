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
import {
  areaMatch,
  buildGapFillPrompt,
  buildResearchPrompt,
  parseGapFill,
  parseLeads,
  scoreLead,
  scoreCeiling,
  toE164,
  verificationVerdict,
} from "../_shared/lead-parse.ts";
import type { SiteStatus } from "../_shared/lead-parse.ts";

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

// ── Deepen (second-pass gap fill) ────────────────────────────────────────────
// A discovery run optimises for breadth and routinely returns NONE for phone,
// website, or the decision-maker. Historically the human then re-searched each
// of those by hand in the Review tab — and the log is unambiguous about the
// stakes: every lead that arrived WITH a decision-maker got imported, and
// nearly every lead without one got rejected. So we re-ask, per business, before
// the human ever sees it.
const DEEPEN_BATCH = 12; // leads per deepen invocation
const DEEPEN_CONCURRENCY = 3; // parallel lookups — polite to OpenRouter, still quick
const DEEPEN_MAX_TOKENS = 700;
// Supabase kills an edge invocation at its wall-clock limit. Every phase checks
// this budget and returns cleanly with `remaining > 0` rather than being shot
// mid-write, so the caller can simply call again to finish the queue.
const WALL_BUDGET_MS = 130_000;
const deadlineFrom = (started: number) => started + WALL_BUDGET_MS;
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
/** Insert and return the new ids (so a follow-up phase can address the rows). */
async function sbInsertReturning(table: string, rows: unknown[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const r = await fetch(`${SB_URL}/rest/v1/${table}?select=id`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, Prefer: "return=representation" },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`INSERT ${table} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const out = await r.json().catch(() => []);
  return Array.isArray(out) ? out.map((x: any) => x.id).filter(Boolean) : [];
}
async function sbPatch(table: string, filter: string, patch: unknown): Promise<void> {
  await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  }).catch(() => {});
}

/** Like sbPatch, but surfaces failures — deepen must know if a write was lost. */
async function sbPatchStrict(table: string, filter: string, patch: unknown): Promise<void> {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`PATCH ${table} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
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
async function research(t: Target, key: string, exclude: string[]): Promise<{ text: string; usage: any; model: string; error?: string }> {
  const count = Math.max(1, Math.min(t.count || 10, COUNT_CAP));
  const { system, user } = buildResearchPrompt({
    niche: t.niche, location: t.location, count, dmTitles: t.dm_titles ?? [], exclude,
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

/**
 * Business names we already hold for roughly this area, to hand the model as a
 * "don't return these" list. Scoped by the target's city so the prompt stays
 * small — a global list would be thousands of names and mostly irrelevant.
 */
async function exclusionNames(location: string | null, limit = 60): Promise<string[]> {
  const city = (location ?? "").split(",")[0]?.trim();
  const names = new Set<string>();
  const q = city ? `&city=ilike.*${encodeURIComponent(city)}*` : "";
  for (const path of [
    `staged_leads?select=business_name&status=in.(pending,imported)${q}&limit=${limit}`,
    `companies?select=name&limit=${limit}`,
  ]) {
    try {
      for (const r of await sbGet(path)) {
        const n = (r.business_name ?? r.name ?? "").trim();
        if (n) names.add(n);
      }
    } catch { /* best-effort — an exclusion list is an optimisation, not a gate */ }
  }
  return [...names].slice(0, limit);
}

// ── website liveness ─────────────────────────────────────────────────────────
// The cheapest, most decisive check in the pipeline: a fabricated domain simply
// does not exist. No model, no API, no cost — and in the run that motivated
// this it identified every invented business on the first try.
//
// Any HTTP answer counts as alive, including 403/404/500: we are asking "does a
// server exist for this hostname", not "is the site any good". Only a
// DNS/connection failure is `dead`, and a timeout is `unknown` so a slow host is
// never mistaken for a fake one.
const SITE_TIMEOUT_MS = 6000;

async function checkSite(domain: string | null): Promise<SiteStatus> {
  if (!domain) return "none";
  const bare = domain.replace(/^www\./, "");
  // MUST try www, not just the apex. Plenty of real businesses publish only
  // www.<domain> with no apex A record — an apex-only probe calls those dead and
  // would strip a working website (and, paired with a thin research result,
  // could quarantine a real business). Verified against a live CRM site whose
  // apex does not resolve. Only when every candidate fails is a domain dead.
  const candidates = [`https://${bare}/`, `https://www.${bare}/`, `http://${bare}/`, `http://www.${bare}/`];
  let sawTimeout = false;
  for (const url of candidates) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SITE_TIMEOUT_MS);
    try {
      await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: ctrl.signal,
        headers: { "user-agent": "Mozilla/5.0 (compatible; ZPARX-lead-verify/1.0)" },
      });
      return "alive";
    } catch (e) {
      const n = (e as Error).name;
      if (n === "AbortError" || n === "TimeoutError") sawTimeout = true;
      // Otherwise a TypeError — DNS failure or refused connection. Try the next.
    } finally {
      clearTimeout(timer);
    }
  }
  // A host that only ever timed out is ambiguous, never evidence of fabrication.
  return sawTimeout ? "unknown" : "dead";
}

/** Liveness for many domains at once, bounded so a batch can't stall the run. */
async function checkSites(domains: (string | null)[], concurrency = 6): Promise<SiteStatus[]> {
  const out = new Array<SiteStatus>(domains.length).fill("none");
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= domains.length) return;
      out[i] = await checkSite(domains[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, domains.length || 1) }, worker));
  return out;
}

// ── the deepen phase ─────────────────────────────────────────────────────────

interface StagedRow {
  id: string;
  business_name: string;
  website_domain: string | null;
  city: string | null;
  region: string | null;
  phone_e164: string | null;
  email: string | null;
  contact_name: string | null;
  contact_title: string | null;
  lead_score: number | null;
  vertical: string | null;
  enrichment: Record<string, unknown> | null;
}

const gapsOf = (r: StagedRow): Array<"website" | "phone" | "contact" | "email"> => {
  const w: Array<"website" | "phone" | "contact" | "email"> = [];
  if (!r.website_domain) w.push("website");
  if (!r.phone_e164) w.push("phone");
  if (!r.contact_name) w.push("contact");
  if (!r.email) w.push("email");
  return w;
};

/** One targeted lookup for one business. Never throws. */
async function deepenOne(
  row: StagedRow,
  wants: Array<"website" | "phone" | "contact" | "email">,
  key: string,
  model: string,
  dmTitles: string[],
): Promise<{ found: ReturnType<typeof parseGapFill>; usage: any; model: string; error?: string }> {
  const { system, user } = buildGapFillPrompt(row, { wants, niche: row.vertical, dmTitles });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://routiner.zparx.app",
        "X-Title": "Routiner Lead Enrichment (deepen)",
      },
      body: JSON.stringify({
        model,
        max_tokens: DEEPEN_MAX_TOKENS,
        temperature: 0.1,
        usage: { include: true },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
      signal: ctrl.signal,
    });
    const data = await resp.json();
    if (!resp.ok) {
      return { found: null, usage: null, model, error: data?.error?.message || `OpenRouter ${resp.status}` };
    }
    return {
      found: parseGapFill((data?.choices?.[0]?.message?.content || "").trim()),
      usage: data?.usage || null,
      model: data?.model || model,
    };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "deepen timed out (60s)" : (e as Error).message;
    return { found: null, usage: null, model, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fill gaps on pending staged leads, one business at a time.
 *
 * Writes are strictly NON-DESTRUCTIVE: a value already on the row always wins,
 * so a re-run can only ever add. Each row is stamped `enrichment.deepened_at`
 * whether or not anything was found, which is what keeps this idempotent — the
 * selector skips stamped rows, so repeated calls walk forward through the queue
 * instead of paying to re-ask the same unanswerable questions.
 */
async function runDeepen(
  key: string,
  opts: { model: string; limit: number; deadline: number; dmTitles: string[]; leadIds?: string[] },
): Promise<{ eligible: number; scanned: number; filled: number; fields: Record<string, number>; unresolved: number; quarantined: number; remaining: number; cost: number; errors: string[] }> {
  const sel =
    "id,business_name,website_domain,city,region,phone_e164,email,contact_name,contact_title,lead_score,vertical,enrichment";
  const filter = opts.leadIds?.length
    ? `id=in.(${opts.leadIds.join(",")})`
    : `status=eq.pending&or=(phone_e164.is.null,contact_name.is.null,website_domain.is.null)&enrichment->>deepened_at=is.null`;

  let rows: StagedRow[] = [];
  try {
    rows = (await sbGet(`staged_leads?select=${sel}&${filter}&order=created_at.asc&limit=${opts.limit}`)) as StagedRow[];
  } catch (e) {
    return { eligible: 0, scanned: 0, filled: 0, fields: {}, unresolved: 0, quarantined: 0, remaining: 0, cost: 0, errors: [(e as Error).message] };
  }

  // How many are still queued behind this batch — lets the caller loop to zero.
  let queued = 0;
  if (!opts.leadIds?.length) {
    try {
      const more = await sbGet(
        `staged_leads?select=id&status=eq.pending&or=(phone_e164.is.null,contact_name.is.null,website_domain.is.null)&enrichment->>deepened_at=is.null&limit=200`,
      );
      queued = more.length;
    } catch { /* best-effort */ }
  }

  // A lead the first pass fully resolved has nothing to deepen. Counting those
  // as outstanding would make a caller loop over work that does not exist.
  const eligible = rows.filter((r) => gapsOf(r).length > 0).length;

  const fields: Record<string, number> = {};
  const errors: string[] = [];
  let filled = 0, unresolved = 0, cost = 0, scanned = 0, quarantined = 0;
  let cursor = 0;

  const worker = async () => {
    while (true) {
      if (Date.now() > opts.deadline) return; // out of wall clock — stop cleanly
      const i = cursor++;
      if (i >= rows.length) return;
      const row = rows[i];
      const wants = gapsOf(row);
      if (!wants.length) continue;
      scanned++;

      const { found, usage, model, error } = await deepenOne(row, wants, key, opts.model, opts.dmTitles);
      cost += Number(usage?.cost) || 0;
      await logUsage(model, usage, !error, error ?? null);
      if (error) {
        if (errors.length < 5) errors.push(`${row.business_name}: ${error}`);
        continue; // leave UNSTAMPED so a later run retries a transient failure
      }

      // Only ever add — never overwrite something we already trusted.
      const patch: Record<string, unknown> = {};
      const gained: string[] = [];
      const take = (col: string, cur: unknown, next: string | null) => {
        if (!cur && next) { patch[col] = next; gained.push(col); fields[col] = (fields[col] ?? 0) + 1; }
      };
      take("website_domain", row.website_domain, found?.website_domain ?? null);
      take("phone_e164", row.phone_e164, toE164(found?.phone ?? null));
      take("contact_name", row.contact_name, found?.contact_name ?? null);
      take("contact_title", row.contact_title, found?.contact_title ?? null);
      take("email", row.email, found?.email ?? null);

      const prev = (row.enrichment ?? {}) as Record<string, unknown>;

      // Verify whatever website we would end up shipping — the one the second
      // pass just proposed, or the one the first pass claimed. A domain that
      // does not resolve is dropped rather than handed to the human as real.
      const finalDomain = (patch.website_domain ?? row.website_domain) as string | null;
      let siteStatus: SiteStatus = await checkSite(finalDomain);
      let deadDomain: string | null = null;
      if (siteStatus === "dead" && finalDomain) {
        deadDomain = finalDomain;
        if (patch.website_domain) {
          delete patch.website_domain;
          const gi = gained.indexOf("website_domain");
          if (gi >= 0) gained.splice(gi, 1);
          fields.website_domain = Math.max(0, (fields.website_domain ?? 1) - 1);
        } else {
          patch.website_domain = null; // clear the fabricated one already on the row
        }
      }

      const hasPhone = Boolean(patch.phone_e164 ?? row.phone_e164);
      const hasContact = Boolean(patch.contact_name ?? row.contact_name);
      const { verdict, note: verdictNote } = verificationVerdict({
        gained: gained.length,
        confidence: found?.confidence ?? null,
        siteStatus,
        hasPhone,
        hasContact,
      });

      patch.enrichment = {
        ...prev,
        deepened_at: new Date().toISOString(),
        deepen_model: model,
        deepen_filled: gained,
        deepen_note: found?.note ?? null,
        deepen_confidence: found?.confidence ?? null,
        site_status: siteStatus,
        ...(deadDomain ? { dead_domain: deadDomain } : {}),
        verification: verdict,
        verification_note: verdictNote,
        verified_at: new Date().toISOString(),
        ...(found?.linkedin && !prev.linkedin ? { linkedin: found.linkedin } : {}),
      };

      // Two independent pieces of evidence against it — nothing corroborated
      // AND a website that does not exist — so it never reaches Review as a
      // normal lead. Everything softer stays visible, just capped.
      if (verdict === "failed") {
        patch.status = "rejected";
        quarantined++;
      }

      // Re-score against the enriched row so the Review tab sorts on truth.
      const merged = {
        contact_name: (patch.contact_name ?? row.contact_name) as string | null,
        phone_e164: (patch.phone_e164 ?? row.phone_e164) as string | null,
        email: (patch.email ?? row.email) as string | null,
        website_domain: (patch.website_domain ?? row.website_domain) as string | null,
        enrichment: { confidence: found?.confidence ?? null, dm_email: null },
      };
      patch.lead_score = Math.min(
        scoreLead(merged as unknown as Parameters<typeof scoreLead>[0]),
        scoreCeiling(verdict),
      );

      try {
        await sbPatchStrict("staged_leads", `id=eq.${row.id}`, patch);
        if (gained.length) filled++; else unresolved++;
      } catch (e) {
        if (errors.length < 5) errors.push(`${row.business_name}: write failed — ${(e as Error).message}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(DEEPEN_CONCURRENCY, rows.length || 1) }, worker));
  // Explicit ids → what's left is the gapped rows this batch didn't reach.
  // Whole-queue → what's left is everything still behind us in the queue.
  const remaining = opts.leadIds?.length
    ? Math.max(0, eligible - scanned)
    : Math.max(0, queued - scanned);
  return { eligible, scanned, filled, fields, unresolved, quarantined, remaining, cost: Number(cost.toFixed(4)), errors };
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
  const startedAt = Date.now();

  const deepenModel = (() => {
    const m = String(body.deepenModel || Deno.env.get("LEAD_DEEPEN_MODEL") || "perplexity/sonar-pro").trim();
    return allow.has(m) ? m : "perplexity/sonar-pro";
  })();

  // ── mode:"deepen" — pure gap-fill over the pending queue, no discovery ──────
  // Callable on its own so the queue can be drained across several invocations
  // (and so old leads that predate this feature can be back-filled).
  if (body.mode === "deepen") {
    const limit = Math.max(1, Math.min(Number(body.limit) || DEEPEN_BATCH, 25));
    const r = await runDeepen(key, {
      model: deepenModel,
      limit,
      deadline: deadlineFrom(startedAt),
      dmTitles: Array.isArray(body.dmTitles) ? (body.dmTitles as string[]) : [],
      leadIds: Array.isArray(body.leadIds) ? (body.leadIds as string[]) : undefined,
    });
    if (body.report !== false && SB_URL) {
      const gained = Object.entries(r.fields).map(([k, v]) => `${v}× ${k}`).join(", ") || "nothing new";
      fetch(`${SB_URL}/functions/v1/routiner-admin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "report",
          routineId: body.routineId ?? undefined,
          status: r.errors.length && !r.filled ? "error" : "success",
          summary: `Deepen: filled gaps on ${r.filled}/${r.scanned} lead(s) — ${gained}` +
            `${r.quarantined ? `; QUARANTINED ${r.quarantined} unverifiable lead(s)` : ""}. ` +
            `${r.remaining} still queued (~$${r.cost.toFixed(4)}).`,
          details: r.errors.length ? `Errors:\n${r.errors.map((e) => `- ${e}`).join("\n")}` : undefined,
          models: [deepenModel],
        }),
      }).catch(() => {});
    }
    return json({ ok: true, mode: "deepen", ...r });
  }

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
  const insertedIds: string[] = [];
  const foundAt = new Date().toISOString();
  let totalInserted = 0, totalCost = 0;

  for (const t of targets) {
    if (!t.niche) { runs.push({ target: t.label, error: "missing niche" }); continue; }
    if (!allow.has(t.model)) {
      runs.push({ target: t.label, model: t.model, error: `model not allowed (allowed: ${[...allow].join(", ")})` });
      continue;
    }

    const exclude = await exclusionNames(t.location);
    const { text, usage, model, error } = await research(t, key, exclude);
    const cost = Number(usage?.cost) || 0;
    totalCost += cost;
    await logUsage(model, usage, !error, error ?? null);
    if (error || !text) {
      runs.push({ target: t.label, model, cost, error: error || "empty research result" });
      if (t.id) await sbPatch("lead_enrichment_targets", `id=eq.${t.id}`, { last_run_at: foundAt, last_result: { error: error || "empty", cost } });
      continue;
    }

    const vertical = t.target_vertical || t.niche;
    const leads = parseLeads(text, { niche: t.niche, location: t.location, model, foundAt })
      .map((l) => ({ ...l, vertical, categories: [vertical] }));
    const parsed = leads.length;
    // Dedupe within this batch AND against the CRM, and drop out-of-area drift:
    // Huntsville targets have returned Birmingham (205) and Chattanooga (423)
    // businesses, which then burn a Review-tab slot on someone we can't serve.
    const fresh: EnrichedLead[] = [];
    let offArea = 0;
    for (const l of leads) {
      if (areaMatch(l, t.location) === "mismatch") { offArea++; continue; }
      if (isDupe(l, known)) continue;
      fresh.push(l);
      if (l.website_domain) known.domains.add(l.website_domain.toLowerCase());
      if (l.phone_e164) known.phones.add(l.phone_e164.replace(/[^\d]/g, ""));
      known.names.add(l.business_name.trim().toLowerCase());
    }
    const skipped = parsed - fresh.length - offArea;

    // Verify every claimed website BEFORE anything is inserted. This also
    // covers leads the second pass will skip for having no gaps — a fully
    // fabricated lead can look "complete", and the DNS check is what catches it.
    let deadSites = 0;
    if (fresh.length) {
      const statuses = await checkSites(fresh.map((l) => l.website_domain));
      fresh.forEach((l, i) => {
        const st = statuses[i];
        (l.enrichment as Record<string, unknown>).site_status = st;
        if (st === "dead") {
          deadSites++;
          (l.enrichment as Record<string, unknown>).dead_domain = l.website_domain;
          l.website_domain = null;
          l.lead_score = scoreLead(l as unknown as Parameters<typeof scoreLead>[0]);
        }
      });
    }

    let inserted = 0, mirrored = 0, insErr: string | undefined;
    if (!dryRun && fresh.length) {
      // Command (staged_leads) and Abstrax (competitors) are independent
      // destinations — a routine can target either or both.
      if (t.to_command) {
        try {
          // return=representation so we get the new ids and can deepen exactly
          // this run's leads rather than re-scanning the whole pending queue.
          const ids = await sbInsertReturning("staged_leads", fresh.map(toStagedLead));
          insertedIds.push(...ids);
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

    const result = { requested: t.count, parsed, inserted: dryRun ? 0 : inserted, skipped, offArea, deadSites, mirrored, cost };
    runs.push({ target: t.label, model, ...result, ...(insErr ? { error: insErr } : {}), ...(dryRun ? { dryRun: true, sample: fresh.slice(0, 3) } : {}) });
    if (t.id) await sbPatch("lead_enrichment_targets", `id=eq.${t.id}`, { last_run_at: foundAt, last_result: result });
  }

  // ── Automatic second pass ───────────────────────────────────────────────────
  // The whole point: a lead with a blank decision-maker used to reach the Review
  // tab and get rejected. Before the human ever sees these, re-ask about each
  // one individually. Deadline-aware, so a slow discovery phase degrades to
  // "deepen fewer" rather than getting the invocation killed mid-write; whatever
  // it doesn't reach stays queued for the next `mode:"deepen"` call.
  let deepen: Awaited<ReturnType<typeof runDeepen>> | null = null;
  if (!dryRun && insertedIds.length && body.deepen !== false) {
    const needing = insertedIds.slice(0, Math.max(1, Math.min(Number(body.deepenLimit) || DEEPEN_BATCH, 25)));
    deepen = await runDeepen(key, {
      model: deepenModel,
      limit: needing.length,
      deadline: deadlineFrom(startedAt),
      dmTitles: [...new Set(targets.flatMap((t) => t.dm_titles ?? []))],
      leadIds: needing,
    });
    totalCost += deepen.cost;
  }

  // Best-effort recap into the Routiner Log (ad-hoc unless a routineId is passed).
  if (body.report !== false && SB_URL) {
    const lines = runs.map((r) => `- **${r.target}**: ${r.error ? `⚠ ${r.error}` : `${r.inserted} new / ${r.parsed} found (${r.skipped} dup${r.offArea ? `, ${r.offArea} out-of-area` : ""}${r.deadSites ? `, ${r.deadSites} dead domain` : ""})`}${r.mirrored ? `, ${r.mirrored}→Abstrax` : ""}`);
    if (deepen) {
      const gained = Object.entries(deepen.fields).map(([k, v]) => `${v}× ${k}`).join(", ") || "nothing new";
      lines.push(
        `- **Deepen (2nd pass)**: filled ${deepen.filled}/${deepen.scanned} lead(s) — ${gained}` +
        `${deepen.unresolved ? `; ${deepen.unresolved} still had no verifiable details` : ""}` +
        `${deepen.remaining ? `; ${deepen.remaining} left queued` : ""}`,
      );
      if (deepen.quarantined) {
        lines.push(
          `- **Verification**: **${deepen.quarantined} lead(s) quarantined** — nothing corroborated AND the ` +
          `claimed website does not resolve. Marked \`rejected\`, not shown as live leads.`,
        );
      }
    }
    fetch(`${SB_URL}/functions/v1/routiner-admin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "report",
        routineId: body.routineId ?? undefined,
        status: runs.some((r) => r.error && !r.inserted) ? "error" : "success",
        summary: `Lead enrichment: ${totalInserted} new lead(s) into the Review tab across ${targets.length} target(s)` +
          `${deepen ? `, ${deepen.filled} gap-filled by the automatic 2nd pass` : ""}` +
          `${deepen?.quarantined ? `, ${deepen.quarantined} quarantined as unverifiable` : ""} (~$${totalCost.toFixed(4)}).`,
        details: lines.join("\n"),
        models: [...new Set([...runs.map((r) => r.model), ...(deepen ? [deepenModel] : [])].filter(Boolean))],
      }),
    }).catch(() => {});
  }

  return json({
    ok: true,
    runs,
    ...(deepen ? { deepen } : {}),
    totals: { targets: targets.length, inserted: totalInserted, cost: Number(totalCost.toFixed(4)), dryRun },
  });
});
