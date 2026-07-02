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
//   POST      action=report  routineId,summary,status? → logs a run row so a fired
//                                        session can report back what it did (shows in History)
//
// Auth: deployed with verify_jwt=false (like dynamic-responder); the public
// publishable key gates it at the gateway. Writes are constrained to the
// actions/fields below. Tighten with a shared token if you ever need to.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, apikey",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });

const H = () => ({ apikey: SERVICE_ROLE!, Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" });
const rest = (path: string) => `${SUPABASE_URL}/rest/v1/${path}`;

const RECURRENCES = new Set(["none", "daily", "weekdays", "weekly"]);
const NOTE_STATUSES = new Set(["planned", "done", "dismissed"]);
const RUN_STATUSES = new Set(["success", "error", "missed", "ran"]);

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
          output: String(summary).slice(0, 4000),
        }),
      });
      const data = await r.json();
      if (!r.ok) return json({ ok: false, error: data?.message || `Insert failed (HTTP ${r.status})` }, 502);
      return json({ ok: true, run: Array.isArray(data) ? data[0] : data });
    }

    return json({ ok: false, error: `Unknown action '${action}'. Use context | schedule | markNote | report.` }, 400);
  } catch (e) {
    return json({ ok: false, error: "routiner-admin failed: " + (e as Error).message }, 500);
  }
});
