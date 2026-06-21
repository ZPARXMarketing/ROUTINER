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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TRIGGER_URL = Deno.env.get("ROUTINER_TRIGGER_URL") ??
  "https://zroutiner.netlify.app/.netlify/functions/claude-trigger";

const rest = (path: string) => `${SUPABASE_URL}/rest/v1/${path}`;
const dbHeaders: Record<string, string> = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

function nextOccurrence(iso: string, rec: string): string | null {
  if (!iso || rec === "none") return null;
  const d = new Date(iso);
  const now = Date.now();
  do {
    d.setUTCDate(d.getUTCDate() + (rec === "weekly" ? 7 : 1));
    if (rec === "weekdays") {
      while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
        d.setUTCDate(d.getUTCDate() + 1);
      }
    }
  } while (d.getTime() <= now);
  return d.toISOString();
}

Deno.serve(async () => {
  const nowIso = new Date().toISOString();
  const dueRes = await fetch(
    rest(
      `routiner_routines?status=eq.scheduled&scheduled_at=lte.${encodeURIComponent(nowIso)}&select=*`,
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
  const results: Array<{ id: string; status: string }> = [];

  for (const r of due) {
    // Claim first (reschedule or retire) so an overlapping run can't double-fire.
    const next = nextOccurrence(r.scheduled_at, r.recurrence);
    const patch = next
      ? { scheduled_at: next, last_run: nowIso }
      : { status: "library", scheduled_at: null, last_run: nowIso };
    await fetch(rest(`routiner_routines?id=eq.${r.id}`), {
      method: "PATCH",
      headers: { ...dbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify(patch),
    });

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
          source: "routiner-scheduler",
          routineId: r.id,
          title: r.title,
          at: nowIso,
        }),
      });
      output = (await f.text()).slice(0, 2000);
      if (!f.ok) status = "error";
    } catch (e) {
      status = "error";
      output = String(e);
    }

    await fetch(rest("routiner_runs"), {
      method: "POST",
      headers: { ...dbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: r.user_id,
        routine_id: r.id,
        title: r.title,
        status,
        output,
      }),
    });
    results.push({ id: r.id, status });
  }

  return new Response(JSON.stringify({ ok: true, fired: results.length, results }), {
    headers: { "Content-Type": "application/json" },
  });
});
