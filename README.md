# Claude Routine Planner

A Claude Code routine planner and scheduler, built on the
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

## Quickstart

1. Open the live app at **https://zroutiner.netlify.app**.
2. Sign in (email/password — Supabase handles auth).
3. Click **New routine**, write a prompt, and either **Run now** or **Schedule** it.
4. (Optional) Open **⚙ Settings** and add your Claude Code **trigger** + **token**
   so the app can fire routines on your behalf.

> **Forking?** See the [Setup](#setup) section below to wire your own Supabase
> project and Netlify site.

## Architecture

Routiner is a static single-page app backed entirely by Supabase:

```
┌─────────────┐      auth / CRUD      ┌───────────────────────────────┐
│  index.html │  ───────────────────► │  Supabase                       │
│  js/app.js  │                      │  • routiner_routines            │
└─────────────┘                      │  • routiner_runs                │
       │                             │  • routiner_settings            │
       │ Run now                     │  (RLS: one user per row)        │
       ▼                             └───────────────────────────────┘
┌─────────────────────────┐
│  Netlify Function       │
│  claude-trigger.mjs     │────────────────────►  Claude Code routine  
│  (server-side token)    │                           /fire
└─────────────────────────┘
```

Scheduled runs are handled by a Supabase Edge Function,
`supabase/functions/routiner-scheduler/index.ts`, which calls the same trigger
function on your behalf.

## Agents that delegate their own work

Routiner isn't one assistant — it's a **swarm of scheduled Claude agents that
split the work between them.**

- **Parallel routines.** Each account can have several triggers (A/B/C…) that
  fire as **independent, simultaneous sessions**. A week's worth of work gets
  laid out as timed Calendar blocks and executed across accounts without anyone
  babysitting it — one Claude planning, many Claudes doing.
- **Decomposition.** Hand a routine a big ask and it breaks it into an ordered
  sequence of smaller blocks across the right horizon (an hour → a week), so
  multi-step projects finish in order, on schedule.
- **Cheap-work offload.** Inside each session the agent acts as an
  *orchestrator*: it keeps the judgment calls and **delegates the grunt work** —
  boilerplate, first drafts, focused coding sub-tasks — to a faster, cheaper
  model (**GLM via OpenRouter**), reviews every line, then ships. Cheap where it
  can be, careful where it matters.
- **Every call metered.** Delegated calls are logged with token + dollar cost to
  a live usage dashboard (`usage.html` / `scripts/usage-meter.mjs`), so you can
  see exactly what your agents did and what it cost.

The OpenRouter path runs through a Supabase edge proxy (`dynamic-responder`) that
holds the key server-side, so a fired session never needs a key of its own — it
just calls the one-line helper:

```bash
node scripts/glm.mjs "Write a regex for E.164 phone numbers. Output only it."
node scripts/glm.mjs --ping   # health check: proxy alive + spend logging works
```

You set the intent; the swarm plans, splits, executes, and reports back. See
[`CLAUDE.md`](CLAUDE.md) for the full delegation playbook.

## Setup

### 1. Supabase (storage + login)

The live app points at the `zparx-dashboard` Supabase project. Tables
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

### 2. Netlify (hosting + trigger)

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

**Or use Netlify env vars** (used as a fallback, and required by the scheduler).
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

### 3. Locking the trigger to your login (recommended)

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
- The scheduler authenticates with the shared secret when it fires routines.
- Unauthenticated or unauthorized requests are rejected.
- If `ALLOWED_EMAILS` is set, only those comma-separated emails can fire; if it
  is left blank, any signed-in user can fire (as long as they pass the secret
  check).

## Repo structure

```
.
├── index.html              # App shell
├── css/                    # Tokens + app styles
├── js/app.js               # Main UI logic, Supabase client, routing
├── netlify/functions/      # Serverless triggers
├── supabase/functions/     # Edge functions (scheduler, OpenRouter proxy)
├── supabase/schema.sql     # Database + RLS setup
├── scripts/                # Usage meter, GLM helper
├── usage.html              # Live spend dashboard
└── CLAUDE.md               # Delegation playbook for Claude routines
```

## Contributing

This is an internal ZPARX project, but if you're working in the repo:

- Keep the README the single source of truth for "how do I run this?"
- Update [`CLAUDE.md`](CLAUDE.md) when you change the delegation or OpenRouter flow.
- Add env vars to the Netlify **and** Supabase secret lists when they cross both systems.

## License

Internal / proprietary — see the ZPARX team for usage terms.
