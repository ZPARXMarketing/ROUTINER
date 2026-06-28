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

## If you were asked to plan a project / schedule routines

Use the **[`plan-routines`](.claude/skills/plan-routines/SKILL.md)** skill. It
lays a project out as timed routine blocks written into the shared
`routiner_routines` table (the one the Calendar reads). Both Claude accounts
(Sparks9679 / ZparxMarketing) share that table, tagged by the `account` column —
read it first, then schedule your own account's blocks around what's there.

## If you're working on the app itself

- `index.html`, `css/`, `js/app.js` — the single-page planner UI (`app.js` is an
  ES module).
- **Storage + auth is Supabase** (project `zparx-dashboard`): tables
  `routiner_routines` / `routiner_runs`, RLS per user, email+password login.
- **Run now** POSTs `netlify/functions/claude-trigger.mjs`, which fires the
  Claude Code routine `/fire` endpoint and passes the prompt as `{"text": …}`.
  Per-account trigger + token come from the signed-in user's in-app **Settings**
  first (stored in Supabase `routiner_settings`, read server-side via their
  session — no env setup needed), falling back to the `CLAUDE_TRIGGER` /
  `CLAUDE_TOKEN` (and `…_<ACCOUNT>`) Netlify env vars.
- Styling follows the ZPARX design system (vendored in `css/tokens.css`):
  dark-mode-first; lime and yellow are dark-surface-only accents.

> The `routines/` file-based executor below predates the Supabase backend. It's
> retained for reference, but the app no longer commits notes to the repo.
