-- OpenRouter usage meter — a per-call ledger of tokens + cost.
--
-- The `dynamic-responder` edge proxy writes one row here after each OpenRouter
-- completion (best-effort, never blocking the response), and the
-- `openrouter-usage` edge function reads it to render daily / monthly / all-time
-- totals next to the live credit balance from OpenRouter's /api/v1/key.
--
-- These rows are NOT per-user: the proxy is a shared, unauthenticated endpoint
-- (verify_jwt=false), so there is no auth.uid() at write time. RLS is enabled
-- with NO policy, which means only the service role (i.e. the edge functions)
-- can read or write — clients never touch this table directly; they go through
-- the openrouter-usage function.

create table if not exists public.routiner_openrouter_usage (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  model             text not null default '',          -- model id OpenRouter actually served
  prompt_tokens     integer not null default 0,
  completion_tokens integer not null default 0,
  total_tokens      integer not null default 0,
  cost              numeric(12,6) not null default 0,   -- USD, from the completion's usage.cost
  account           text,                               -- optional attribution passed by the caller
  trigger_key       text,
  source            text not null default 'dynamic-responder'
);

create index if not exists routiner_openrouter_usage_created_idx
  on public.routiner_openrouter_usage(created_at desc);
create index if not exists routiner_openrouter_usage_model_idx
  on public.routiner_openrouter_usage(model);

-- Locked down: RLS on, no policies → service-role-only (the edge functions).
alter table public.routiner_openrouter_usage enable row level security;
