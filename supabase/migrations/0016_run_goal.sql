-- 0016_run_goal.sql
-- Give a run an objective that survives compaction.
--
-- A run spans up to six edge invocations. Between them the only thing carrying
-- intent forward is the transcript — and the transcript is exactly what gets
-- compacted: old tool results are floored to a few hundred characters, so by
-- segment four the model's evidence of what it already tried is mostly gone.
-- AUTO_CONTINUE_PROMPT then says "resume the task from the transcript", which is
-- asking the model to reconstruct its plan from the part we deleted.
--
-- `goal` is small, structured, and never compacted:
--   { objective, done: [...], remaining: [...], phase, blocked_reason }
--
-- `phase` is the durable answer to "what happened to the objective":
--   active | blocked | complete
-- `blocked_reason.code` is a machine-routable classification (e.g.
-- 'key-exhausted', 'needs-human'), so a stuck run can be recognised as stuck by
-- the scheduler and the UI instead of each next segment re-deriving it from
-- prose. That distinction is the whole lesson of the "instructions that can
-- dead-end will dead-end" note in CLAUDE.md: a blocked run should be a state,
-- not a sentence someone has to read.
alter table public.routiner_runs add column if not exists goal jsonb;

comment on column public.routiner_runs.goal is
  'Durable objective for a multi-segment agent run: {objective, done[], remaining[], phase, blocked_reason{code,message}}. Never compacted, unlike messages.';
