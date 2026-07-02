---
name: plan-routines
description: >-
  Plan a project as a series of scheduled Claude routines over time and write
  them into the Routine Planner (the Supabase `routiner_routines` table that the
  app's Calendar reads). Use when asked to "plan a project", "schedule a bunch of
  work over the next days/weeks", "lay out routines", or when running as one of
  the two Claude accounts (Sparks9679 / ZparxMarketing) that share the planner.
  Both accounts use THIS one skill; it reads the whole shared schedule first so
  the two Claudes coordinate instead of colliding.
---

# Plan routines

Turn a project goal into a timed sequence of routine "blocks" on the planner's
Calendar. Every block is a row in Supabase `routiner_routines`; the app renders
them as colored blocks (lime = Sparks9679, blue = ZparxMarketing). Many blocks
can run at the same time — that's expected and shows as side-by-side columns.

The whole planner is **one shared table owned by one user**. Both Claude
accounts write into it, distinguished only by the `account` column. That shared
table IS the coordination surface: **always read it before you write**, so you
can see what the other account (and your past self) already scheduled.

---

## 0. Know who you are

You are scheduling as exactly one account. Determine it from the task/prompt:

- `sparks9679` — the original account (lime on the calendar)
- `zparxmarketing` — the second account (blue)

Only ever create blocks under **your** account unless explicitly told to plan
for the other one. Never edit or delete the other account's blocks.

---

## 1. Connection + auth (the admin proxy)

The `routiner_*` tables are row-level-secured per user, and a fired routine
session has **no Supabase key** in its environment. So reads and writes go
through a Supabase **edge function**, `routiner-admin`, which holds the
service-role key inside Supabase (auto-injected; never exposed) and exposes only
the three operations this skill needs. You call it with the **public**
publishable key:

```bash
ADMIN="https://vonfdzttupyemtomsojy.supabase.co/functions/v1/routiner-admin"
ANON="sb_publishable_60-OPzmfueDopyogbm20pg_linElDjT"   # public, safe to embed
A=(-H "Authorization: Bearer $ANON" -H "apikey: $ANON" -H "Content-Type: application/json")
```

Operations (all return JSON `{ ok: true, ... }` or `{ ok: false, error }`):

| action | call | does |
|--------|------|------|
| `context` | `{"action":"context"}` | one read: `ownerUserId`, `activeNotes`, `scheduled` (both accounts), `accounts` (triggers) |
| `schedule` | `{"action":"schedule","blocks":[…]}` | inserts routine blocks (status forced `scheduled`) |
| `markNote` | `{"action":"markNote","id":"…","status":"planned"}` | sets a note to `planned`/`done`/`dismissed` |

**If `routiner-admin` is unreachable** (404 / `ok:false`), do not guess another
auth path. Produce the plan as a markdown table (title · account · when · repeat
· prompt) for the human to apply, say the proxy is missing, and stop.

---

## 2. Read everything first (one `context` call)

```bash
curl -s "$ADMIN" "${A[@]}" -d '{"action":"context"}'
```

That single call returns all the inputs you need:

- **`activeNotes`** — the Board intake (`routiner_notes`, status `active`). These
  are your work queue. The app also has `brainstorm` notes; the proxy never
  returns them, because **you must never plan or act on a brainstorm note** — the
  human activates a note when it's ready for you.
- **`scheduled`** — **both accounts'** scheduled blocks. Study before planning:
  what times is *your* account already busy? What is the *other* account doing
  (running concurrently is fine — that's the point — just don't accidentally make
  the day lopsided)?
- **`accounts`** — each account and its **triggers** (the parallel lanes; see §3b).
- **`ownerUserId`** — handled server-side on writes; you don't pass it.

For each active note decide: **simple/one-shot** → do it now or one block today;
**multi-step** → decompose into a sequence across the right horizon (an hour → a
week) so everything gets done in order.

---

## 3. Plan the project into blocks

Decompose the goal into discrete steps, each one a block. Good blocks:

- **Self-contained prompts.** A block's `prompt` is what a *future* Claude
  routine session will be handed with no other context. Spell out the task,
  name the repo/files/outputs, and where to write results. Use `{{date}}` /
  `{{datetime}}` for run-time values.
- **Sequenced by time.** For "events in succession", order steps by
  `scheduled_at`. If step B needs step A's output, schedule B later AND say so
  in B's prompt ("read the summary step A wrote to …").
- **Project-tagged titles.** Prefix every title with the project in brackets:
  `"[Q3 Launch] Draft landing copy"`.
- **Right cadence.** `recurrence` ∈ `none | daily | weekdays | weekly`. Recurring
  blocks for standing work; one-offs for milestones.
- **Realistic spacing.** Leave buffer between your own dependent steps; never
  schedule in the past.

### Coordination contract (how the two Claudes stay "in unison")

1. Read the full `context` first — every time.
2. Write only under your own `account`.
3. Concurrency across accounts is allowed; collisions within your own account
   are not — stagger your own blocks (or spread them across lanes, §3b).
4. Shared milestones: if both accounts must hit the same moment, each schedules
   its own block at that time under its own account.
5. Treat the other account's blocks as read-only facts to plan around.

---

## 3b. Divide the labor efficiently (parallel lanes + cheap-model offload)

This is the whole point of the planner: get **a lot of work done over time with
the least wall-clock and the least cost.** Two levers:

### Lever 1 — Parallel lanes (an account's triggers)

Each account has several **triggers** (A/B/C…) in the `accounts` you read from
`context`. Each trigger fires as its own independent session, so **independent
steps placed on different triggers run truly in parallel.** Treat the triggers
as lanes; spread independent work across them and keep a dependent chain on
whatever lane frees up first.

Don't lay this out by hand — the repo ships a tested, deterministic packer,
`planSchedule` in `js/schedule.js`. Give it your steps (with `dependsOn` for
ordering), the account's trigger ids as lanes, and a start time; it returns,
per step, **which trigger runs it and exactly when**, load-balanced and never
starting a step before its dependencies finish:

```bash
node --input-type=module -e '
import { planSchedule } from "./js/schedule.js";
const tasks = [
  { id: "draft",  durationMin: 30 },
  { id: "imgs",   durationMin: 30 },                       // independent → runs in parallel
  { id: "review", durationMin: 20, dependsOn: ["draft","imgs"] },
  { id: "ship",   durationMin: 15, dependsOn: ["review"] },
];
const lanes = ["A","B"];                                   // trigger ids for this account
const startMs = Date.parse("2026-07-02T14:00:00Z");
console.log(JSON.stringify(planSchedule(tasks, lanes, { startMs, gapMin: 5 }), null, 2));
'
```

Then map each assignment straight onto a block in §4:
`trigger_key = assignment.lane`, `scheduled_at = assignment.startIso`. Anything
in the returned `unplaced` array has a missing/cyclic dependency — fix the
`dependsOn` and re-run. Use this whenever a note decomposes into more than ~3
steps or any steps can overlap.

### Lever 2 — Offload the cheap parts to OpenRouter

Inside a block's own work, hand the **cheap, high-volume sub-tasks** (bulk
drafting, reformatting, first-pass summaries, boilerplate) to a cheaper model
through the `dynamic-responder` edge proxy, then review and use the output. See
the **"Offloading cheap work to OpenRouter"** section of `CLAUDE.md` for the
exact call. You stay the orchestrator; the cheap model is a tool.

