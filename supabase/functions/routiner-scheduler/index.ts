import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Routiner scheduler: finds due routines and fires each one through the
// Netlify CLAUDE_TRIGGER forwarder, then reschedules recurring ones and
// retires one-offs. Runs with the service role (bypasses RLS) so it can
// process every user's due routines. Invoked every minute by pg_cron
// (see supabase/migrations/0002_routiner_scheduler.sql).
//
// Deployed to the `zparx-dashboard` Supabase project as function
// `routiner-scheduler`. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
// injected automatically; ROUTINER_TRIGGER_URL is optional.
//
// Reliability properties (see supabase/migrations/0009_scheduler_reliability.sql):
//   • Atomic claim — each due row is claimed with a conditional PATCH that only
//     matches while it's still status=scheduled at its original scheduled_at, so
//     two overlapping invocations can never both fire the same routine.
//   • Parallel — due routines are processed with Promise.allSettled, bounded by
//     SCHEDULER_BATCH per run so a backlog can't blow the function's wall clock.
//   • Bounded retry — a one-off whose fire fails for a *transient* reason is
//     re-armed with exponential backoff and gives up after MAX_RETRIES, instead
//     of being silently lost. A *permanent* failure (misconfigured account /
//     rejected token — see isPermanentError) gives up on the first failure
//     rather than retrying an error that can never succeed (issue #48).
//   • Grace window — a routine more than MAX_STALE_MIN past due (e.g. after
//     scheduler downtime) is marked "missed" rather than fired, so recovery
//     doesn't unleash a flood of stale fires.
//   • DST-correct recurrence — when a routine has a tz, the next occurrence is
//     the same local wall-clock time in that zone (see nextOccurrence).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TRIGGER_URL = Deno.env.get("ROUTINER_TRIGGER_URL") ??
  "https://zroutiner.netlify.app/.netlify/functions/claude-trigger";
// Non-Claude executor: an "openrouter"-kind account fires this edge function
// directly (Perplexity lead enrichment) instead of a Claude routine /fire.
const LEAD_ENRICHMENT_URL = Deno.env.get("LEAD_ENRICHMENT_URL") ??
  `${SUPABASE_URL}/functions/v1/lead-enrichment`;
// Non-Claude executor: an "openrouter-agent"-kind account fires this edge
// function (a model + tool loop), which itself writes the run's full output to
// routiner_runs — so the scheduler does NOT log a second row for it.
const OPENROUTER_AGENT_URL = Deno.env.get("OPENROUTER_AGENT_URL") ??
  `${SUPABASE_URL}/functions/v1/openrouter-agent`;
const DEFAULT_AGENT_MODEL = "moonshotai/kimi-k2.7-code";

// Tunables (all optional env overrides).
const num = (name: string, def: number) => Number(Deno.env.get(name)) || def;
const SCHEDULER_BATCH = num("SCHEDULER_BATCH", 50);   // max routines processed per invocation
const MAX_RETRIES = num("SCHEDULER_MAX_RETRIES", 1);  // transient one-off fire retries before giving up
const RETRY_BACKOFF_MIN = num("SCHEDULER_RETRY_BACKOFF_MIN", 2); // 2,4,8… minutes
const MAX_STALE_MIN = num("SCHEDULER_MAX_STALE_MIN", 360); // >6h past due → mark missed, don't fire
const FIRE_TIMEOUT_MS = num("SCHEDULER_FIRE_TIMEOUT_MS", 30_000); // don't let one hung fire stall the run

// Anthropic headers for firing a routine /fire directly (same values the Netlify
// forwarder uses). Lets the scheduler fire with the owner's in-app token instead
// of the forwarder's env-var token — see the fire block in processOne.
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_BETA = Deno.env.get("CLAUDE_ROUTINE_BETA") || "experimental-cc-routine-2026-04-01";

const rest = (path: string) => `${SUPABASE_URL}/rest/v1/${path}`;
const dbHeaders: Record<string, string> = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

