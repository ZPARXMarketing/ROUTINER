-- Single source of truth for auto-routing (#29 item 2).
--
-- The app (js/model-router.js) and the scheduler (routiner-scheduler) each
-- carried a hand-synced copy of ROUTING_POLICY. This column lets a user store
-- one policy that BOTH read: the app applies it to its previews/cards, and the
-- scheduler routes `auto` fires with the owning user's policy. NULL (or a
-- malformed value) → both fall back to the built-in default, so existing
-- installs behave exactly as before until a policy is saved from Settings.
--
-- Shape: { "<task_type>": { "<complexity>": "<model-id>", … }, … }
--   e.g. { "planning": {"low":"claude-sonnet-5","medium":"claude-sonnet-5","high":"claude-opus-4-8"}, … }

alter table public.routiner_settings
  add column if not exists model_policy jsonb;
