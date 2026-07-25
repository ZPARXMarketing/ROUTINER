# Lead Enrichment — the ZPARX lead flywheel

Autonomous, scheduled **Perplexity deep research → Command Review tab**. Fresh,
ICP-fit leads with a resolved decision-maker land in Command's Review tab with
**no Claude in the hot path** — the human just approves/rejects.

```
                 lead_enrichment_targets (your ICP, editable)
                              │
        schedule (pg_cron  ── OR ──  a Routiner routine)
                              ▼
        ┌───────────────────────────────────────────────┐
        │  lead-enrichment  (edge fn, zparx-dashboard)   │
        │  Perplexity via OpenRouter → parse → validate  │
        │  → de-dupe → insert                            │
        └───────────────┬───────────────┬───────────────┘
                        ▼               ▼ (optional, if target.sync_abstrax)
              staged_leads          competitors (RoiCal)
              = Command Review      = Abstrax prospect pipeline
                        │
                  human APPROVE → companies + contacts (live CRM)
```

Everything speaks one shape — the shared `EnrichedLead` contract in
`supabase/functions/_shared/lead-schema.ts` (Command mirror:
`command/src/types/enrichedLead.ts`; Abstrax mirror:
`abstrax-ad-intel/lib/leads/shared-schema.ts`). Same field names everywhere, so
populating one surface informs the others even across the two Supabase projects.

## The pieces (all in this repo)

| Piece | Path |
|---|---|
| ICP config table | `supabase/migrations/0012_lead_enrichment_targets.sql` |
| Engine (edge fn) | `supabase/functions/lead-enrichment/index.ts` |
| Shared contract | `supabase/functions/_shared/lead-schema.ts` |
| Parse + validators | `supabase/functions/_shared/lead-parse.ts` |

## One-time setup (human)

1. **Apply the migration** — creates `lead_enrichment_targets` (two DISABLED
   example rows). Via the Supabase MCP/CLI or SQL editor on **zparx-dashboard**
   (`vonfdzttupyemtomsojy`):
   ```
   supabase db push        # or paste 0012_…sql into the SQL editor
   ```
2. **Deploy the function** (needs no new secret — it reuses `OPENROUTER_API_KEY`,
   already set for `dynamic-responder`):
   ```
   supabase functions deploy lead-enrichment --no-verify-jwt
   ```
   The live deploy currently has **verify_jwt = true** (the MCP deploy default),
   so callers must send the project's anon key (`apikey` + `Authorization:
   Bearer`). To match `dynamic-responder`/`routiner-admin` and drop that header,
   redeploy with `--no-verify-jwt`. If you set `RESPONDER_SECRET`, callers must
   also send `x-responder-secret`.

   > **Deployed status:** as of this writing the migration is applied, the
   > function is live (v1), the four Huntsville ICP targets are seeded + enabled,
   > and one live run has already placed 17 leads in the Review tab. What remains
   > is turning on a recurring schedule (below) and, optionally, Abstrax sync.
3. **Define your ICP.** Edit `lead_enrichment_targets` — set real `niche`,
   `location`, `dm_titles`, `count`, and flip `enabled = true`:
   ```sql
   update public.lead_enrichment_targets
     set enabled = true
     where label = 'EXAMPLE — Chiropractors (Huntsville)';   -- after editing it
   -- or add your own:
   insert into public.lead_enrichment_targets
     (label, niche, location, target_vertical, count, dm_titles, enabled)
   values ('Roofers — Nashville', 'roofing contractors', 'Nashville, TN',
           'roofing', 12, array['Owner','GM'], true);
   ```
4. **Smoke-test** before scheduling anything (dry run — researches, parses,
   **inserts nothing**, returns a 3-lead sample):
   ```bash
   curl -s https://vonfdzttupyemtomsojy.supabase.co/functions/v1/lead-enrichment \
     -H 'content-type: application/json' \
     -d '{"niche":"chiropractic clinics","location":"Huntsville, AL","count":5,"dryRun":true}' | jq
   ```
   Happy with the sample? Drop `dryRun` to write the leads, then open Command →
   **Review** to see them.

## Turn on the schedule — pick ONE

### A) pg_cron (recommended — fully autonomous, zero Claude)

Runs the engine directly on a cadence. **This starts autonomous spend** — leave
it until you've smoke-tested. Requires `pg_cron` + `pg_net` (both available on
Supabase). Run once in the SQL editor on **zparx-dashboard**:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Weekly, Mondays 13:00 UTC: process every ENABLED target.
-- The function is deployed with verify_jwt=true, so pass the project's anon key
-- (a public publishable key — safe to inline). Alternatively redeploy with
-- --no-verify-jwt and drop the apikey/authorization headers.
select cron.schedule(
  'lead-enrichment-weekly',
  '0 13 * * 1',
  $$
  select net.http_post(
    url     := 'https://vonfdzttupyemtomsojy.supabase.co/functions/v1/lead-enrichment',
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'apikey', '<ANON_KEY>',
                 'authorization', 'Bearer <ANON_KEY>'
               ),
    body    := '{}'::jsonb
  );
  $$
);
-- Pause/remove later:  select cron.unschedule('lead-enrichment-weekly');
```

