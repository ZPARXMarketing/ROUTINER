-- Dynamic model selection: routines can pin a model or set model='auto' and let
-- Routiner route by task type + complexity (see js/model-router.js). Adds the
-- two routing inputs and flips the default model to 'auto'.

alter table public.routiner_routines
  add column if not exists task_type  text not null default 'general',  -- general | planning | execution
  add column if not exists complexity text not null default 'medium';   -- low | medium | high

alter table public.routiner_routines
  alter column model set default 'auto';
