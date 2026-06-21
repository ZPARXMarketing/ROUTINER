# Routines — the execution protocol

This folder is the bridge between the **Claude Routine Planner** UI and a
**Claude Code session** that actually carries out the work. The UI commits a
routine "note" here; a scheduled or webhook-triggered Claude session reads the
due notes and does what they say.

```
routines/
  scheduled/   # routines waiting for their time (the executor reads these)
  library/     # saved prompts, parked — NOT executed
  archived/    # set aside — NOT executed
  logs/        # one file per run, written by the executor
  done/        # completed one-time routines, moved here after they run
```

## Routine note format

Each routine is a single markdown file named `<id>.md` with YAML frontmatter
followed by the prompt body:

```md
---
id: l8x2k9abc
title: Morning competitor scan
status: scheduled          # scheduled | library | archived
schedule: 2026-06-22T13:00:00.000Z   # ISO 8601 UTC, or null
repeat: weekdays           # none | daily | weekdays | weekly
model: claude-sonnet-4-6
created: 2026-06-21T10:00:00.000Z
updated: 2026-06-21T10:00:00.000Z
lastRun: null
---

Check our three competitors' blogs, summarize anything new since yesterday,
and write the summary to reports/competitors-{{date}}.md.
```

The **body is the instruction** — treat it like a task for Claude Code, not a
chat message. It may ask you to read/write files, run commands, research, or
produce a report. Do the work with the tools available.

---

## Executor instructions (follow these when asked to "process routines")

When a session is started to process routines — on a schedule, via the webhook
trigger, or manually — do the following:

1. **Determine "now"** in UTC (`date -u +%Y-%m-%dT%H:%M:%SZ`).
2. **Read every file in `routines/scheduled/`.** Skip any whose `status` is not
   `scheduled`.
3. A routine is **due** when its `schedule` is `null` (run-asap) or its
   `schedule` is at or before now.
4. **For each due routine, in time order:**
   a. Carry out the instructions in the body using your tools. Resolve
      `{{date}}` / `{{datetime}}` placeholders to the current values.
   b. Write a log to `routines/logs/<UTC-YYYY-MM-DD-HHMM>-<id>.md` containing:
      the routine title, the timestamp, what you did, and the result/output (or
      the error if it failed).
   c. Set `lastRun` to now in the routine's frontmatter.
   d. **Reschedule or retire:**
      - If `repeat` is `daily`, `weekdays`, or `weekly`, set `schedule` to the
        next occurrence (keep the same time-of-day; `weekdays` skips Sat/Sun)
        and leave the file in `routines/scheduled/`.
      - If `repeat` is `none`, set `status: done` and move the file to
        `routines/done/`.
5. **Do not touch** files in `library/` or `archived/`.
6. **Commit and push** all changes (logs, updated frontmatter, moved files) in
   one commit, e.g. `chore(routines): execute due routines <date>`.
7. If nothing is due, write nothing and exit quietly.

> Be conservative: only run routines that are clearly due, and never run the
> same routine twice in one pass.

---

## Triggering execution

There are three ways a session gets started to run this protocol:

1. **Scheduled trigger** — set up a recurring Claude Code on the web trigger on
   this repo with the standing prompt: *"Process due routines per
   routines/README.md."* This is what makes timed routines fire on their own.
2. **Webhook ("Run now")** — the Planner can POST to a Claude routine trigger
   URL right after it commits a note, so "Run now" starts a session
   immediately. Configure the URL in the app's **Settings → Routine trigger**.
3. **Manual** — open a session anytime and say "process due routines."

See [`../CLAUDE.md`](../CLAUDE.md) — it points every session at this protocol.
