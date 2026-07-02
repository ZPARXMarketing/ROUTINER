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
//   • Bounded retry — a one-off whose fire fails is re-armed with exponential
//     backoff and gives up after MAX_RETRIES, instead of being silently lost.
//   • Grace window — a routine more than MAX_STALE_MIN past due (e.g. after
//     scheduler downtime) is marked "missed" rather than fired, so recovery
//     doesn't unleash a flood of stale fires.
//   • DST-correct recurrence — when a routine has a tz, the next occurrence is
//     the same local wall-clock time in that zone (see nextOccurrence).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TRIGGER_URL = Deno.env.get("ROUTINER_TRIGGER_URL") ??
  "https://zroutiner.netlify.app/.netlify/functions/claude-trigger";

// Tunables (all optional env overrides).
const num = (name: string, def: number) => Number(Deno.env.get(name)) || def;
const SCHEDULER_BATCH = num("SCHEDULER_BATCH", 50);   // max routines processed per invocation
const MAX_RETRIES = num("SCHEDULER_MAX_RETRIES", 3);  // one-off fire retries before giving up
const RETRY_BACKOFF_MIN = num("SCHEDULER_RETRY_BACKOFF_MIN", 2); // 2,4,8… minutes
const MAX_STALE_MIN = num("SCHEDULER_MAX_STALE_MIN", 360); // >6h past due → mark missed, don't fire
const FIRE_TIMEOUT_MS = num("SCHEDULER_FIRE_TIMEOUT_MS", 30_000); // don't let one hung fire stall the run

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

// Process a single due routine end to end: claim, then fire (or mark missed),
// then retry/log. Independent per routine, so callers run these in parallel.
async function processOne(
  r: Record<string, any>,
  nowIso: string,
  policy: Record<string, Record<string, string>> = ROUTING_POLICY,
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

  // Fire via the Netlify forwarder (which holds CLAUDE_TRIGGER + CLAUDE_TOKEN).
  let status = "success";
  let output = "";
  try {
    const fireHeaders: Record<string, string> = { "Content-Type": "application/json" };
    const fireSecret = Deno.env.get("ROUTINER_FIRE_SECRET");
    if (fireSecret) fireHeaders.Authorization = `Bearer ${fireSecret}`;
    const f = await fetch(TRIGGER_URL, {
      method: "POST",
      headers: fireHeaders,
      body: JSON.stringify({
        text: r.prompt,
        account: r.account,
        triggerKey: r.trigger_key,
        model: effectiveModel(r, policy),
        source: "routiner-scheduler",
        routineId: r.id,
        title: r.title,
        at: nowIso,
      }),
      signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
    });
    output = (await f.text()).slice(0, 2000);
    if (!f.ok) status = "error";
  } catch (e) {
    status = "error";
    output = e instanceof DOMException && e.name === "TimeoutError"
      ? `Fire timed out after ${FIRE_TIMEOUT_MS} ms`
      : String(e);
  }

  if (status === "error" && r.recurrence === "none") {
    // Bounded retry for one-offs: re-arm with exponential backoff, give up after
    // MAX_RETRIES. (Recurring routines already have a next occurrence queued, so
    // a single failed instance just gets logged.)
    const attempts = (r.retry_count || 0) + 1;
    if (attempts <= MAX_RETRIES) {
      const backoff = RETRY_BACKOFF_MIN * 2 ** (attempts - 1);
      const retryAt = new Date(Date.now() + backoff * 60_000).toISOString();
      await patchRow(r.id, { status: "scheduled", scheduled_at: retryAt, retry_count: attempts });
      output += `\n(retry ${attempts}/${MAX_RETRIES} in ${backoff} min)`;
    } else {
      output += `\n(gave up after ${MAX_RETRIES} retries)`;
    }
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

  // Load each owner's auto-routing policy once (shared with the app via
  // routiner_settings.model_policy), so `auto` fires pick the model the user
  // configured. Missing/invalid → the built-in default.
  const policyByUser: Record<string, Record<string, Record<string, string>>> = {};
  const userIds = [...new Set(due.map((r: Record<string, any>) => r.user_id).filter(Boolean))];
  if (userIds.length) {
    try {
      const inList = userIds.map((u) => encodeURIComponent(String(u))).join(",");
      const pr = await fetch(
        rest(`routiner_settings?select=user_id,model_policy&user_id=in.(${inList})`),
        { headers: dbHeaders },
      );
      if (pr.ok) {
        for (const row of await pr.json()) {
          const np = normalizePolicy(row.model_policy);
          if (np) policyByUser[row.user_id] = np;
        }
      }
    } catch { /* fall back to the default policy per routine */ }
  }

  // Process independently and in parallel; one slow/failed routine can't block
  // the others, and the batch limit keeps this within the function's wall clock.
  const settled = await Promise.allSettled(
    due.map((r: Record<string, any>) => processOne(r, nowIso, policyByUser[r.user_id] || ROUTING_POLICY)),
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
