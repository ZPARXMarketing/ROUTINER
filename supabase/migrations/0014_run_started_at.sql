-- Runs carried a single timestamp, fired_at, which the agent bumps at every
-- checkpoint (and again on each reply). So it means "last activity", not
-- "started": History could say when a run last did something, but never when it
-- began or how long it took — a 40-minute run and a 4-second one looked alike.
--
-- Add an immutable start stamp. Existing rows deliberately stay NULL: their real
-- start was never recorded, and the UI shows no duration for them rather than a
-- made-up one. New rows get it from the column default, so no edge function has
-- to change for this to start working.
alter table public.routiner_runs add column if not exists started_at timestamptz;
alter table public.routiner_runs alter column started_at set default now();

create index if not exists routiner_runs_started_idx
  on public.routiner_runs(started_at desc);