An empty body (`{}`) means "all enabled targets." A per-target cadence is just
another cron row with `{"targetId":"<uuid>"}` in the body.

### B) A Routiner routine (keeps scheduling on the Board/Calendar)

Add a scheduled routine whose prompt is a thin "call the engine, then stop" —
minimal Claude, no lead reasoning:

```
Trigger the lead-enrichment engine and report the result. Run exactly:
  curl -s https://vonfdzttupyemtomsojy.supabase.co/functions/v1/lead-enrichment \
    -H 'content-type: application/json' -d '{}'
Then post the returned JSON to routiner-admin as a report. Do nothing else.
```

Set `recurrence` (e.g. `weekly`) and schedule it like any other routine. The
engine still does all the work; the routine just kicks it and logs it.

> Either way, every run logs OpenRouter spend to `routiner_openrouter_usage`
> (visible in `usage.html` / `scripts/usage-meter.mjs`) and posts a recap to the
> Routiner **Log**.

## Abstrax sync (nice-to-have, off by default)

To also drop each lead into Abstrax's prospect pipeline (`competitors` on
RoiCal, `pipeline_status='prospect'`, `source='discovery'`):

1. Add the **RoiCal** service-role key as an edge secret on zparx-dashboard:
   `ROICAL_SERVICE_ROLE_KEY` (and optionally `ROICAL_URL`, defaults to the RoiCal
   project URL).
2. Set `sync_abstrax = true` on the target rows you want mirrored.

Without the key the mirror is a silent no-op — Command-only until you opt in.

## Model + cost

Per-target `model` (default `perplexity/sonar-pro`). Allowed:
`perplexity/sonar`, `sonar-pro`, `sonar-reasoning`, `sonar-reasoning-pro`,
`sonar-deep-research`, `openrouter/auto` (override via `LEAD_ENRICHMENT_MODELS`).

- `perplexity/sonar` — cheapest (~$0.005/query), lighter depth.
- `perplexity/sonar-pro` — the default; good depth, fits the 110s sync window.
- `perplexity/sonar-deep-research` — deepest, but slow. It can exceed the sync
  window; for heavy deep-research prefer smaller `count` per target or an async
  pattern (fire-and-poll) rather than the single sync call above.

`count` is capped at 25/target/run. Rough spend ≈ (enabled targets) × (model
per-query cost); a handful of weekly targets on `sonar-pro` is a few cents/week.

## Request reference

`POST /functions/v1/lead-enrichment` — all fields optional:

| field | meaning |
|---|---|
| _(none)_ | process every `enabled` target |
| `targetId` | run one target row by id |
| `niche`,`location`,`count`,`model`,`dmTitles[]`,`vertical`,`syncAbstrax` | ad-hoc target (no DB row needed) |
| `dryRun` | research + parse only, insert nothing, return a sample |
| `report` | set `false` to skip the routiner-admin Log recap |
| `routineId` | attribute the Log recap to a routine |
| `deepen` | set `false` to skip the automatic second pass on this run |
| `deepenLimit`, `deepenModel` | how many leads to gap-fill, and with which model |
| `mode:"deepen"` | run **only** the gap-fill pass (with `limit`, or explicit `leadIds`) |

