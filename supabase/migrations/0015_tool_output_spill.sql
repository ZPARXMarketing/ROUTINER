-- 0015_tool_output_spill.sql
-- Stop throwing away large tool output; store it and hand the model a locator.
--
-- Two knobs were in direct contradiction: AGENT_GH_READ_RESULT_CAP let one
-- gh_read_file return 120k chars, while AGENT_CONTEXT_TOOL_BUDGET kept only 60k
-- of tool output at full size. So a single large read was 2x the entire
-- full-fidelity budget, and reading two files guaranteed the first was floored
-- to a few hundred characters. The model would then re-read the file it had
-- already been given — which is the repeat loop the guard in openrouter-agent
-- exists to catch. Truncation was manufacturing the loop.
--
-- A spill row holds the FULL text once. The model's context gets a bounded
-- head/tail preview plus a spill id, and `read_spill` pages the rest on demand.
-- So "the file scrolled out of context" becomes a fetch instead of a loss, and
-- the transcript stops carrying multiple 100k-char blobs that are re-sent to
-- Postgres on every checkpoint.
--
-- Rows are owned like runs (RLS per user) so a signed-in reader can inspect what
-- their agent actually saw; the edge function writes with the service role.
-- They are disposable by construction: losing one costs a re-read, never work.

create table if not exists public.routiner_tool_spills (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id    uuid references auth.users(id) on delete cascade,
  run_id     uuid references public.routiner_runs(id) on delete cascade,
  tool_name  text not null default '',
  args       jsonb,                             -- the call that produced it, for provenance
  content    text not null default '',          -- the FULL tool result, unmodified
  chars      integer not null default 0         -- code-point length of `content` at write time
);

create index if not exists routiner_tool_spills_run_idx
  on public.routiner_tool_spills(run_id, created_at desc);
create index if not exists routiner_tool_spills_user_idx
  on public.routiner_tool_spills(user_id);

alter table public.routiner_tool_spills enable row level security;

drop policy if exists "own spills" on public.routiner_tool_spills;
create policy "own spills" on public.routiner_tool_spills
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
