-- Claude Routine Planner — full database schema (one-paste setup).
--
-- Forking this project? Create a free Supabase project, open the SQL editor,
-- and paste this whole file. It creates every table the app needs with
-- row-level security so each signed-in user only ever sees their own rows.
-- Idempotent: safe to re-run. (This is the consolidated equivalent of the
-- files in supabase/migrations/. The pg_cron scheduler is optional and lives
-- in supabase/migrations/0002_routiner_scheduler.sql + supabase/functions/.)

-- ── Routines ─────────────────────────────────────────────────────────────
create table if not exists public.routiner_routines (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title        text not null default '',
  prompt       text not null default '',
  model        text not null default 'auto',          -- 'auto' = route by task_type+complexity (js/model-router.js); else a model id
  task_type    text not null default 'general',       -- general | planning | execution (auto routing input)
  complexity   text not null default 'medium',        -- low | medium | high (auto routing input)
  account      text not null default 'sparks9679',   -- which Claude account fires it
  trigger_key  text,                                  -- which trigger (instance) within that account; null = first
  recurrence   text not null default 'none',         -- none | daily | weekdays | weekly
  status       text not null default 'library',      -- library | scheduled | archived
  duration_min integer not null default 45,          -- calendar block length
  scheduled_at timestamptz,
  last_run     timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ── Run history ──────────────────────────────────────────────────────────
create table if not exists public.routiner_runs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  routine_id uuid references public.routiner_routines(id) on delete set null,
  title      text not null default '',
  status     text not null default 'success',
  output     text not null default '',
  fired_at   timestamptz not null default now()
);

-- ── Per-user accounts + triggers (set in-app via Settings) ───────────────
-- accounts is a list of accounts, each holding one or more triggers:
--   [ { "id": "...", "label": "...",
--       "triggers": [ { "id": "...", "label": "A", "trigger": "...", "token": "..." } ] } ]
-- (An older flat map { "<accountId>": { "trigger", "token" } } is still read.)
-- The Netlify claude-trigger function resolves a routine's account + trigger_key
-- to one trigger and fires it, server-side via the caller's own access token —
-- so users configure everything in the app with no environment variables.
create table if not exists public.routiner_settings (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  accounts   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── Board: the intake the human drops notes into for Claude to plan from ──
create table if not exists public.routiner_notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body       text not null default '',
  status     text not null default 'brainstorm', -- active | brainstorm | planned | done | dismissed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists routiner_routines_user_idx on public.routiner_routines(user_id);
create index if not exists routiner_runs_user_idx     on public.routiner_runs(user_id);
create index if not exists routiner_notes_user_idx    on public.routiner_notes(user_id);

-- ── Row-level security: every user is scoped to their own rows ───────────
alter table public.routiner_routines enable row level security;
alter table public.routiner_runs     enable row level security;
alter table public.routiner_settings enable row level security;
alter table public.routiner_notes    enable row level security;

drop policy if exists "own routines" on public.routiner_routines;
create policy "own routines" on public.routiner_routines
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own runs" on public.routiner_runs;
create policy "own runs" on public.routiner_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own settings" on public.routiner_settings;
create policy "own settings" on public.routiner_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own notes" on public.routiner_notes;
create policy "own notes" on public.routiner_notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── Keep updated_at fresh on edit ────────────────────────────────────────
create or replace function public.routiner_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

drop trigger if exists routiner_routines_touch on public.routiner_routines;
create trigger routiner_routines_touch before update on public.routiner_routines
  for each row execute function public.routiner_touch_updated_at();

drop trigger if exists routiner_notes_touch on public.routiner_notes;
create trigger routiner_notes_touch before update on public.routiner_notes
  for each row execute function public.routiner_touch_updated_at();
