# Claude Routine Planner

A Notion-to-Claude style command center for your prompts — built on the
[ZPARX design system](https://github.com/zparxmarketing/zparxbrand-design).

Write a prompt, then choose what happens to it:

- **▶ Fire now** — send it to Claude immediately as a one-off routine.
- **⏰ Schedule** — queue it for a specific date & time. Optionally repeat it
  every day, on weekdays, or weekly.
- **▣ Save to library** — park it without firing, to iterate on later.

Every prompt can move freely between **Scheduled → Library → Archived**, and
every run (manual or scheduled) is logged in **History** with Claude's response.

## Views

| Tab | What's in it |
|---|---|
| **Scheduled** | Routines queued to fire, each showing its time and a live countdown. |
| **Library** | A rich folder of saved prompts to iterate on, duplicate, or schedule (incl. recurring). |
| **Archived** | Parked routines, out of the way. Restore to the Library anytime. |
| **History** | Every fire, with status (success / error / dry run) and the model's output. Re-run with one click. |

## How it works

It's a single-page app — no build step, no server. Open `index.html` in a
browser (or host it on GitHub Pages / Netlify).

- **State** lives in your browser's `localStorage`.
- **Scheduling** is driven by an in-page heartbeat that checks for due routines
  every 20 seconds, so routines fire automatically *while the tab is open*. Pin
  the tab for hands-off routines, or fire anything manually whenever you like.
- **Firing** calls the [Claude Messages API](https://docs.anthropic.com/en/api/messages)
  directly from the browser using the
  `anthropic-dangerous-direct-browser-access` header.

## Setup

1. Open the app and click **⚙ Settings**.
2. Paste your [Anthropic API key](https://console.anthropic.com/) and pick a
   default model. The key is stored only in your browser and is sent only to
   `api.anthropic.com` when a routine fires.

Without a key, routines still schedule and fire — as **dry runs** — so you can
try the full flow before wiring up the API.

### Models

- `claude-opus-4-8` — most capable
- `claude-sonnet-4-6` — balanced (default)
- `claude-haiku-4-5-20251001` — fast & cheap

## Project structure

```
index.html        # markup + ZPARX brand fonts
css/tokens.css    # vendored ZPARX design tokens
css/app.css       # application styling
js/app.js         # state, scheduler, Claude API, UI
assets/           # ZPARX lockup logo + favicon
```

## Brand

Styled with the ZPARX design system — dark-mode-first, electric lime and orange
accents over deep navy, anchored by cobalt brand blue. The logo (top-left) is
the ZPARX lockup; lime and yellow are used as dark-surface-only accents per the
brand pairing rules.
