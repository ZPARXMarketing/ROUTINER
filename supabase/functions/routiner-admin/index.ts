// routiner-admin — service-role proxy so scheduled planning sessions can
// actually read the board and write routine blocks.
//
// Why this exists: a fired Claude Code routine session has no
// SUPABASE_SERVICE_ROLE_KEY, so it can't satisfy the per-user RLS on
// routiner_* tables. Supabase injects the service-role key into *edge
// functions* automatically, so this function performs the planner's
// operations on its behalf. The elevated key never leaves Supabase.
//
// It is deliberately NOT a generic SQL endpoint — it exposes only the three
// operations the plan-routines skill needs, with whitelisted fields:
//
//   GET/POST  action=context           → { ownerUserId, activeNotes, scheduled, accounts }
//   POST      action=schedule  blocks[] → inserts routine rows (status forced 'scheduled')
//   POST      action=markNote  id,status → sets a note to planned|done|dismissed
//   POST      action=targets           → the lead-finder grid (lead_enrichment_targets),
//                                        next-up first, with yield + whether it's scheduled
//   POST      action=addTarget  niche,location,… → adds one grid cell (one niche, one city)
//   POST      action=unschedule  routineId → moves a scheduled Lead Finder routine back
//                                        to the Library (only account "openrouter")
//   POST      action=report  routineId,summary,status? → logs a run row so a fired
//                                        session can report back what it did (shows in History).
//                                        Optional structured fields (details, steps[],
//                                        artifacts[], models[], followups[]) are composed
//                                        into a richer Markdown summary — see composeReport.
//
// Auth: deployed with verify_jwt=false, so the gateway checks nothing. Every
// action except `report` requires the ROUTINER_ADMIN_SECRET edge secret,
// presented as `x-routiner-secret: <secret>`. `schedule` writes a prompt the
// scheduler then fires into a Claude session with repo access, so an open
// endpoint let anyone holding the URL queue work for Claude. Unset secret →
// those actions are refused (fail closed), never opened. `report` stays open:
// every fired session and lead-enrichment post to it, and it only writes a
// History row.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ADMIN_SECRET = (Deno.env.get("ROUTINER_ADMIN_SECRET") || "").trim();
const GATED = new Set(["context", "schedule", "markNote", "targets", "addTarget", "unschedule"]);
// The Lead Finder lane: the only account `unschedule` may touch, so a planner
// can take its own searches down without being able to stop Claude routines.
const LEAD_ACCOUNT = "openrouter";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, apikey, x-routiner-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });

