-- Claude Routine Planner — tables, RLS, and updated_at trigger.
-- Applied to the `zparx-dashboard` Supabase project.

create table if not exists public.routiner_routines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default '',
  prompt text not null default '',
  model text not null default 'claude-sonnet-4-6',
  recurrence text not null default 'none',
  status text not null default 'library',
  scheduled_at timestamptz,
  last_run timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.routiner_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  routine_id uuid references public.routiner_routines(id) on delete set null,
  title text not null default '',
  status text not null default 'success',
  output text not null default '',
  fired_at timestamptz not null default now()
);

create index if not exists routiner_routines_user_idx on public.routiner_routines(user_id);
create index if not exists routiner_runs_user_idx on public.routiner_runs(user_id);

alter table public.routiner_routines enable row level security;
alter table public.routiner_runs enable row level security;

drop policy if exists "own routines" on public.routiner_routines;
create policy "own routines" on public.routiner_routines
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own runs" on public.routiner_runs;
create policy "own runs" on public.routiner_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.routiner_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

drop trigger if exists routiner_routines_touch on public.routiner_routines;
create trigger routiner_routines_touch before update on public.routiner_routines
  for each row execute function public.routiner_touch_updated_at();
