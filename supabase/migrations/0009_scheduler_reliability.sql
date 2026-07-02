-- Scheduler reliability.
--
-- retry_count: how many times the scheduler has re-armed a *one-off* routine
-- after a failed fire. It backs off and gives up after a few attempts, instead
-- of silently losing the run (the old behaviour retired one-offs to the library
-- before firing, so a failed fire never ran again). Recurring routines don't use
-- this — their next occurrence already stands.
--
-- tz: the IANA timezone the routine's local time is anchored to (e.g.
-- "America/New_York"). When set, the scheduler computes the next daily/weekly
-- occurrence at the same wall-clock time in that zone, so a "9am daily" routine
-- stays at 9am across DST changes instead of drifting an hour. NULL = legacy
-- UTC-day arithmetic (unchanged behaviour for pre-existing routines).

alter table public.routiner_routines
  add column if not exists retry_count integer not null default 0,
  add column if not exists tz          text;
