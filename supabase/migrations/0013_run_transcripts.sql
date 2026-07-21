-- 0013_run_transcripts.sql
-- Make a run row a resumable conversation, not just a one-shot output blob.
--
-- Before: routiner_runs stored only the final `output` text. History/Log could
-- show what a run said, but you couldn't see the full back-and-forth or continue
-- it (issues #51, #52). Now the openrouter-agent function persists the whole
-- transcript plus the context needed to resume it (model, account, trigger,
-- enabled tools), so the app can reopen any agent run and keep chatting — with
-- the same tools — from where it left off.
alter table public.routiner_runs
  add column if not exists messages    jsonb,          -- full message transcript (system/user/assistant/tool); null for legacy + non-agent runs
  add column if not exists model       text,           -- the OpenRouter model id the run used (null for Claude-trigger runs)
  add column if not exists account     text,           -- account id, so a continuation resolves the same key
  add column if not exists trigger_key text,           -- trigger/instance key within the account
  add column if not exists tools       jsonb;          -- enabled tool groups, e.g. ["read","research","write"]
