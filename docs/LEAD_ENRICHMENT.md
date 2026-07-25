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

### B) A Routiner routine on an **`openrouter`-kind account** (also zero Claude)

This keeps the run on the Calendar and in History **without putting Claude in
the path**. An account whose `kind` is `openrouter` (the *Lead Finder* account)
doesn't run a model to orchestrate anything — `routiner-scheduler` reads the
routine's config and POSTs the engine directly. The only model spend is
Perplexity, inside the engine.

The routine's **`prompt` is JSON, not English**:

```json
{ "targetId": "<uuid from lead_enrichment_targets>",
  "model": "perplexity/sonar-pro",
  "toCommand": true, "toAbstrax": false, "deepenLimit": 12 }
```

`targetId` is the preferred form — niche, location, titles and count stay in one
editable row, and the engine stamps `last_run_at` / `last_result` back onto it.
An inline `{ "niche": …, "location": …, "count": … }` works too. Optional
`deepen: false` turns off the automatic second pass; `deepenModel` overrides it.

Set `recurrence` (e.g. `weekly`) and schedule it like any other routine.

> A **Claude** account can also run it (its prompt would be a shell `curl`), but
> there is no reason to: it costs a Claude session to do what the scheduler
> already does natively. Use `openrouter`-kind unless you specifically want a
> model reading the results and writing commentary.

### C) The drain job (recommended alongside A or B)

The second pass is bounded by the invocation's wall clock, so a large run can
leave a few leads un-deepened. One cron closes that hole for good — it costs
nothing when the queue is empty (one indexed read, no model call):

```sql
select cron.schedule('leads-deepen-drain', '*/15 * * * *', $$
  select net.http_post(
    url     := 'https://vonfdzttupyemtomsojy.functions.supabase.co/lead-enrichment',
    headers := jsonb_build_object('Content-Type','application/json'),
    body    := '{"mode":"deepen","limit":12,"report":false}'::jsonb);
$$);
```

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

## One vertical per target — never blend niches

Measured, not guessed. The same city, same count, same run:

| `niche` | parsed | fresh |
|---|---|---|
| `"chiropractic clinics, dental practices, physical therapy clinics, and wellness or weight-loss clinics"` | **1** | 0 |
| `"chiropractic clinics"` | **8** | 4 |
| `"dental practices"` | **8** | 8 |

Widening a target by stuffing several verticals into one `niche` string collapses
the result to almost nothing — the model appears to search for the literal
conjunction rather than the union. To cover more ground, add **one target row
per vertical** and arm them separately. It costs one query each and returns a
full list each, instead of one query returning one lead.

The same applies to exhaustion: when a target's `last_result` shows `parsed`
collapsing toward the duplicate count, that niche×city is mined out. Rotate the
vertical or the city rather than raising `count` — raising `count` past real
supply is what provokes the padding the fabrication gate then has to catch.

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

## The fabrication gate

**The model pads.** A live run asked `sonar-pro` for 10 Decatur med spas. It
returned 10 — but three of the domains **did not exist in DNS**, and four
different "businesses" shared a sequential phone block (`…822-2227 / 2228 /
2229 / 2270`). The research prompt already said, in capitals, to return fewer
rather than pad. It padded anyway. **Prompt instructions cannot be the control
for this.**

The evidence was already being collected and thrown away: the second pass had
reported those same leads as unresolved, with notes like *"could not find any
verified listing or official page"*. Pair that with a DNS check — deterministic,
free, no model — and fabrications identify themselves.

Every claimed website is probed (apex **and** `www`, https then http) before
insert, and again before the second pass writes:

| `site_status` | meaning |
|---|---|
| `alive` | some server answered — any status, even 404/403 |
| `dead` | every candidate failed to resolve or connect |
| `unknown` | only timeouts — **never** treated as fabrication |
| `none` | the lead never claimed a website |

> Probing the apex alone is not enough: plenty of real businesses publish only
> `www.<domain>` with no apex A record. An apex-only check marked a live CRM
> site dead, which would have stripped a working website and pushed a real
> business toward quarantine.

Then the verdict, which needs **two independent pieces of evidence** to reject:

| condition | verdict | effect |
|---|---|---|
| nothing corroborated **AND** site dead | `failed` | `status='rejected'`, score 0 — never reaches Review as a live lead |
| site dead, but details corroborated | `unconfirmed` | domain dropped, lead kept, score ≤ 20 |
| nothing corroborated, but site alive / absent | `unconfirmed` | kept, score ≤ 20, reason recorded |
| corroborated, or high confidence + live site | `verified` | full score |

Every outcome writes `enrichment.verification`, `verification_note` and
`site_status`, and quarantine counts appear in the History recap — so the gate
is never silent about what it removed.

**Verified on the real cases:** the fabricated *Shalom Family Practice* →
`failed`/rejected/0 with its dead domain stripped; *Advanced Life Clinic* →
`verified`/100 with the owner found; a real business whose domain had lapsed →
`unconfirmed`/20, domain dropped but its **verified phone kept** and still
visible. The gate discriminates rather than rejecting everything.

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

## Pick niches by decision-maker rate, not by market size

