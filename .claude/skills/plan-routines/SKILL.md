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

## 1. Connection + auth

The planner is Supabase project `vonfdzttupyemtomsojy`:

```
SUPABASE_URL=https://vonfdzttupyemtomsojy.supabase.co
```

Reads and writes go through the Supabase REST API. Because routines are
row-level-secured per user, an automated session must authenticate with the
**service-role key**, provided to this session as a secret env var:

```
SUPABASE_SERVICE_ROLE_KEY=<set in the routine session's environment / secrets>
```

> Get it from Supabase → Project Settings → API → `service_role` key. It is
> powerful (bypasses RLS). Keep it only in the session's secret store — never
> echo it, never commit it, never put it in a routine `prompt`.

**If `SUPABASE_SERVICE_ROLE_KEY` is not set**, do not fail and do not guess a
key. Produce the plan as a markdown table (title · account · when · repeat ·
prompt) for the human to apply, say the key is missing, and stop.

Common headers (reuse for every call):

```bash
H_KEY=(-H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")
```

---

## 1b. Read the board (the intake)

The app has a **Board** where the human drops tasks/ideas/context as notes
(`routiner_notes`, status `open | planned | done | dismissed`). Open notes are
your work queue. Read them first:

```bash
curl -s "$SUPABASE_URL/rest/v1/routiner_notes?select=id,body,status&status=eq.open&order=created_at" "${H_KEY[@]}"
```

For each open note, decide:

- **Simple / one-shot?** Just do it now (or schedule a single block today).
- **Multi-step?** Decompose it into a sequence of blocks across the right
  horizon (an hour → a week) so everything gets done in order.

After you've turned a note into scheduled blocks, mark it so it isn't re-planned:

```bash
curl -s -X PATCH "$SUPABASE_URL/rest/v1/routiner_notes?id=eq.<note-id>" "${H_KEY[@]}" \
  -H "Content-Type: application/json" -d '{"status":"planned"}'
# use "done" instead if you fully handled it on the spot
```

---

## 2. Look at the app first (read the whole schedule)

```bash
curl -s "$SUPABASE_URL/rest/v1/routiner_routines?select=id,title,account,status,recurrence,scheduled_at&status=eq.scheduled&order=scheduled_at" "${H_KEY[@]}"
```

This returns **both accounts'** scheduled blocks. Study it before planning:

- What times are already busy for **your** account? Avoid stacking your own
  blocks on top of each other unless you mean to.
- What is the **other** account doing? You may intentionally run concurrently
  with it (the two Claudes working in parallel is the whole point) — just be
  aware of it so the day isn't accidentally lopsided.
- Grab the owner `user_id` you'll need for inserts from any existing row:

```bash
curl -s "$SUPABASE_URL/rest/v1/routiner_routines?select=user_id&limit=1" "${H_KEY[@]}"
# (currently 1c336965-e8db-4c2a-919d-3e1e7d07fc79 — but read it, don't assume)
```

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
- **Project-tagged titles.** Prefix every title with the project in brackets so
  the shape is obvious on the calendar and to the other Claude:
  `"[Q3 Launch] Draft landing copy"`.
- **Right cadence.** `recurrence` ∈ `none | daily | weekdays | weekly`. Use
  recurring blocks for standing work (a daily digest), one-offs for milestones.
- **Realistic spacing.** Leave buffer between your own dependent steps; don't
  schedule a step in the past.

### Coordination contract (how the two Claudes stay "in unison")

1. Read the full table first (step 2) — every time.
2. Write only under your own `account`.
3. Concurrency across accounts is allowed; collisions within your own account
   are not — stagger your own blocks.
4. Shared milestones: if both accounts must hit the same moment, each schedules
   its own block at that time under its own account.
5. Treat the other account's blocks as read-only facts to plan around.

---

## 4. Schedule each block (write)

One POST per block. `scheduled_at` is ISO-8601 UTC. Set `user_id` explicitly
(service-role has no `auth.uid()` to default it).

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/routiner_routines" "${H_KEY[@]}" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d '{
    "user_id": "1c336965-e8db-4c2a-919d-3e1e7d07fc79",
    "account": "zparxmarketing",
    "trigger_key": "<a trigger id from this account>",
    "title": "[Q3 Launch] Draft landing copy",
    "prompt": "Write first-draft landing page copy for the Q3 launch. Pull positioning from docs/positioning.md, write the draft to drafts/landing-{{date}}.md, and list 3 open questions at the end.",
    "status": "scheduled",
    "scheduled_at": "2026-07-01T14:00:00.000Z",
    "recurrence": "none",
    "model": "claude-sonnet-4-6"
  }'
```

Field notes:

| field | value |
|-------|-------|
| `user_id` | the owner uuid from step 2 |
| `account` | **your** account id (`sparks9679` or `zparxmarketing`, or any user-defined one) |
| `trigger_key` | which trigger (instance) within that account fires it — an id from `routiner_settings.accounts[].triggers[].id`. Omit/null to use the account's first trigger. |
| `title` | `[Project] Step` |
| `prompt` | self-contained task for the future session |
| `status` | `scheduled` (so it shows on the Calendar) |
| `scheduled_at` | ISO-8601 UTC, in the future |
| `recurrence` | `none` / `daily` / `weekdays` / `weekly` |
| `model` | `claude-opus-4-8` / `claude-sonnet-4-6` / `claude-haiku-4-5-20251001` |

> **Accounts now hold multiple triggers.** Each account in `routiner_settings.accounts`
> has a `triggers` list (A/B/C…), each its own Fire URL + token. Spreading a
> project's steps across several triggers of one account lets them run truly in
> parallel. Read the accounts structure first to pick valid `trigger_key`s.

---

## 5. Verify

Re-read the schedule (step 2) and confirm your new blocks are present at the
intended times and account. Then summarize the plan back to the human:
project name, number of blocks, the span of dates, and any intentional overlaps
with the other account. The blocks now appear on the Calendar tab in their
account color.

---

## Guardrails

- Never schedule in the past, and never double-book your own account by accident.
- Don't touch the other account's rows.
- Don't echo, log, or embed `SUPABASE_SERVICE_ROLE_KEY` anywhere.
- If anything required is missing (key, owner id), output the plan as a proposal
  for the human and stop — don't partially apply.
