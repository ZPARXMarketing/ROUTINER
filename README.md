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
`routiner_routines`, `routiner_runs`, and `routiner_settings` are created with
row-level security so each account only sees its own rows. The publishable key
in `js/app.js` is safe to expose (RLS does the protecting).

**Forking this project?** Create your own Supabase project, open the **SQL
editor**, and paste [`supabase/schema.sql`](supabase/schema.sql) — that builds
every table + RLS policy in one go. Then drop your project URL and publishable
key into `js/app.js` (and `netlify/functions/claude-trigger.mjs`).

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

**Easiest path — set it in the app.** Sign in, open **⚙ Settings**, and paste
each Claude account's **trigger** + **token** under "Claude accounts". They save
to your account (Supabase `routiner_settings`, RLS per user) and the function
reads them server-side via your session — **no environment variables needed**.

**Or use Netlify env vars** (used as a fallback, and by the scheduler).
Set these in **Netlify → Site settings → Environment variables**:

| Var | Value |
|---|---|
| `CLAUDE_TRIGGER` | the routine trigger id (`trig_…`) or full `/fire` URL |
| `CLAUDE_TOKEN` | your Anthropic bearer token (`ANTHROPIC_API_KEY` also works) |
| `CLAUDE_TRIGGER_<ACCOUNT>` / `CLAUDE_TOKEN_<ACCOUNT>` | *(optional)* per-account overrides, e.g. `CLAUDE_TRIGGER_ZPARXMARKETING` |
| `CLAUDE_ROUTINE_BETA` | *(optional)* override the `anthropic-beta` header |

With env vars the token stays server-side — never exposed to the browser. (The
in-app option trades a little of that — your token lives in your RLS-protected
Supabase row — for zero-config usability.)

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
js/app.js         # Supabase auth + storage, UI, calendar, trigger (ES module)
netlify/functions/claude-trigger.mjs   # server-side routine fire
supabase/schema.sql                    # full DB schema — one paste for a fresh project
supabase/migrations/                   # incremental migrations (schema + cron)
.claude/skills/plan-routines/          # skill: plan a project into scheduled routines
assets/           # ZPARX lockup logo + favicon
```

## Contributing

Contributions are welcome. The app is intentionally small — a single-page ES
module (`js/app.js`), a couple of Netlify functions, and a Supabase schema —
so changes are easy to reason about.

- **Open an issue first** for anything non-trivial, so we can agree on the
  approach before you write code.
- **Branch off `dev`** (not `main`) and open your pull request against `dev`.
  `main` is the production branch that auto-deploys to Netlify.
- **Keep PRs focused** — one logical change per PR, with a short description of
  what and why.
- **Never commit secrets.** Only the publishable (anon) Supabase key belongs in
  the client; service-role keys and Claude tokens stay in Netlify / Supabase
  env vars (see the Setup section). When in doubt, leave it out.
- Match the surrounding style; there's no build step or linter to satisfy —
  just plain, readable JS/CSS.

## Make it yours (forking)

Want to run your own instance? The app is built to be forked — everything
specific to the original deployment is a small handful of values. Checklist:

- [ ] **(a) Create a Supabase project** and, in its **SQL editor**, paste
      [`supabase/schema.sql`](supabase/schema.sql) — that builds every table +
      RLS policy in one go. (Then turn **off** *Authentication → Email →
      "Confirm email"* if you want instant sign-ups.)
- [ ] **(b) Set your own `SUPABASE_URL` / publishable key** in `js/config.js`
      (the client reads them from there). _(The server function
      [`netlify/functions/claude-trigger.mjs`](netlify/functions/claude-trigger.mjs)
      keeps its own copy at the top — swap in your project's values there too,
      and keep the two in sync.)_
- [ ] **(c) Deploy to Netlify** — point a new site at your fork; it serves the
      static app and the `netlify/functions/` trigger. Set any env vars from the
      Setup section you need.
- [ ] **(d) Add your Claude trigger** — sign in to your deployed app, open
      **⚙ Settings**, and paste each account's **Fire URL + token** under
      "Claude accounts" (or set `CLAUDE_TRIGGER` / `CLAUDE_TOKEN` as Netlify env
      vars).

> **Branding belongs to the original author.** The **ZPARX** name, the lockup
> logo in [`assets/`](assets/), and the design tokens in
> [`css/tokens.css`](css/tokens.css) are the original author's brand and are
> **not** covered by the code license. If you fork this, please **rebrand** —
> replace the logo and tokens with your own, and drop the ZPARX name from the
> UI and copy.

## Brand

Dark-mode-first ZPARX styling: electric lime and orange accents over deep navy,
anchored by cobalt blue. The ZPARX lockup sits top-left; lime and yellow are
dark-surface-only accents per the brand pairing rules.

## License — MIT

The code is released under the [MIT License](./LICENSE). (ZPARX branding is
exempt — see the brand note above.)
