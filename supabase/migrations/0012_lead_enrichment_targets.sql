-- ============================================================================
-- 0012_lead_enrichment_targets.sql
--
-- ICP config for the autonomous lead-enrichment flywheel. Each row is a
-- "who to go find" target — a niche × location cell, how many leads to pull,
-- which decision-maker titles to look for, and which Perplexity model to use.
-- The `lead-enrichment` edge function reads the ENABLED rows, runs Perplexity
-- deep research per cell, and drops enriched, de-duped prospects straight into
-- Command's `staged_leads` (the Review tab) — no Claude in the hot path.
--
-- Edit these rows in Supabase (or a small Command admin surface) to steer the
-- machine; nothing here is invented on your behalf. Seeded rows are DISABLED
-- so the flywheel only spins once you turn a target on.
--
-- Lives on the zparx-dashboard project alongside routiner_* and staged_leads.
-- ============================================================================

create table if not exists public.lead_enrichment_targets (
  id               uuid primary key default gen_random_uuid(),
  -- Human label for the target, e.g. "Chiropractors — Huntsville".
  label            text not null default '',
  -- The niche/industry to search, e.g. "chiropractic clinics". Required.
  niche            text not null,
  -- City/metro (and state) to scope to, e.g. "Huntsville, AL". Null = nationwide.
  location         text,
  -- Niche key stored on the lead (staged_leads.vertical / contacts.vertical),
  -- e.g. "chiropractic". Defaults to `niche` when left blank.
  target_vertical  text,
  -- How many leads to request per run for this cell (bounded in the function).
  count            integer not null default 10,
  -- Decision-maker title hints, e.g. {Owner,"Lead DC","Office Manager"}.
  dm_titles        text[] not null default '{}',
  -- OpenRouter model for the research pass. sonar-pro balances depth vs the
  -- edge function's sync deadline; bump to perplexity/sonar-deep-research for
  -- the heaviest research (needs the async path — see docs/LEAD_ENRICHMENT.md).
  model            text not null default 'perplexity/sonar-pro',
  -- How often this target should run — advisory metadata the scheduler/cron and
  -- the Routiner routine read. none | daily | weekdays | weekly.
  recurrence       text not null default 'weekly',
  -- Also mirror each lead into Abstrax `competitors` (RoiCal) as a prospect.
  -- Requires the ROICAL_SERVICE_ROLE_KEY edge secret; a no-op until it's set.
  sync_abstrax     boolean not null default false,
  -- Master switch. The function ignores disabled rows.
  enabled          boolean not null default false,
  notes            text,
  -- Bookkeeping written back by the function after each run.
  last_run_at      timestamptz,
  last_result      jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists lead_enrichment_targets_enabled_idx
  on public.lead_enrichment_targets (enabled) where enabled;

alter table public.lead_enrichment_targets
  drop constraint if exists lead_enrichment_targets_recurrence_check;
alter table public.lead_enrichment_targets
  add constraint lead_enrichment_targets_recurrence_check
  check (recurrence in ('none', 'daily', 'weekdays', 'weekly'));

-- RLS parity with staged_leads (0026 in Command): the authed operator has full
-- access; the edge function writes with the service role and bypasses RLS.
alter table public.lead_enrichment_targets enable row level security;

do $$
begin
  create policy "authed full access" on public.lead_enrichment_targets
    for all to authenticated
    using (auth.role() = 'authenticated')
    with check (auth.role() = 'authenticated');
exception
  when duplicate_object then null;
end $$;

-- Two DISABLED example targets so the shape is obvious and editable in-place.
-- They produce nothing until you set enabled = true (and adjust to your ICP).
insert into public.lead_enrichment_targets
  (label, niche, location, target_vertical, count, dm_titles, model, recurrence, notes)
select * from (values
  ('EXAMPLE — Chiropractors (Huntsville)', 'chiropractic clinics', 'Huntsville, AL',
   'chiropractic', 10, array['Owner','Lead DC','Office Manager'],
   'perplexity/sonar-pro', 'weekly',
   'Disabled example. Edit to your real ICP, then set enabled = true.'),
  ('EXAMPLE — Med spas (Nashville)', 'medical spas', 'Nashville, TN',
   'medspa', 10, array['Owner','Medical Director','Practice Manager'],
   'perplexity/sonar-pro', 'weekly',
   'Disabled example. Edit to your real ICP, then set enabled = true.')
) as seed(label, niche, location, target_vertical, count, dm_titles, model, recurrence, notes)
where not exists (select 1 from public.lead_enrichment_targets);