const H = () => ({ apikey: SERVICE_ROLE!, Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" });
const rest = (path: string) => `${SUPABASE_URL}/rest/v1/${path}`;

// Length-independent compare, so the response time says nothing about how much
// of a guess was right.
function sameSecret(given: string, want: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(want);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

const RECURRENCES = new Set(["none", "daily", "weekdays", "weekly"]);
const NOTE_STATUSES = new Set(["planned", "done", "dismissed"]);
const RUN_STATUSES = new Set(["success", "error", "missed", "ran"]);

// Compose a rich Markdown run report from a report body. Every field is
// optional except that the caller guarantees a non-empty `summary`; missing or
// empty sections are skipped so a bare {summary} still reads as one paragraph.
// The result is stored in routiner_runs.output and rendered in the app History.
function composeReport(body: Record<string, unknown>): string {
  const sections: string[] = [];

  if (typeof body.summary === "string") {
    const summary = body.summary.trim();
    if (summary) sections.push(summary);
  }

  if (typeof body.details === "string") {
    const details = body.details.trim();
    if (details) sections.push(details);
  }

  if (Array.isArray(body.steps)) {
    const steps = body.steps
      .filter((s) => typeof s === "string").map((s) => (s as string).trim()).filter(Boolean);
    if (steps.length) sections.push("**Steps**\n\n" + steps.map((s, i) => `${i + 1}. ${s}`).join("\n"));
  }

  if (Array.isArray(body.artifacts)) {
    const artifacts = body.artifacts
      .map((a) => {
        if (typeof a === "string") return a.trim() || null;
        if (a && typeof a === "object" && "url" in a) {
          const url = typeof (a as { url: unknown }).url === "string" ? (a as { url: string }).url.trim() : "";
          if (!url) return null;
          const label = typeof (a as { label?: unknown }).label === "string" ? (a as { label: string }).label.trim() : "";
          return label ? `[${label}](${url})` : url;
        }
        return null;
      })
      .filter((a): a is string => a !== null);
    if (artifacts.length) sections.push("**Artifacts**\n\n" + artifacts.map((a) => `- ${a}`).join("\n"));
  }

  if (Array.isArray(body.models)) {
    const models = body.models
      .filter((m) => typeof m === "string").map((m) => (m as string).trim()).filter(Boolean);
    if (models.length) sections.push("**Models used**\n\n" + models.map((m) => `- ${m}`).join("\n"));
  }

  if (Array.isArray(body.followups)) {
    const followups = body.followups
      .filter((f) => typeof f === "string").map((f) => (f as string).trim()).filter(Boolean);
    if (followups.length) sections.push("**Follow-ups**\n\n" + followups.map((f) => `- ${f}`).join("\n"));
  }

  return sections.join("\n\n").trim();
}

// Whitelist + NOT-NULL defaults for an inserted routine block.
function cleanBlock(b: Record<string, unknown>, ownerUserId: string) {
  const str = (v: unknown, d = "") => (typeof v === "string" && v.trim() ? v.trim() : d);
  const title = str(b.title);
  const prompt = str(b.prompt);
  const account = str(b.account);
  if (!title || !prompt || !account) return { error: "Each block needs non-empty title, prompt, and account." };
  const rec = str(b.recurrence, "none");
  const durRaw = Number(b.duration_min);
  return {
    row: {
      user_id: ownerUserId,
      account,
      trigger_key: typeof b.trigger_key === "string" && b.trigger_key.trim() ? b.trigger_key.trim() : null,
      title,
      prompt,
      model: str(b.model, "auto"),
      task_type: str(b.task_type, "general"),
      complexity: str(b.complexity, "medium"),
      recurrence: RECURRENCES.has(rec) ? rec : "none",
      status: "scheduled", // forced — this endpoint only schedules
      scheduled_at: typeof b.scheduled_at === "string" ? b.scheduled_at : null,
      duration_min: Number.isFinite(durRaw) && durRaw > 0 ? Math.round(durRaw) : 30,
    },
  };
}

async function resolveOwner(): Promise<string | null> {
  for (const path of [
    "routiner_routines?select=user_id&limit=1",
    "routiner_notes?select=user_id&limit=1",
    "routiner_settings?select=user_id&limit=1",
  ]) {
    const r = await fetch(rest(path), { headers: H() });
    if (r.ok) { const rows = await r.json(); if (rows?.[0]?.user_id) return rows[0].user_id; }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: cors });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json({ ok: false, error: "Service role not available in this environment." }, 500);

  let body: Record<string, unknown> = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { /* ignore */ } }
  const action = String(body.action || new URL(req.url).searchParams.get("action") || "context");

  if (GATED.has(action)) {
    if (!ADMIN_SECRET) {
      return json({ ok: false, error: `'${action}' is disabled: set the ROUTINER_ADMIN_SECRET edge secret, and give callers the same value as $ROUTINER_ADMIN_SECRET.` }, 503);
    }
    if (!sameSecret((req.headers.get("x-routiner-secret") || "").trim(), ADMIN_SECRET)) {
      return json({ ok: false, error: `Unauthorized: '${action}' needs the x-routiner-secret header (the ROUTINER_ADMIN_SECRET value; plan-routines sends $ROUTINER_ADMIN_SECRET).` }, 401);
    }
  }

  try {
    if (action === "context") {
      const [ownerUserId, notesR, schedR, setR] = await Promise.all([
        resolveOwner(),
        fetch(rest("routiner_notes?select=id,body,status&status=eq.active&order=created_at"), { headers: H() }),
        fetch(rest("routiner_routines?select=id,title,account,trigger_key,status,recurrence,scheduled_at,model&status=eq.scheduled&order=scheduled_at"), { headers: H() }),
        fetch(rest("routiner_settings?select=accounts&limit=1"), { headers: H() }),
      ]);
      const activeNotes = notesR.ok ? await notesR.json() : [];
      const scheduled = schedR.ok ? await schedR.json() : [];
      const settings = setR.ok ? await setR.json() : [];
      // Strip secrets: the planner needs lane ids/labels only — never the fire
      // tokens or URLs (this endpoint is reachable with the public key).
      const raw = settings?.[0]?.accounts ?? [];
      const accounts = Array.isArray(raw) ? raw.map((a: Record<string, unknown>) => ({
        id: a["id"], label: a.label,
        triggers: Array.isArray(a.triggers) ? a.triggers.map((t: Record<string, unknown>) => ({ id: t["id"], label: t.label })) : [],
      })) : [];
      return json({ ok: true, ownerUserId, activeNotes, scheduled, accounts });
    }

    if (action === "schedule") {
      const blocks = Array.isArray(body.blocks) ? body.blocks : [];
      if (!blocks.length) return json({ ok: false, error: "Provide a non-empty 'blocks' array." }, 400);
      const ownerUserId = await resolveOwner();
      if (!ownerUserId) return json({ ok: false, error: "Could not resolve owner user_id (no existing rows)." }, 500);

      const rows = [];
      for (const b of blocks) {
        const c = cleanBlock(b as Record<string, unknown>, ownerUserId);
        if ("error" in c) return json({ ok: false, error: c.error }, 400);
        rows.push(c.row);
      }
      const r = await fetch(rest("routiner_routines"), {
        method: "POST",
        headers: { ...H(), Prefer: "return=representation" },
        body: JSON.stringify(rows),
      });
      const data = await r.json();
      if (!r.ok) return json({ ok: false, error: data?.message || `Insert failed (HTTP ${r.status})`, detail: data }, 502);
      // Bracket access on "id" dodges markdown autolinkers that mangle x.id (".id" is a TLD).
      return json({ ok: true, inserted: data.map((x: Record<string, unknown>) => ({ id: x["id"], title: x.title, account: x.account, trigger_key: x.trigger_key, scheduled_at: x.scheduled_at })) });
    }

    if (action === "markNote") {
      const id = String(body["id"] || "");
      const status = String(body.status || "");
      if (!id) return json({ ok: false, error: "Missing note 'id'." }, 400);
      if (!NOTE_STATUSES.has(status)) return json({ ok: false, error: "status must be planned|done|dismissed." }, 400);
      const r = await fetch(rest(`routiner_notes?id=eq.${encodeURIComponent(id)}`), {
        method: "PATCH",
        headers: { ...H(), Prefer: "return=representation" },
        body: JSON.stringify({ status }),
      });
      const data = await r.json();
      if (!r.ok) return json({ ok: false, error: data?.message || `Update failed (HTTP ${r.status})` }, 502);
      return json({ ok: true, updated: data });
    }

    if (action === "targets") {
      // The grid, plus what each cell has yielded, so a planner can pick the
      // next searches without SQL. A cell is "spent" once a run finds mostly
      // duplicates; never-run cells come first, then the stalest productive ones.
      const [tR, sR] = await Promise.all([
        fetch(rest("lead_enrichment_targets?select=id,label,niche,location,target_vertical,count,enabled,last_run_at,last_result&order=label"), { headers: H() }),
        fetch(rest(`routiner_routines?select=id,prompt,recurrence,scheduled_at&status=eq.scheduled&account=eq.${LEAD_ACCOUNT}`), { headers: H() }),
      ]);
      if (!tR.ok) return json({ ok: false, error: `targets read failed (HTTP ${tR.status})` }, 502);
      // deno-lint-ignore no-explicit-any
      const rows = (await tR.json()) as Record<string, any>[];
      // deno-lint-ignore no-explicit-any
      const sched = sR.ok ? ((await sR.json()) as Record<string, any>[]) : [];
      const targets = rows.map((t) => {
        const lr = (t.last_result ?? null) as Record<string, unknown> | null;
        const inserted = Number(lr?.inserted ?? 0);
        const skipped = Number(lr?.skipped ?? 0);
        const found = inserted + skipped;
        const state = !t.last_run_at ? "never_run"
          : lr?.error ? "error"
          : found > 0 && inserted / found < 0.25 ? "spent"
          : "productive";
        const routine = sched.find((r) => String(r.prompt || "").includes(String(t["id"])));
        return {
          id: t["id"], label: t.label, niche: t.niche, location: t.location, vertical: t.target_vertical,
          count: t.count, last_run_at: t.last_run_at, last_inserted: lr ? inserted : null,
          last_skipped: lr ? skipped : null, state,
          scheduled: routine ? { routineId: routine["id"], recurrence: routine.recurrence, next: routine.scheduled_at } : null,
        };
      });
      const rank: Record<string, number> = { never_run: 0, productive: 1, error: 2, spent: 3 };
      targets.sort((a, b) =>
        (rank[a.state] - rank[b.state]) ||
        String(a.last_run_at ?? "").localeCompare(String(b.last_run_at ?? "")));
      return json({ ok: true, targets });
    }

    if (action === "addTarget") {
      const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
      const niche = str(body.niche);
      const location = str(body.location);
      if (!niche || !location) return json({ ok: false, error: "addTarget needs 'niche' and 'location' (one niche, one city)." }, 400);
      const label = str(body.label) || `${niche} — ${location}`;
      const dup = await fetch(
        rest(`lead_enrichment_targets?select=id&niche=ilike.${encodeURIComponent(niche)}&location=ilike.${encodeURIComponent(location)}&limit=1`),
        { headers: H() },
      );
      const existing = dup.ok ? await dup.json() : [];
      if (existing?.[0]) return json({ ok: true, existed: true, id: existing[0]["id"] });
      const countRaw = Number(body.count);
      const titles = Array.isArray(body.dmTitles)
        ? (body.dmTitles as unknown[]).filter((x) => typeof x === "string" && x.trim()).map((x) => (x as string).trim())
        : ["Owner", "Practice Manager", "Office Manager"];
      const r = await fetch(rest("lead_enrichment_targets"), {
        method: "POST",
        headers: { ...H(), Prefer: "return=representation" },
        body: JSON.stringify({
          label, niche, location,
          target_vertical: str(body.vertical) || null,
          // ≤ 10: asking sonar-pro for more pads the list with made-up businesses.
          count: Number.isFinite(countRaw) && countRaw > 0 ? Math.min(Math.round(countRaw), 10) : 8,
          dm_titles: titles,
          model: "perplexity/sonar-pro",
          recurrence: "weekly",
          sync_abstrax: false,
          // Left off so "run every enabled target" sweeps never pick it up by
          // surprise; a routine fires it by targetId.
          enabled: false,
          notes: str(body.notes) || "Added by a planner via routiner-admin addTarget.",
        }),
      });
      const data = await r.json();
      if (!r.ok) return json({ ok: false, error: data?.message || `Insert failed (HTTP ${r.status})` }, 502);
      return json({ ok: true, id: data?.[0]?.["id"], label });
    }

    if (action === "unschedule") {
      const id = String(body.routineId || body["id"] || "").trim();
      if (!id) return json({ ok: false, error: "Missing 'routineId'." }, 400);
      const r = await fetch(
        rest(`routiner_routines?id=eq.${encodeURIComponent(id)}&account=eq.${LEAD_ACCOUNT}&status=eq.scheduled`),
        {
          method: "PATCH",
          headers: { ...H(), Prefer: "return=representation" },
          body: JSON.stringify({ status: "library", scheduled_at: null }),
        },
      );
      const data = await r.json();
      if (!r.ok) return json({ ok: false, error: data?.message || `Update failed (HTTP ${r.status})` }, 502);
      if (!Array.isArray(data) || !data.length) {
        return json({ ok: false, error: `No scheduled Lead Finder routine with id ${id} (only account "${LEAD_ACCOUNT}" can be unscheduled here).` }, 404);
      }
      return json({ ok: true, unscheduled: { id: data[0]["id"], title: data[0].title } });
    }

    if (action === "report") {
      // A fired session reports back what it did; we log it as a run row so it
      // surfaces in the app's History. Keyed by routineId (to inherit user_id +
      // title); routineId may be null for a free-standing note.
      const routineId = String(body.routineId || body["routine_id"] || "").trim();
      const summary = typeof body.summary === "string" ? body.summary
        : (typeof body.output === "string" ? body.output : "");
      const statusRaw = String(body.status || "success");
      const status = RUN_STATUSES.has(statusRaw) ? statusRaw : "success";
      if (!summary.trim()) return json({ ok: false, error: "Missing 'summary'." }, 400);
      // Compose summary + any optional structured fields into one Markdown report.
      const output = composeReport({ ...body, summary });

      let userId: string | null = null;
      let title = typeof body.title === "string" ? body.title.trim() : "";
      if (routineId) {
        const rr = await fetch(
          rest(`routiner_routines?id=eq.${encodeURIComponent(routineId)}&select=user_id,title&limit=1`),
          { headers: H() },
        );
        const rows = rr.ok ? await rr.json() : [];
        if (!rows?.[0]) return json({ ok: false, error: "Routine not found for routineId." }, 404);
        userId = rows[0].user_id;
        title = title || rows[0].title || "";
      } else {
        userId = await resolveOwner();
      }
      if (!userId) return json({ ok: false, error: "Could not resolve owner user_id." }, 500);

      const r = await fetch(rest("routiner_runs"), {
        method: "POST",
        headers: { ...H(), Prefer: "return=representation" },
        body: JSON.stringify({
          user_id: userId,
          routine_id: routineId || null,
          title,
          status,
          output: output.slice(0, 4000),
        }),
      });
      const data = await r.json();
      if (!r.ok) return json({ ok: false, error: data?.message || `Insert failed (HTTP ${r.status})` }, 502);
      return json({ ok: true, run: Array.isArray(data) ? data[0] : data });
    }

    return json({ ok: false, error: `Unknown action '${action}'. Use context | schedule | markNote | targets | addTarget | unschedule | report.` }, 400);
  } catch (e) {
    return json({ ok: false, error: "routiner-admin failed: " + (e as Error).message }, 500);
  }
});
