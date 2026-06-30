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
boilerplate descriptions, outlines, mechanical text transforms — anything you'll
read back and refine.
**Never offload:** final judgment calls, anything committed/shipped without your
review, security-sensitive reasoning, or work needing repo/tool context the
cheap model won't have.

**Requires** `OPENROUTER_API_KEY` in this session's environment (the Claude Code
on the web environment vars — *not* the Netlify env, which only reaches the
trigger forwarder). If the var is unset, just do the work yourself — don't fail.

```bash
# Delegate a sub-task; capture and then review the result before using it.
[ -n "$OPENROUTER_API_KEY" ] && OUT=$(curl -s https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"moonshotai/kimi-k2.7-code",
       "messages":[{"role":"user","content":"<the sub-task prompt>"}],
       "max_tokens":4096}' | jq -r '.choices[0].message.content')
# $OUT now holds the draft — you read it, fix/verify it, then fold it into the real work.
```

Model picks: `moonshotai/kimi-k2.7-code` (code-adjacent), `deepseek/deepseek-chat`
(cheapest all-rounder), `meta-llama/llama-3.3-70b-instruct` (longer structured
output). The OpenRouter result is raw material, not a finished deliverable — you
own the final output.

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
