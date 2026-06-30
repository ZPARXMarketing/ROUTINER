# CLAUDE.md

This repo is the **Claude Routine Planner** — a web app (`index.html`, `css/`,
`js/app.js`) backed by **Supabase**, where a human queues work and Claude
routines carry it out on a schedule. Two surfaces matter:

- **Board** — the human drops notes (tasks / ideas / context) as intake.
- **Calendar** — scheduled routines render as timed, color-coded blocks.

All live state is in **Supabase** (RLS per user), *not* in this repo's files.
(The `routines/` folder is a legacy file-based executor — see the note at the
bottom; it is no longer used.)

## Offloading cheap work to OpenRouter (optional, you decide)

You are the orchestrator and you have the final say on everything that ships.
But for **cheap, simple, high-volume sub-tasks** you may delegate to a cheaper
model via **OpenRouter** to save cost/time, then review and use the output. This
is opt-in per sub-task — never required.

**Good things to offload:** bulk drafting, reformatting, first-pass summaries,
boilerplate descriptions, outlines, mechanical text transforms — and **coding
sub-tasks** (a focused function, a regex, a unit test, a small refactor, a
config block) — anything you'll read back and refine.
**Never offload:** final judgment calls, anything committed/shipped without your
review, security-sensitive reasoning, or work needing repo/tool context the
cheap model won't have.

**Coding sub-tasks → use GLM.** For code-shaped offloads, prefer
**`z-ai/glm-4.7`** (fast, cheap — the default for routine coding help) and reach
for **`z-ai/glm-5`** when the sub-task is genuinely hard. This applies to *every*
scheduled routine session: you have no key in your env, but the proxy below
does, so any fired instance can lean on GLM for grunt coding and keep your own
turns for judgment. You still own and review every line before it ships.

**How to call it (no key needed in your session).** A routine session has no
`OPENROUTER_API_KEY` in its environment — and it shouldn't. The key lives in
Supabase **edge secrets** and is used only by the OpenRouter proxy edge function
(`supabase/functions/dynamic-responder/index.ts`; deployed **slug** is
`dynamic-responder`), which proxies the call so the key never leaves Supabase.
You POST a prompt to that function and get the model's text back:

```bash
# Delegate a coding sub-task via the Supabase edge proxy; review before using it.
SUPA="https://vonfdzttupyemtomsojy.supabase.co/functions/v1/dynamic-responder"
OUT=$(curl -s "$SUPA" -H "Content-Type: application/json" \
  -d '{"model":"z-ai/glm-4.7","max_tokens":1024,
       "account":"sparks9679","trigger_key":"A",
       "prompt":"<the sub-task prompt>"}' | jq -r '.content')
# `account`/`trigger_key` are optional — they just attribute the spend in the
# usage meter (see below). Every call is logged with its token + dollar cost.
# $OUT now holds the draft — you read it, fix/verify it, then fold it into the real work.
# Errors come back as {"ok":false,"error":"…"}; if it fails, just do the work yourself.
# If .content is "(empty)", the model spent the budget before emitting text —
# raise max_tokens (>=512) and/or add "Output only the answer." to the prompt.
```

Model picks (pass as `"model"`): `z-ai/glm-4.7` (**coding default** — fast &
cheap), `z-ai/glm-5` (harder coding / most capable), `moonshotai/kimi-k2.7-code`
(code-adjacent), `deepseek/deepseek-chat` (cheapest all-rounder),
`meta-llama/llama-3.3-70b-instruct` (longer structured output). The OpenRouter
result is raw material, not a finished deliverable — you own the final output.

### Tracking spend — the usage meter

Every proxied call is logged (tokens + dollar cost) to
`routiner_openrouter_usage`. Two read-only surfaces, both fed by the
**`openrouter-usage`** edge function (which also reads OpenRouter's live credit
balance via `/api/v1/key`, key-side so it never leaves Supabase):

- **CLI:** `node scripts/usage-meter.mjs` — neon terminal meter (credit bar,
  today/month/lifetime spend, by-model, recent calls). `--watch 30` to live-poll,
  `--plain` for logs, `--demo` to see it with sample data and no network.
- **Web:** open **`usage.html`** (also linked from the app sidebar → *◆ Usage*) —
  the same numbers as a cyberpunk dashboard that auto-refreshes.

