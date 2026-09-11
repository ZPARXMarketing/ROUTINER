-- Per-user model preferences: which slug a catalog model points at, and what
-- color it wears on the calendar.
--
-- Two problems this column solves, both from the outside:
--
-- 1. **Colors were an implementation detail.** A calendar block took its color
--    from the account + trigger that fired it, and the only way to know what a
--    color meant was a legend printed above the grid on every screen. Blocks are
--    colored by their MODEL now, which is the thing worth telling apart at a
--    glance, and the key moved into Settings — where, being a setting, it may as
--    well be editable.
--
-- 2. **Model slugs go stale and the app shipped them as constants.** Labs rename
--    and retire ids on their own schedule, so a catalog baked into js/ is wrong
--    the moment a provider moves, and the user's only recourse was to wait for a
--    release. A slug override here re-points a catalog row without a deploy.
--
-- Shape (both halves optional, keyed by the catalog's stable `key`, NOT by slug
-- — keying on the slug would mean renaming a model threw away its color):
--   { "slugs":  { "zai.fast": "z-ai/glm-4.9" },
--     "colors": { "zai.fast": "#BCEF2F" } }
--
-- Absent or null means "everything as shipped". The app validates on read, so a
-- stale key from an older catalog is ignored rather than breaking a picker, and
-- it keeps a browser-local copy — this column is a nicety, not a dependency: a
-- deployment that has not applied this migration still works, it just keeps the
-- preferences per browser instead of per account.
alter table public.routiner_settings add column if not exists model_prefs jsonb;

comment on column public.routiner_settings.model_prefs is
  'Per-user model overrides keyed by catalog key: {slugs:{key:slug}, colors:{key:#RRGGBB}}. Null = the shipped catalog. See js/model-router.js.';
