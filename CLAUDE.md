# CLAUDE.md

This repo is the **Claude Routine Planner** — a web UI for scheduling Claude
prompts, plus a file-based execution system in [`routines/`](routines/).

## If you were started to run routines

If this session was triggered on a schedule, via the routine webhook, or you're
asked to "process routines / run due routines / check routines", follow the
executor protocol in **[`routines/README.md`](routines/README.md)** exactly:
read due notes in `routines/scheduled/`, carry out their instructions, log
results to `routines/logs/`, reschedule recurring ones / move one-offs to
`routines/done/`, then commit and push.

## If you're working on the app itself

- `index.html`, `css/`, `js/app.js` — the single-page planner UI.
- The UI commits routine notes into `routines/` via the GitHub API (token set in
  the app's Settings) and can POST to a trigger webhook to fire a run.
- Styling follows the ZPARX design system (vendored in `css/tokens.css`):
  dark-mode-first; lime and yellow are dark-surface-only accents.