> The routine's own `model` field stays a **Claude id** (or `auto`) — scheduled
> routines execute as Claude Code sessions and the fire endpoint ignores
> non-Claude ids. Offload happens *inside* the session via the proxy, not by
> setting `model` to an OpenRouter id. Bake the offload instruction into the
> block's `prompt` when a step is mostly mechanical (e.g. "draft the 20 product
> blurbs via the OpenRouter proxy, then review and tighten each").

---

## 4. Schedule the blocks (one `schedule` call)

Send all blocks for a project in a single call. The proxy fills NOT-NULL
defaults (`model:auto`, `recurrence:none`, `task_type:general`,
`complexity:medium`, `duration_min:30`), forces `status:scheduled`, and sets
`user_id` server-side. You provide the rest:

```bash
curl -s "$ADMIN" "${A[@]}" -d '{
  "action": "schedule",
  "blocks": [
    {
      "account": "zparxmarketing",
      "trigger_key": "A",
      "title": "[Q3 Launch] Draft landing copy",
      "prompt": "Write first-draft landing page copy for the Q3 launch. Pull positioning from docs/positioning.md, write the draft to drafts/landing-{{date}}.md, list 3 open questions at the end.",
      "scheduled_at": "2026-07-01T14:00:00.000Z",
      "recurrence": "none",
      "model": "claude-sonnet-5",
      "duration_min": 30
    }
  ]
}'
```

Per-block fields:

| field | value |
|-------|-------|
| `account` | **your** account id (`sparks9679` / `zparxmarketing`, or any user-defined one) — required |
| `trigger_key` | which trigger (lane) fires it, from `accounts[].triggers[].id`. Omit/null → the account's first trigger |
| `title` | `[Project] Step` — required |
| `prompt` | self-contained task for the future session — required |
| `scheduled_at` | ISO-8601 UTC, in the future |
| `recurrence` | `none` / `daily` / `weekdays` / `weekly` |
| `model` | `claude-opus-4-8` / `claude-sonnet-5` / `claude-haiku-4-5-20251001` / `auto` |
| `duration_min` | block length in minutes (drives the calendar block height) |

Then mark each note you turned into blocks so it isn't re-planned:

```bash
curl -s "$ADMIN" "${A[@]}" -d '{"action":"markNote","id":"<note-id>","status":"planned"}'
# use "done" if you fully handled it on the spot
```

---

## 5. Verify

Re-read `context` and confirm your new blocks are present at the intended times
and account, and that the notes you handled are no longer `active`. Then
summarize the plan back to the human: project name, number of blocks, the span
of dates, lanes used, and any intentional overlaps with the other account. The
blocks now appear on the Calendar tab in their account color.

---

## Guardrails

- Never schedule in the past, and never double-book your own account by accident.
- Don't touch the other account's rows (only ever `schedule` under your account).
- Only call `markNote` for notes you actually turned into blocks.
- If `routiner-admin` is unreachable, output the plan as a proposal for the human
  and stop — don't partially apply.
