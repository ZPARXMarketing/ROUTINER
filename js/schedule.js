/* ============================================================
   Recurrence projection for Routiner schedules.

   Pure date logic — no DOM, no imports — so the Calendar, the drawer
   preview, and any tooling can share one source of truth for "when does
   this routine fire next". Recurrence is one of: 'none' | 'daily' |
   'weekdays' | 'weekly'.

   Drafted by GLM 4.7 via the dynamic-responder OpenRouter proxy, then
   reviewed: unknown recurrence values are normalized to 'none' (otherwise
   the loop never advances and repeats the seed), and the markdown fence the
   model emitted was stripped.
   ============================================================ */

const REPEATABLE = ['daily', 'weekdays', 'weekly'];

/* The next `count` fire times strictly after `fromMs`, as ISO strings.
   Preserves the seed's time-of-day via local Date arithmetic. */
export function nextOccurrences(startIso, recurrence = 'none', count = 3, fromMs = Date.now()) {
  if (!startIso) return [];

  const current = new Date(startIso);
  if (isNaN(current.getTime())) return [];

  // Anything that isn't a known repeat fires exactly once (the seed).
  const rec = REPEATABLE.includes(recurrence) ? recurrence : 'none';

  const result = [];
  const maxIterations = 10000; // safety cap against an unexpected infinite loop

  // Normalize seed for weekdays: if it lands on Sat/Sun, roll to next Monday.
  if (rec === 'weekdays') {
    const day = current.getDay();
    if (day === 6) current.setDate(current.getDate() + 2);      // Saturday → Monday
    else if (day === 0) current.setDate(current.getDate() + 1); // Sunday   → Monday
  }

  for (let iterations = 0; iterations < maxIterations; iterations++) {
    if (current.getTime() > fromMs) {
      result.push(current.toISOString());
      if (result.length >= count) break;
    }

    if (rec === 'none') break;

    if (rec === 'daily') {
      current.setDate(current.getDate() + 1);
    } else if (rec === 'weekly') {
      current.setDate(current.getDate() + 7);
    } else { // weekdays
      current.setDate(current.getDate() + 1);
      const d = current.getDay();
      if (d === 6) current.setDate(current.getDate() + 2);      // skip Saturday
      else if (d === 0) current.setDate(current.getDate() + 1); // skip Sunday
    }
  }

  return result;
}

/* The single next fire time after `fromMs`, or null. */
export function nextOccurrence(startIso, recurrence = 'none', fromMs = Date.now()) {
  return nextOccurrences(startIso, recurrence, 1, fromMs)[0] ?? null;
}

/* ------------------------------------------------------------------
   Labor division: spread a batch of tasks across parallel lanes.

   `planSchedule` is greedy list-scheduling of a dependency DAG onto N
   lanes (an account's triggers are the lanes — each fires as its own
   parallel session). It hands back, for every task, which lane runs it
   and when, packing work to finish as early as possible while never
   starting a task before the ones it depends on have finished.

   tasks : [{ id, durationMin = 30, dependsOn = [] }]   (dependsOn = ids that must FINISH first)
   lanes : ['A','B',...]  parallel lanes; empty → one lane
   opts  : { startMs = Date.now(), gapMin = 0 }  gapMin = idle buffer between two
           tasks in the SAME lane.

   → { assignments: [{ taskId, lane, startIso, endIso, durationMin }],
       makespanIso, unplaced: [ids unschedulable due to missing/cyclic deps] }
   ------------------------------------------------------------------ */
const MS_PER_MIN = 60000;

export function planSchedule(tasks, lanes, opts = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) return { assignments: [], makespanIso: null, unplaced: [] };

  const startMs = Number.isFinite(opts.startMs) ? opts.startMs : Date.now();
  const gapMs = Math.max(0, Number(opts.gapMin) || 0) * MS_PER_MIN;
  const laneList = Array.isArray(lanes) && lanes.length ? lanes.slice() : ['_'];

  const dur = (t) => { const n = Number(t && t.durationMin); return Number.isFinite(n) && n > 0 ? n : 30; };

  const laneFreeAt = new Map(laneList.map((l) => [l, startMs]));
  const laneUsed = new Map(laneList.map((l) => [l, false]));
  const finishAt = new Map();         // taskId → end ms (only placed tasks)
  const placed = new Set();
  const assignments = [];

  // A task is ready when every dependency is placed. A dependency on an id
  // that isn't in the batch can never be placed → that task stays unplaced.
  const ready = (t) => (t.dependsOn || []).every((d) => placed.has(d));

  let remaining = tasks.filter((t) => t && t.id != null);
  while (remaining.length) {
    const readyTasks = remaining.filter(ready);
    if (readyTasks.length === 0) break; // rest are blocked by missing/cyclic deps

    // Earliest-start, then longest task, then id — deterministic.
    const earliest = (t) => {
      const deps = t.dependsOn || [];
      return deps.length ? Math.max(...deps.map((d) => finishAt.get(d))) : startMs;
    };
    readyTasks.sort((a, b) =>
      earliest(a) - earliest(b) || dur(b) - dur(a) || String(a.id).localeCompare(String(b.id)));
    const task = readyTasks[0];

    // Lane that frees up soonest (ties: lane order).
    let lane = laneList[0];
    for (const l of laneList) if (laneFreeAt.get(l) < laneFreeAt.get(lane)) lane = l;

    const afterLane = laneFreeAt.get(lane) + (laneUsed.get(lane) ? gapMs : 0);
    const start = Math.max(afterLane, earliest(task));
    const end = start + dur(task) * MS_PER_MIN;

    assignments.push({ taskId: task.id, lane, startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString(), durationMin: dur(task) });
    laneFreeAt.set(lane, end);
    laneUsed.set(lane, true);
    finishAt.set(task.id, end);
    placed.add(task.id);
    remaining = remaining.filter((t) => t.id !== task.id);
  }

  assignments.sort((a, b) => a.startIso.localeCompare(b.startIso) || String(a.lane).localeCompare(String(b.lane)));
  const makespanMs = assignments.length ? Math.max(...assignments.map((a) => Date.parse(a.endIso))) : null;
  const unplaced = remaining.map((t) => t.id).sort();
  return { assignments, makespanIso: makespanMs != null ? new Date(makespanMs).toISOString() : null, unplaced };
}
