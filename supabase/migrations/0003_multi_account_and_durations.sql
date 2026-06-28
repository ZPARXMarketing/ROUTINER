-- Multi-account routine selector + per-routine block durations.
-- `account` tags which connected Claude account a routine fires against;
-- `duration_min` is how long its block occupies on the calendar.

alter table public.routiner_routines
  add column if not exists account text not null default 'sparks9679';

alter table public.routiner_routines
  add column if not exists duration_min integer not null default 45;