> Setup adds one table (migration `0008_openrouter_usage.sql`) and one function
> (`supabase functions deploy openrouter-usage`); `dynamic-responder` does the
> logging itself once redeployed.

> Setup (one-time, human): put the key in Supabase edge secrets as
> `OPENROUTER_API_KEY` and deploy the `dynamic-responder` function (Supabase →
> Edge Functions → editor, or `supabase functions deploy dynamic-responder`).
> The proxy currently runs with JWT verification off, so no auth header is
> needed. Rotating the key never touches this repo or any session — just update
> the edge secret.

## If you're a routine session, or asked to "process the board" / "plan" / "schedule work"

A routine fires by resuming a Claude Code session in this repo with the
routine's prompt as a turn. If that prompt is a **specific task**, just do it
with your tools. If it asks you to **process the board / plan / schedule**, use
the **[`plan-routines`](.claude/skills/plan-routines/SKILL.md)** skill — it has
the exact Supabase REST recipes. The loop:

1. **Read the Board** (`routiner_notes`; statuses `active | brainstorm | planned
   | done | dismissed`). **Act only on `active` notes.** Never touch
   `brainstorm` notes — those are still being thought through; the human
   activates a note when it's ready for you.
2. **Read the current schedule** (`routiner_routines`) so you plan around what's
   already there — yours and the other account's.
3. **Decide per active note:** simple → do it now / schedule one block;
   multi-step → decompose into a sequence of blocks across the right horizon (an
   hour → a week) so it all gets done in order.
4. **Write blocks** to `routiner_routines` (`status='scheduled'`, with
   `account`, `trigger_key`, `scheduled_at`, `recurrence`, `duration_min`).
   They appear on the Calendar.
5. **Mark each note** `planned` (or `done` if you handled it on the spot) so it
   isn't re-planned.

## Data model (Supabase — all RLS per user)

- **`routiner_notes`** — the Board. `body`, `status`
  (`active`/`brainstorm`/`planned`/`done`/`dismissed`).
- **`routiner_routines`** — the schedule the Calendar reads. `title`, `prompt`
  (the future session's task), `account`, `trigger_key`, `model` (a model id, or
  `'auto'` to let Routiner route by `task_type`+`complexity` — see
  `js/model-router.js`), `task_type`, `complexity`, `recurrence`
  (`none`/`daily`/`weekdays`/`weekly`), `status`
  (`library`/`scheduled`/`archived`), `scheduled_at`, `duration_min`.
- **`routiner_settings`** — per user, `accounts` jsonb: a **list of accounts**,
  each with a **list of triggers** `{ id, label, trigger (Fire URL or trig_…),
  token }`. Accounts are user-managed; each can have several triggers (A/B/C…)
  that fire as independent, parallel sessions.
- **`routiner_runs`** — run log (one row per fire).

## How a routine fires

The app (or the `routiner-scheduler`) POSTs
`netlify/functions/claude-trigger.mjs` with `{ text, account, triggerKey }`. The
function resolves that account + trigger to one **Fire URL + token** — from the
signed-in user's `routiner_settings` first, falling back to the `CLAUDE_TRIGGER`
/ `CLAUDE_TOKEN` (and `…_<ACCOUNT>`) Netlify env vars — and calls the routine's
`/fire` endpoint, appending `text` as a turn. Spreading work across an account's
triggers runs it truly in parallel.

## If you're working on the app itself

- `index.html`, `css/tokens.css` (vendored ZPARX tokens), `css/app.css`,
  `js/app.js` (single-page UI, ES module).
- Key views in `app.js`: **Board** (`renderBoard`), **Calendar**
  (`renderCalendar` — full 24h, blocks colored by trigger within a per-account
  hue family), Scheduled / Library / Archived / History, the Settings
  **accounts & triggers** manager, and the create/edit **drawer**.
- DB schema: `supabase/schema.sql` (one-paste setup for a fresh project) +
  incremental `supabase/migrations/`.
- Styling follows the ZPARX design system: dark-mode-first; lime and yellow are
  dark-surface-only accents.

> **Legacy:** the `routines/` folder (`scheduled/`, `done/`, `logs/`,
> `README.md`) is an older file-based executor that predates the Supabase
> backend. It is retained for reference only — the app no longer reads or writes
> those files. Don't use it; plan/schedule through Supabase as above.