Response: `{ ok, runs:[{target,parsed,inserted,skipped,offArea,mirrored,cost,error?}],
deepen:{eligible,scanned,filled,fields,unresolved,remaining,cost}, totals }`.

## The automatic second pass ("deepen")

A discovery run optimises for breadth, so it routinely returns `NONE` for a
website, phone, or — most damagingly — the decision-maker. That used to be the
human's problem: the lead landed in the Review tab and someone re-searched it by
hand. The log said exactly what that cost. Of the first 26 leads this pipeline
produced, **half arrived with no decision-maker**, and the approve/reject split
was almost perfectly predicted by that one field: leads that arrived with a
named owner got **imported**, leads without one got **rejected**.

So the engine now re-asks itself, per business, before the human sees anything:

```
discovery (find 10 clinics)  →  insert as pending
                                     │
                     for each new lead missing website / phone / owner
                                     ▼
              deepen (find the owner of THIS one named clinic)  →  patch in place
```

"Find the owner of this one named clinic" is a far easier question than "find me
ten clinics", which is why it works — a seeded test lead with *every* contact
field blank came back complete and correct (owner, title, phone, email, site,
LinkedIn, cited sources) in ~3s for **$0.0085**.

It runs automatically after every non-dry run, three lookups at a time, under a
wall-clock deadline. Anything it doesn't reach stays queued.

**Properties worth knowing:**

- **Add-only.** A value already on the row always wins; a re-run can never
  clobber something you trusted or edited.
- **Idempotent.** Every row it touches is stamped `enrichment.deepened_at`
  (found something or not), and the queue selector skips stamped rows — so
  repeated calls walk forward instead of paying to re-ask unanswerable
  questions. A *transient* error leaves the row unstamped so it retries later.
- **Same guardrails.** Results go through the same validators as the first pass,
  so the second pass is not a back door: Facebook/Yelp URLs, malformed phones
  and invented emails are rejected exactly as before.
- **Re-scores.** `lead_score` is recomputed against the enriched row, so the
  Review tab sorts on the truth rather than on first-pass luck.

Standalone, to drain the queue or to back-fill leads that predate this:

```bash
curl -s "$ENG" -H 'content-type: application/json' \
  -d '{"mode":"deepen","limit":12}'          # → {eligible, scanned, filled, fields, unresolved, remaining}
```

Loop while `remaining > 0`. Turn it off for one run with `{"deepen":false}`;
pick the model with `deepenModel` or the `LEAD_DEEPEN_MODEL` edge secret
(default `perplexity/sonar-pro`).

## Two other fixes that ride along

**Exclusion list.** De-duping used to happen only *after* research, so the model
spent real budget rediscovering businesses already in Command — one run came
back **5 of 6 duplicates**. Known business names for the target's city now go
into the prompt as "do not return these", turning that wasted spend into new
coverage.

**Area filter.** Huntsville targets were returning **Birmingham (205)** and
**Chattanooga (423)** businesses, each burning a Review-tab slot on someone
outside the service area. A lead whose own address names a different city or
state is now dropped and counted as `offArea`. A lead with *no* address is never
dropped — `parseLeads` back-fills the target city, so "unknown" must not be read
as "wrong".

## Testing

`node --experimental-strip-types scripts/test-lead-enrichment.mjs` covers the
area filter, the gap-fill parser and its guardrails, and the prompt rules — no
network, no Deno, no Supabase. Run it before shipping a change to
`lead-parse.ts` or `lead-enrichment/index.ts`.

## Guardrails baked in

- **Never invents data** — the prompt forbids it and every field is validated
  (social/aggregator sites rejected, phones 7–15 digits, emails/LinkedIn shape-checked); junk → null. Same discipline as Abstrax's finder.
- **De-dupes** against existing `staged_leads` (pending+imported) and `companies`
  by domain, phone, and name — re-runs don't pile up the same business.
- **Human gate intact** — leads land as `pending`; nothing reaches the live CRM
  until approved in the Review tab.
- **Bounded spend** — model allowlist, `count` cap, per-call usage logging.