// Built-in DEFAULT auto-routing policy — the fallback when a user hasn't saved
// their own. The live policy is per-user in routiner_settings.model_policy
// (edited in the app's Settings and read below), so app + scheduler share one
// source. This default mirrors js/model-router.js ROUTING_POLICY — update both
// when the default changes; verify the ids against the /fire endpoint.
const ROUTING_POLICY: Record<string, Record<string, string>> = {
  planning: {
    low: "claude-sonnet-5",
    medium: "claude-sonnet-5",
    high: "claude-opus-4-8",
  },
  execution: {
    low: "claude-haiku-4-5-20251001",
    medium: "claude-haiku-4-5-20251001",
    high: "claude-sonnet-5",
  },
  general: {
    low: "claude-haiku-4-5-20251001",
    medium: "claude-sonnet-5",
    high: "claude-opus-4-8",
  },
};
const FALLBACK_MODEL = "claude-sonnet-5";
const COMPLEXITY_KEYS = ["low", "medium", "high"];

// Validate a per-user policy (routiner_settings.model_policy) into the
// ROUTING_POLICY shape, filling any missing cell from the built-in default.
// Returns null when there's nothing usable, so the caller falls back to default.
// Mirrors normalizePolicy in js/model-router.js — both read the same stored row.
function normalizePolicy(raw: unknown): Record<string, Record<string, string>> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, Record<string, string>>;
  const out: Record<string, Record<string, string>> = {};
  let any = false;
  for (const tt of Object.keys(ROUTING_POLICY)) {
    const src = r[tt] && typeof r[tt] === "object" ? r[tt] : {};
    out[tt] = {};
    for (const cx of COMPLEXITY_KEYS) {
      const v = typeof src[cx] === "string" && src[cx].trim() ? src[cx].trim() : ROUTING_POLICY[tt][cx];
      if (typeof src[cx] === "string" && src[cx].trim()) any = true;
      out[tt][cx] = v;
    }
  }
  return any ? out : null;
}

// A routine's effective model: an explicit pick wins; "auto" routes from
// task_type + complexity via the given policy (the owner's, else the default).
function effectiveModel(
  r: { model?: string; task_type?: string; complexity?: string },
  policy: Record<string, Record<string, string>> = ROUTING_POLICY,
): string {
  const m = r.model || "auto";
  if (m && m !== "auto") return m;
  const row = policy[r.task_type || "general"] || policy.general || ROUTING_POLICY.general;
  return row[r.complexity || "medium"] || row.medium || FALLBACK_MODEL;
}

