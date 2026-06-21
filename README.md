# Claude Routine Planner

A Notion-to-Claude command center, built on the
[ZPARX design system](https://github.com/zparxmarketing/zparxbrand-design).

Write a prompt, and it becomes a **routine note** committed to this repo. A
scheduled or webhook-triggered **Claude Code session** then reads the due notes
and *actually carries out the directions* — reading/writing files, running
commands, researching, committing — not just replying with text.

```
 Planner UI  ──commit .md──►  routines/  ──read & execute──►  Claude Code session
   (browser)                  (this repo)                     (full tools)
        └────────────── POST trigger webhook (optional) ──────────┘
```

## What you can do

- **▶ Run now** — commits the note (scheduled = now) and POSTs your trigger
  webhook to start a Claude session immediately.
- **⏰ Schedule** — queues the note for a date & time, optionally repeating
  daily / weekdays / weekly. A scheduled trigger fires it.
- **▣ Save to library** — parks the prompt in `routines/library/` to iterate on.
- **⧉ Copy / Archive / Restore / Delete** — manage prompts across the
  Scheduled → Library → Archived folders.
- **⚡ Test live** — optional instant preview via the Messages API (needs an
  Anthropic key); handy while writing a prompt.

## How execution works

The repo *is* the source of truth. See
[`routines/README.md`](routines/README.md) for the full executor protocol. In
short, a Claude session asked to "process routines":

1. reads due notes in `routines/scheduled/`,
2. carries out each one's directions with its tools,
3. logs the result to `routines/logs/`,
4. reschedules recurring routines / moves one-offs to `routines/done/`,
5. commits and pushes.

[`CLAUDE.md`](CLAUDE.md) points every session at that protocol.

## Setup

Open the app and click **⚙ Settings**:

1. **GitHub** — a fine-grained personal access token with **Contents: Read &
   write** on this repo, plus owner / repo / branch. This lets the UI commit
   routine notes. (Stored only in your browser.)
2. **Routine trigger URL** *(optional)* — leave blank when hosted on Netlify.
   **Run now** then calls the bundled function (see below). Set a URL only to
   POST a different webhook directly.
3. **Anthropic API key** *(optional)* — only for the **Test live** button.

### Firing a Claude Code routine (Netlify)

Hosted on Netlify, **Run now** calls `/.netlify/functions/claude-trigger`,
which fires your Claude Code routine server-side and appends the prompt to the
session as an extra turn:

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
| `CLAUDE_TRIGGER` | the routine trigger id (`trig_…`) or the full `/fire` URL |
| `CLAUDE_TOKEN` | your Anthropic bearer token (`ANTHROPIC_API_KEY` also works) |
| `CLAUDE_ROUTINE_BETA` | *(optional)* override the `anthropic-beta` header |

The token stays server-side — it's never exposed to the browser.

For timed routines, configure that Claude Code routine to *"Process due routines
per routines/README.md."* so a scheduled fire works through the repo notes.

## Project structure

```
index.html        # planner UI + ZPARX brand fonts
css/tokens.css    # vendored ZPARX design tokens
css/app.css       # application styling
js/app.js         # state, GitHub commit, trigger, UI, live test
assets/           # ZPARX lockup logo + favicon
routines/         # the routine notes + executor protocol
CLAUDE.md         # points sessions at the executor protocol
```

## Brand

Dark-mode-first ZPARX styling: electric lime and orange accents over deep navy,
anchored by cobalt blue. The ZPARX lockup sits top-left; lime and yellow are
dark-surface-only accents per the brand pairing rules.
