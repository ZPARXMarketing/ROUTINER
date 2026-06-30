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
