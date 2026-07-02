-- Log failed OpenRouter calls too, so the usage meter can show failure rates
-- (previously only successful completions were recorded). `ok=false` rows carry
-- the error message and cost 0, so spend totals are unaffected while call/error
-- counts become visible.

alter table public.routiner_openrouter_usage
  add column if not exists ok    boolean not null default true,
  add column if not exists error text;
