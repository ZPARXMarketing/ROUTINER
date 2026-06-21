# Claude Routine Planner

A Notion-to-Claude command center, built on the
[ZPARX design system](https://github.com/zparxmarketing/zparxbrand-design).

Sign in, write a prompt, and choose what happens to it. Your routines and run
history live in **Supabase** (row-level-secured per user), so they're there on
every device, every login. **Run now** fires your **Claude Code routine** via a
Netlify function, passing the prompt straight into the routine's session.

```
 Planner UI ──auth + CRUD──► Supabase (routiner_routines / routiner_runs)
     │
     └─ Run now ─► /.netlify/functions/claude-trigger ─► Claude Code routine /fire
```

## What you can do

- **▶ Run now** — fires your Claude routine immediately with this prompt.
- **⏰ Schedule** — queue a prompt for a date & time, optionally repeating
  daily / weekdays / weekly.
- **▣ Save to library** — park a prompt to iterate on later.
- **⧉ Copy / Archive / Restore / Delete** — manage prompts across
  Scheduled → Library → Archived.
- **⚡ Test live** — optional instant preview via the Messages API (needs an
  Anthropic key).

## Setup

### 1. Supabase (storage + login) — already wired

The app points at the `zparx-dashboard` Supabase project. Tables
`routiner_routines` and `routiner_runs` are created with row-level security so
each account only sees its own rows. The publishable key in `js/app.js` is safe
to expose (RLS does the protecting).

**One manual step for email + password login:** in the Supabase dashboard →
**Authentication → Sign In / Providers → Email**, turn **off "Confirm email"**
so accounts work immediately. (Leave it on if you'd rather confirm via an email
link before the first sign-in.)

### 2. Netlify (hosting + trigger) — already wired

Hosted at **https://zroutiner.netlify.app**, auto-deploying from `main`.
**Run now** calls `/.netlify/functions/claude-trigger`, which fires your routine
server-side:

```
POST https://api.anthropic.com/v1/claude_code/routines/<trigger-id>/fire
  Authorization: Bearer <CLAUDE_TOKEN>
  anthropic-version: 2023-06-01
  anthropic-beta: experimental-cc-routine-2026-04-01
  { "text": "<the routine's prompt>" }
```

Set these in **Netlify → Site settings → Environment variables**:

| Var | Value |
|---|---|
| `CLAUDE_TRIGGER` | the routine trigger id (`trig_…`) or full `/fire` URL |
| `CLAUDE_TOKEN` | your Anthropic bearer token (`ANTHROPIC_API_KEY` also works) |
| `CLAUDE_ROUTINE_BETA` | *(optional)* override the `anthropic-beta` header |

The token stays server-side — it's never exposed to the browser.

### Locking the trigger to your login (recommended)

By default the trigger function is open. To require a sign-in (so randoms can't
fire your routine and burn tokens), set:

| Where | Var | Value |
|---|---|---|
| Netlify env | `ROUTINER_FIRE_SECRET` | any long random string |
| Supabase → Edge Functions → `routiner-scheduler` secrets | `ROUTINER_FIRE_SECRET` | **the same** string |
| Netlify env | `ALLOWED_EMAILS` | *(optional)* comma-separated emails allowed to fire |

Once `ROUTINER_FIRE_SECRET` is set on **both** sides:
- The web app must send a valid Supabase access token (it does automatically
  when you're signed in).
- The scheduler authenticates with the shared secret.
- If `ALLOWED_EMAILS` is set, only those accounts can fire — so even with open
  sign-ups, only you can trigger runs.

Leaving `ROUTINER_FIRE_SECRET` unset keeps the function open (no gating).

## Scheduling (hands-off)

Timed and recurring routines fire on their own — no tab open, no manual step:

- A Supabase **`pg_cron`** job runs every minute and calls the
  **`routiner-scheduler`** edge function
  (`supabase/functions/routiner-scheduler/index.ts`).
- The function finds routines where `status = 'scheduled'` and
  `scheduled_at <= now()`, fires each through the Netlify trigger (so the same
  `CLAUDE_TRIGGER` / `CLAUDE_TOKEN` are reused), logs a row to `routiner_runs`,
  then reschedules recurring ones (daily / weekdays / weekly) and retires
  one-offs to the library.

Manage it from SQL:

```sql
select * from cron.job where jobname = 'routiner-scheduler';
select * from cron.job_run_details order by start_time desc limit 10;
```

See `supabase/migrations/` for the schema and the cron schedule.

## Project structure

```
index.html        # planner UI + ZPARX brand fonts
css/tokens.css    # vendored ZPARX design tokens
css/app.css       # application + auth styling
js/app.js         # Supabase auth + storage, UI, trigger, live test (ES module)
netlify/functions/claude-trigger.mjs   # server-side routine fire
assets/           # ZPARX lockup logo + favicon
```

## Brand

Dark-mode-first ZPARX styling: electric lime and orange accents over deep navy,
anchored by cobalt blue. The ZPARX lockup sits top-left; lime and yellow are
dark-surface-only accents per the brand pairing rules.