The single field that decides a lead's fate is the decision-maker: in the first
26 leads, every lead that arrived with a named owner got **imported** and nearly
every one without got **rejected**. That rate is not a property of the engine —
it is a property of the **niche**, and it varies enormously.

Twenty-eight niches measured in Huntsville, `count:8`, same day, same model.

**Worth arming — DM rate ≥ 70%:**

| Niche | parsed | with a DM |
|---|---|---|
| dental practices | 8 | **8/8** |
| personal injury law firms | 8 | **8/8** |
| roofing contractors | 8 | **8/8** ⚠ |
| veterinary clinics & animal hospitals | 8 | **7/7** |
| physical therapy clinics | 8 | **6/6** |
| pediatric dental | 6 | **5/5** |
| dermatology clinics | 6 | **4/4** |
| acupuncture & holistic medicine | 5 | 4/4 |
| plastic / cosmetic surgery | 3 | 3/3 |
| ear nose & throat (ENT) | 6 | 5/6 |
| audiology & hearing aid | 5 | 4/5 |
| podiatry practices | 8 | 6/8 |
| home health care agencies | 8 | 5/7 |

⚠ Roofing swung from 4 dead domains to 0 across two runs on the same query —
highest domain variance measured. The gate absorbs it, but review those leads
more carefully.

**Marginal — 40-65%:** oral surgery & periodontics 5/8 · family medicine 4/8 ·
orthopedic & sports medicine 3/4 · orthodontics 2/4 · pain management 1/2

**Don't bother — under 30%:** OB-GYN 2/8 · pediatric medical 1/6 · counseling &
mental health 1/8 · massage therapy 1/4 · HVAC contractors 1/8 · urgent care
0/5 · optometry 0/4 · medical weight loss 0/6 · day spas & salons 0/8

The pattern is consistent and worth internalising: **a practice led by a named,
licensed practitioner has a findable owner** — dentists, vets, DPTs,
dermatologists, surgeons and trial lawyers all publish who they are, because the
practitioner *is* the marketing. Three groups reliably fail: chain or franchise
categories (optometry, weight loss, day spas), hospital-affiliated groups with
no single owner (urgent care, OB-GYN, pediatrics), and privacy-oriented
practices (mental health).

Measured result of choosing on this basis: twelve Huntsville targets run live
produced **82 pending leads at 84% with a decision-maker, 100% with a phone,
and zero quarantined** — against a starting point where half of all leads
arrived with no decision-maker at all.

So when the Review tab shows leads without a decision-maker, the fix is usually
to **change niche**, not to push the engine harder. The second pass will rescue
some of them, but starting at 8/8 beats rescuing 0/6.

## Auditing a target before you arm it

`scripts/audit-leads.mjs` dry-runs a target (inserts nothing, safe against
production) and checks **every** result — not a sample — for the fabrication
modes that have got past an eyeball check:

```bash
node scripts/audit-leads.mjs "Florence, AL" "dental practices" 8
node scripts/audit-leads.mjs --repeat 2 "Athens, AL" "dental practices" 6   # consistency
node scripts/audit-leads.mjs --stress  "Athens, AL" "chiropractic clinics"  # padding
```

Hard failures (exit 1): a non-US country code, a phone block running
sequentially across different businesses, or `--stress` filling its quota in a
market too thin to hold it. Warnings: dead domains (the gate handles those),
and exchange clustering (informational — see the note in the script).

**Known-good as of 2026-07-25:** the stress case asks Athens for 15
chiropractic clinics, a market holding about one, and gets **1** back — padding
defence holding under deliberate pressure. Athens dental at `count:6` agreed on
83% of names and on every phone across two runs.

### Phone verification

The number is the field that actually gets dialled, and for a while it was the
only one nothing checked — one practice returned two different numbers on
different runs. It is now read off **the business's own website** and compared.

This costs nothing: the site probe was already fetching the page to prove the
domain resolves, and simply threw the body away. `tel:` links are read first
(a visible number can be split across markup), then NANP-shaped runs in the
text with tags stripped, so `<b>555</b><i>123</i>` can't fuse into a phantom.

| `enrichment.phone_status` | meaning | effect |
|---|---|---|
| `confirmed` | the number appears on the business's own site | none |
| `conflict` | the site publishes numbers and ours is **not** among them | score capped at 30, site's numbers recorded in `site_phones` |
| `unverified` | site unreachable, or publishes no number | none — absence of evidence is not evidence |
| `no-phone` | nothing to check | none |

**Deliberately not an auto-correct.** A site's number can legitimately differ
from the one we hold — a tracking line, a department, a second location — so a
conflict records what the site publishes as *candidates* and leaves the call to
a human. It just can't outrank a number that checks out.

Re-check leads sourced before this existed, with **zero model calls**:

```bash
curl -s "$ENG" -H 'content-type: application/json' -d '{"mode":"verify","limit":100}'
# → { checked, deadSites, phones:{confirmed,conflict,unverified,no-phone}, conflicts:[…] }
```

> An earlier hypothesis that over-asking (`count` beyond real supply) caused the
> wrong numbers **did not replicate** — `count:12` produced no clustering while
> `count:6` produced 67%. Don't tune `count` on that theory; tune it on yield
> and duplicate rate.

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