// ── Timezone-aware recurrence ────────────────────────────────────────────────
// Resolve the local wall-clock parts of an instant in a given IANA zone.
function localParts(instant: number, tz: string) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(instant))) m[p.type] = p.value;
  let hour = Number(m.hour);
  if (hour === 24) hour = 0; // some runtimes emit "24" at midnight
  return { y: +m.year, mo: +m.month, d: +m.day, h: hour, mi: +m.minute, s: +m.second };
}
// Offset (ms) between wall-clock in tz and UTC at a given instant.
function tzOffsetMs(instant: number, tz: string): number {
  const p = localParts(instant, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - instant;
}
// Convert a wall-clock time in tz to a UTC instant, refining once so DST
// transitions resolve to the correct offset.
function zonedTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const inst = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(inst, tz);
}
const dowOf = (y: number, mo: number, d: number) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
function addDaysYmd(y: number, mo: number, d: number, n: number) {
  const t = new Date(Date.UTC(y, mo - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

// The next occurrence strictly after now. With a tz, holds the anchor's local
// wall-clock time (DST-correct); without one, falls back to the legacy UTC-day
// arithmetic so pre-tz routines behave exactly as before.
function nextOccurrence(iso: string, rec: string, tz?: string | null): string | null {
  if (!iso || rec === "none") return null;
  const now = Date.now();

  if (!tz) {
    const d = new Date(iso);
    do {
      d.setUTCDate(d.getUTCDate() + (rec === "weekly" ? 7 : 1));
      if (rec === "weekdays") {
        while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
      }
    } while (d.getTime() <= now);
    return d.toISOString();
  }

  const base = localParts(new Date(iso).getTime(), tz);
  let day = { y: base.y, mo: base.mo, d: base.d };
  let inst: number;
  do {
    day = addDaysYmd(day.y, day.mo, day.d, rec === "weekly" ? 7 : 1);
    if (rec === "weekdays") {
      while (dowOf(day.y, day.mo, day.d) === 0 || dowOf(day.y, day.mo, day.d) === 6) {
        day = addDaysYmd(day.y, day.mo, day.d, 1);
      }
    }
    inst = zonedTimeToUtc(day.y, day.mo, day.d, base.h, base.mi, tz);
  } while (inst <= now);
  return new Date(inst).toISOString();
}

// ── Per-account credential resolution ────────────────────────────────────────
// Mirrors the app + claude-trigger (netlify/functions/claude-trigger.mjs): a
// trigger's stored value is either a full /fire URL or a "trig_…" id.
function resolveFireUrl(trigger?: string | null): string | null {
  if (!trigger) return null;
  if (/^https?:\/\//i.test(trigger)) return trigger;
  if (/^trig_/.test(trigger)) return `https://api.anthropic.com/v1/claude_code/routines/${trigger}/fire`;
  return null;
}
// Resolve one account+trigger's saved { trigger, token } from a user's
// routiner_settings.accounts (list-of-accounts shape). Returns the pair intact
// (never mixed across sources) or null when the owner has nothing saved.
function pickCreds(
  accounts: unknown,
  account: string,
  triggerKey?: string | null,
): { trigger: string; token: string } | null {
  if (!Array.isArray(accounts)) return null;
  const a = accounts.find((x) => x && x.id === account);
  if (!a) return null;
  const trigs = Array.isArray(a.triggers) ? a.triggers : [];
  const t = (triggerKey && trigs.find((x: { id?: string }) => x && x.id === triggerKey)) || trigs[0];
  return t ? { trigger: t.trigger || "", token: t.token || "" } : null;
}

// An account's executor kind. "claude" (default) fires a Claude routine /fire;
// "openrouter" fires the lead-enrichment edge function with no Claude at all.
function accountKind(accounts: unknown, account: string): string {
  if (!Array.isArray(accounts)) return "claude";
  const a = accounts.find((x) => x && x.id === account);
  return (a && typeof a.kind === "string" && a.kind) || "claude";
}

// Fire an OpenRouter-kind routine: its `prompt` is a small JSON config
// { niche, location, count, dmTitles, vertical, model, toCommand, toAbstrax }.
// We POST it to the lead-enrichment function (service-role auth satisfies the
// function's verify_jwt) which does the Perplexity research + writes. Returns
// { status, output } shaped like the Claude path so the caller's tail is shared.
async function fireOpenRouter(r: Record<string, any>): Promise<{ status: string; output: string }> {
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(r.prompt || "{}"); } catch { /* not JSON → empty config */ }
  const payload = {
    niche: cfg.niche,
    location: cfg.location ?? null,
    count: cfg.count,
    dmTitles: cfg.dmTitles,
    vertical: cfg.vertical,
    model: cfg.model,
    toCommand: cfg.toCommand,
    syncAbstrax: cfg.toAbstrax ?? cfg.syncAbstrax,
    routineId: r.id,
    report: true,
  };
  if (!payload.niche) {
    return { status: "error", output: "OpenRouter routine has no 'niche' in its config prompt." };
  }
  try {
    const f = await fetch(LEAD_ENRICHMENT_URL, {
      method: "POST",
      headers: { ...dbHeaders },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(150_000),
    });
    const output = (await f.text()).slice(0, 2000);
    return { status: f.ok ? "success" : "error", output };
  } catch (e) {
    return {
      status: "error",
      output: e instanceof DOMException && e.name === "TimeoutError" ? "Enrichment timed out" : String(e),
    };
  }
}

// Resolve an openrouter-agent instance's model + tools from the owner's
// accounts (the trigger carries model/tools). Falls back to the first instance,
// then the routine's own model / the default.
function pickAgentInstance(accounts: unknown, account: string, triggerKey?: string | null): { model: string | null; tools: string[] | null } {
  if (!Array.isArray(accounts)) return { model: null, tools: null };
  const a = accounts.find((x) => x && x.id === account);
  const trigs = a && Array.isArray(a.triggers) ? a.triggers : [];
  const t = (triggerKey && trigs.find((x: { id?: string }) => x && x.id === triggerKey)) || trigs[0];
  return {
    model: t && typeof t.model === "string" && t.model ? t.model : null,
    tools: t && Array.isArray(t.tools) ? t.tools : null,
  };
}

// Fire an OpenRouter agent routine: POST the task to the openrouter-agent edge
// function, which runs the model + tool loop and writes the full output to
// routiner_runs itself. `persisted` tells the caller whether a run row was
// written (true when the function accepted the job) so we don't duplicate it.
async function fireAgent(r: Record<string, any>, accounts: unknown): Promise<{ status: string; output: string; persisted: boolean }> {
  if (!r.prompt || !String(r.prompt).trim()) return { status: "error", output: "Agent routine has no directions.", persisted: false };
  const inst = pickAgentInstance(accounts, r.account, r.trigger_key);
  const model = inst.model || (typeof r.model === "string" && r.model && r.model !== "auto" ? r.model : DEFAULT_AGENT_MODEL);
  const tools = inst.tools || ["read", "research", "write"];
  try {
    const f = await fetch(OPENROUTER_AGENT_URL, {
      method: "POST",
      headers: { ...dbHeaders },
      body: JSON.stringify({ prompt: r.prompt, model, tools, account: r.account, triggerKey: r.trigger_key, routineId: r.id, title: r.title, source: "routiner-scheduler" }),
      signal: AbortSignal.timeout(150_000),
    });
    const raw = await f.text();
    let data: any = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
    if (!f.ok || data.ok === false) {
      // Prefer the function's error field; fall back to body text so empty gateway
      // 502/504s aren't just "agent HTTP 502" with no clue (timeouts, crashes).
      const detail = data.error || (raw && raw.slice(0, 400)) ||
        (f.status === 502 || f.status === 504
          ? `agent HTTP ${f.status} (empty body — usually the edge function timed out or was killed; try a shorter prompt / fewer tools, or redeploy openrouter-agent with a tighter deadline)`
          : `agent HTTP ${f.status}`);
      return { status: "error", output: String(detail).slice(0, 2000), persisted: false };
    }
    // The function wrote the routiner_runs row (full-length); don't log again.
    return { status: "success", output: String(data.output || "").slice(0, 2000), persisted: true };
  } catch (e) {
    const output = e instanceof DOMException && e.name === "TimeoutError" ? "Agent run timed out" : String(e);
    return { status: "error", output, persisted: false };
  }
}

// ── REST helpers ─────────────────────────────────────────────────────────────
async function patchRow(id: string, patch: Record<string, unknown>) {
  await fetch(rest(`routiner_routines?id=eq.${id}`), {
    method: "PATCH",
    headers: { ...dbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
}
async function logRun(r: Record<string, unknown>, status: string, output: string) {
  await fetch(rest("routiner_runs"), {
    method: "POST",
    headers: { ...dbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: r.user_id,
      routine_id: r.id,
      title: r.title,
      status,
      output: String(output).slice(0, 2000),
    }),
  });
}

// A permanent failure is a misconfiguration or a rejected credential: it will
// fail identically on every retry, so re-arming it just spams the Log with the
// same error "over and over" (issue #48 — a mis-typed openrouter account with no
// trigger produced 4 identical failures per routine). Detected from the fire's
// output text, which is stable across all three fire paths (Netlify forwarder,
// direct /fire, and the openrouter/-agent functions).
function isPermanentError(output: string): boolean {
  const o = (output || "").toLowerCase();
  return (
    o.includes("no trigger configured") ||  // account has no /fire URL or trig_ id
    o.includes("rejected the token") ||      // annotated 401/403 on the direct path
    o.includes("upstream 401") || o.includes("upstream 403") ||
    (o.includes("401") && o.includes("token")) || // forwarder-shaped auth failures
    o.includes("no 'niche'") ||              // openrouter lead-enrichment misconfig
    o.includes("has no directions")          // openrouter-agent with an empty prompt
  );
}

// Decide what happens to a failed one-off after a fire error, and return the
// output annotated with the outcome. Permanent errors give up immediately;
// transient errors back off and retry up to MAX_RETRIES. Recurring routines are
// left untouched (their next occurrence already stands). Shared by all three
// fire paths so retry policy stays identical everywhere.
async function handleFireFailure(r: Record<string, any>, output: string): Promise<string> {
  if (r.recurrence !== "none") return output;
  if (isPermanentError(output)) {
    return output +
      `\n(permanent error — gave up without retrying; fix the routine's account/trigger in Settings, then re-run it)`;
  }
  const attempts = (r.retry_count || 0) + 1;
  if (attempts <= MAX_RETRIES) {
    const backoff = RETRY_BACKOFF_MIN * 2 ** (attempts - 1);
    const retryAt = new Date(Date.now() + backoff * 60_000).toISOString();
    await patchRow(r.id, { status: "scheduled", scheduled_at: retryAt, retry_count: attempts });
    return output + `\n(retry ${attempts}/${MAX_RETRIES} in ${backoff} min)`;
  }
  return output + `\n(gave up after ${MAX_RETRIES} retries)`;
}

// Process a single due routine end to end: claim, then fire (or mark missed),
// then retry/log. Independent per routine, so callers run these in parallel.
async function processOne(
  r: Record<string, any>,
  nowIso: string,
  policy: Record<string, Record<string, string>> = ROUTING_POLICY,
  accounts: unknown = null,
): Promise<string> {
  const orig = r.scheduled_at as string;
  const next = nextOccurrence(orig, r.recurrence, r.tz);
  const claimPatch = next
    ? { scheduled_at: next, last_run: nowIso }
    : { status: "library", scheduled_at: null, last_run: nowIso };

  // Atomic claim: only matches while the row is still scheduled at its original
  // time. If an overlapping invocation already advanced it, this matches zero
  // rows and we skip — no double-fire.
  const claimUrl = rest(
    `routiner_routines?id=eq.${r.id}&status=eq.scheduled&scheduled_at=eq.${encodeURIComponent(orig)}`,
  );
  let claimed: unknown[] = [];
  try {
    const res = await fetch(claimUrl, {
      method: "PATCH",
      headers: { ...dbHeaders, Prefer: "return=representation" },
      body: JSON.stringify(claimPatch),
    });
    claimed = res.ok ? await res.json().catch(() => []) : [];
  } catch {
    claimed = [];
  }
  if (!Array.isArray(claimed) || claimed.length === 0) return "skipped";

  // Grace window: if we're recovering from downtime and this slot is long past,
  // don't fire it — record it as missed. (The claim already advanced a recurring
  // routine to its next future occurrence, so it resumes normally.)
  const lateMin = (Date.now() - new Date(orig).getTime()) / 60000;
  if (lateMin > MAX_STALE_MIN) {
    await logRun(r, "missed", `Skipped — ${Math.round(lateMin)} min past due (grace ${MAX_STALE_MIN} min).`);
    return "missed";
  }

  // Fire the routine. Prefer the owner's in-app token (routiner_settings,
  // resolved here under the service role) so a scheduled fire uses the SAME
  // credential the app uses for a manual fire — no Netlify env token needed.
  // Fall back to the Netlify forwarder (which holds CLAUDE_TRIGGER + CLAUDE_TOKEN
  // env vars) only when the owner has nothing saved for this account+trigger.
  // OpenRouter-kind account: fire the enrichment engine directly, no Claude.
  if (accountKind(accounts, r.account) === "openrouter") {
    let { status: orStatus, output: orOutput } = await fireOpenRouter(r);
    if (orStatus === "error") orOutput = await handleFireFailure(r, orOutput);
    await logRun(r, orStatus, orOutput);
    return orStatus;
  }

  // OpenRouter agent account: run the model + tool loop. The edge function writes
  // the run row itself, so we only logRun when it was NOT persisted (a hard
  // reject before it ran) — avoids a duplicate Log entry on the happy path.
  if (accountKind(accounts, r.account) === "openrouter-agent") {
    let { status: agStatus, output: agOutput, persisted } = await fireAgent(r, accounts);
    if (agStatus === "error") agOutput = await handleFireFailure(r, agOutput);
    if (!persisted) await logRun(r, agStatus, agOutput);
    return agStatus;
  }

  const rawModel = effectiveModel(r, policy);
  const model = /^claude-/i.test(rawModel) ? rawModel : null; // only Claude ids go to /fire
  const creds = pickCreds(accounts, r.account, r.trigger_key);
  const directUrl = creds && creds.token ? resolveFireUrl(creds.trigger) : null;

  let status = "success";
  let output = "";
  try {
    let f: Response;
    if (directUrl && creds) {
      // Direct fire with the owner's saved token+URL (kept as a matched pair).
      f = await fetch(directUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.token}`,
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-beta": ANTHROPIC_BETA,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: r.prompt, ...(model ? { model } : {}) }),
        signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
      });
    } else {
      // Legacy fallback: let the Netlify forwarder resolve env-var creds.
      const fireHeaders: Record<string, string> = { "Content-Type": "application/json" };
      const fireSecret = Deno.env.get("ROUTINER_FIRE_SECRET");
      if (fireSecret) fireHeaders.Authorization = `Bearer ${fireSecret}`;
      f = await fetch(TRIGGER_URL, {
        method: "POST",
        headers: fireHeaders,
        body: JSON.stringify({
          text: r.prompt,
          account: r.account,
          triggerKey: r.trigger_key,
          ...(model ? { model } : {}),
          source: "routiner-scheduler",
          routineId: r.id,
          title: r.title,
          at: nowIso,
        }),
        signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
      });
    }
    output = (await f.text()).slice(0, 2000);
    if (!f.ok) {
      status = "error";
      // Translate an upstream auth failure on the direct path into an actionable
      // message — the token saved in the app's Settings needs refreshing.
      if (directUrl && (f.status === 401 || f.status === 403)) {
        output = `Anthropic rejected the token saved in Settings for account "${r.account}" / trigger "${r.trigger_key}" (upstream ${f.status}) — paste a fresh token there. ${output}`.slice(0, 2000);
      }
    }
  } catch (e) {
    status = "error";
    output = e instanceof DOMException && e.name === "TimeoutError"
      ? `Fire timed out after ${FIRE_TIMEOUT_MS} ms`
      : String(e);
  }

  if (status === "error") {
    // Bounded retry for one-offs: transient errors back off and retry up to
    // MAX_RETRIES; permanent errors (bad account/token) give up on the first
    // failure so they don't retry over and over (issue #48). Recurring routines
    // already have a next occurrence queued, so a failed instance just gets
    // logged. All handled by the shared handleFireFailure helper.
    output = await handleFireFailure(r, output);
  } else if (status === "success" && (r.retry_count || 0) > 0) {
    await patchRow(r.id, { retry_count: 0 }); // clear the counter after a good run
  }

  await logRun(r, status, output);
  return status;
}

Deno.serve(async () => {
  const nowIso = new Date().toISOString();
  const dueRes = await fetch(
    rest(
      `routiner_routines?status=eq.scheduled&scheduled_at=lte.${encodeURIComponent(nowIso)}` +
        `&select=*&order=scheduled_at.asc&limit=${SCHEDULER_BATCH}`,
    ),
    { headers: dbHeaders },
  );
  if (!dueRes.ok) {
    return new Response(
      JSON.stringify({ ok: false, error: `query ${dueRes.status}` }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
  const due = await dueRes.json();

  // Load each owner's settings once: the auto-routing policy (shared with the app
  // via routiner_settings.model_policy) so `auto` fires pick the model the user
  // configured, and the accounts list so a scheduled fire can use the owner's
  // in-app trigger token — the same credential the app uses for a manual fire.
  // Missing/invalid policy → the built-in default; missing accounts → the
  // Netlify-forwarder fallback in processOne.
  const policyByUser: Record<string, Record<string, Record<string, string>>> = {};
  const accountsByUser: Record<string, unknown> = {};
  const userIds = [...new Set(due.map((r: Record<string, any>) => r.user_id).filter(Boolean))];
  if (userIds.length) {
    try {
      const inList = userIds.map((u) => encodeURIComponent(String(u))).join(",");
      const pr = await fetch(
        rest(`routiner_settings?select=user_id,model_policy,accounts&user_id=in.(${inList})`),
        { headers: dbHeaders },
      );
      if (pr.ok) {
        for (const row of await pr.json()) {
          const np = normalizePolicy(row.model_policy);
          if (np) policyByUser[row.user_id] = np;
          if (row.accounts) accountsByUser[row.user_id] = row.accounts;
        }
      }
    } catch { /* fall back to the default policy + env-var creds per routine */ }
  }

  // Process independently and in parallel; one slow/failed routine can't block
  // the others, and the batch limit keeps this within the function's wall clock.
  const settled = await Promise.allSettled(
    due.map((r: Record<string, any>) =>
      processOne(r, nowIso, policyByUser[r.user_id] || ROUTING_POLICY, accountsByUser[r.user_id] ?? null)
    ),
  );

  const results = settled.map((s, i) => ({
    id: due[i].id,
    status: s.status === "fulfilled" ? s.value : "error",
  }));
  const fired = results.filter((r) => r.status === "success").length;

  return new Response(JSON.stringify({ ok: true, due: due.length, fired, results }), {
    headers: { "Content-Type": "application/json" },
  });
});
