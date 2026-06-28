-- Per-user fire credentials, set in-app via Settings (no env vars needed).
-- `accounts` maps { "<accountId>": { "trigger": "...", "token": "..." } }.
-- The Netlify claude-trigger function reads these server-side using the
-- caller's own access token, so RLS keeps each user to their own row.

create table if not exists public.routiner_settings (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  accounts   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.routiner_settings enable row level security;

drop policy if exists "own settings" on public.routiner_settings;
create policy "own settings" on public.routiner_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
