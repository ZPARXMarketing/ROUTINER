-- Routines target a specific trigger (instance) within an account.
-- `trigger_key` references the trigger's id inside routiner_settings.accounts.
-- Null = use the account's first trigger.

alter table public.routiner_routines
  add column if not exists trigger_key text;
