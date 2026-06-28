-- Board: free-form notes the user drops as intake for Claude to plan from.

create table if not exists public.routiner_notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body       text not null default '',
  status     text not null default 'brainstorm', -- active | brainstorm | planned | done | dismissed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists routiner_notes_user_idx on public.routiner_notes(user_id);

alter table public.routiner_notes enable row level security;

drop policy if exists "own notes" on public.routiner_notes;
create policy "own notes" on public.routiner_notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop trigger if exists routiner_notes_touch on public.routiner_notes;
create trigger routiner_notes_touch before update on public.routiner_notes
  for each row execute function public.routiner_touch_updated_at();
