# CLAUDE.md

This repo is the **Claude Routine Planner** — a web app (`index.html`, `css/`,
`js/app.js`) backed by **Supabase**, where a human queues work and Claude
routines carry it out on a schedule. Two surfaces matter:

- **Board** — the human drops notes (tasks / ideas / context) as intake.
- **Calendar** — scheduled routines render as timed, color-coded blocks.

All live state is in **Supabase** (RLS per user), *not* in this repo's files.

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
You POST a prompt to that function and get the model's text back.

**Easiest — the one-line helper (preferred).** `scripts/glm.mjs` wraps the call:
it defaults to `z-ai/glm-4.7`, attributes spend (`ROUTINER_ACCOUNT`/`ROUTINER_TRIGGER`,
defaulting to `sparks9679`/`t_a`), prints **only** the model's text, and gives a
clear error if the host is unreachable. Verify the whole path end-to-end (and that
a usage row lands) with `--ping`.

```bash
# One coding sub-task → just the answer on stdout. Review before using it.
OUT=$(node scripts/glm.mjs "Write a regex for E.164 phone numbers. Output only it.")
node scripts/glm.mjs --model z-ai/glm-5 "<a genuinely hard sub-task>"   # harder
echo "<long prompt>" | node scripts/glm.mjs                            # via stdin
node scripts/glm.mjs --ping   # end-to-end self-test: proxy reachable + logging works
# Reasoning control (default low — keeps GLM from burning max_tokens thinking):
node scripts/glm.mjs --reasoning low "…"     # default
node scripts/glm.mjs --reasoning off "…"     # disable reasoning entirely
node scripts/glm.mjs --reasoning default "…" # omit the field (legacy behavior)
```

**Raw curl (fallback / non-Node contexts).**

```bash
# Delegate a coding sub-task via the Supabase edge proxy; review before using it.
SUPA="https://vonfdzttupyemtomsojy.supabase.co/functions/v1/dynamic-responder"
OUT=$(curl -s "$SUPA" -H "Content-Type: application/json" \
  ${RESPONDER_SECRET:+-H "x-responder-secret: $RESPONDER_SECRET"} \
  -d '{"model":"z-ai/glm-4.7","max_tokens":1024,
       "account":"sparks9679","trigger_key":"t_a",
       "reasoning":"low",
       "prompt":"<the sub-task prompt>"}' | jq -r '.content')
# `account`/`trigger_key` are optional — they just attribute the spend in the
# usage meter (see below). Every call is logged with its token + dollar cost.
# `reasoning` is optional (string or object): low|medium|high|off|unset —
# defaults to RESPONDER_REASONING_EFFORT env (default low) on the proxy.
# The x-responder-secret header is only needed if the proxy is gated
# (RESPONDER_SECRET edge secret set); the ${VAR:+…} expansion omits it otherwise.
# $OUT now holds the draft — you read it, fix/verify it, then fold it into the real work.
# Errors come back as {"ok":false,"error":"…"}; if it fails, just do the work yourself.
# If .content is "(empty)" or "(empty — hit max_tokens)", the model spent the
# budget before emitting text — raise max_tokens and/or use reasoning:low (default).
```

> **Heads-up (network policy):** the proxy only works if the routine session is
> allowed to reach `*.supabase.co`. If `--ping`/curl fails with a connection/403
> error, the offload silently no-ops and the session just does the work itself —
> allow that host in the environment's egress settings and re-run `--ping`.

More `glm.mjs` flags: `--stdin` (append piped text), `--json` (raw proxy
response), `--quiet` (only the model's text), `--account`/`--trigger-key`
(override attribution), `--reasoning <low|medium|high|off|default>` (default
`low`). `--ping` exits `0` only when the proxy answers `PONG`, `1` on
proxy/network error, `2` if it answers but the assertion fails — using a
512-token budget so GLM's reasoning tokens don't starve the reply into "(empty)".

Model picks (pass as `"model"`): `z-ai/glm-4.7` (**coding default** — fast &
cheap), `z-ai/glm-5` (harder coding / most capable), `moonshotai/kimi-k2.7-code`
(code-adjacent), `deepseek/deepseek-chat` (cheapest all-rounder),
`meta-llama/llama-3.3-70b-instruct` (longer structured output). The OpenRouter
result is raw material, not a finished deliverable — you own the final output.

**Field notes (measured through this proxy — trust these over the labels above
for short offloads):** the proxy has a **hard ~45s timeout**. Earlier failures
where `z-ai/glm-4.7` / `z-ai/glm-5` returned `(empty)` were **reasoning-token
starvation** (they burned `max_tokens` thinking with no `reasoning` param). The
proxy and `glm.mjs` now default to `reasoning: low` (`{ effort:"low",
exclude:true }`), which should leave budget for real output — **re-benchmark
before trusting GLM again**:

```bash
node scripts/glm.mjs --model z-ai/glm-4.7 --max-tokens 800 \
  "Write isValidHexColor in JS. Output only code."
```

A prior benchmark on one small coding sub-task (`isValidHexColor`) *without*
reasoning control:

| model | latency | cost | result |
|-------|---------|------|--------|
| `meta-llama/llama-3.3-70b-instruct` | ~2.2s | ~$0.00002 | ✅ correct, cleanest |
| `deepseek/deepseek-chat` | ~4s | ~$0.00004 | ✅ correct (wraps in ``` fences — strip them) |
| `moonshotai/kimi-k2.7-code` | ~12s | ~$0.0016 | ✅ correct, clean |
| `z-ai/glm-4.7` | ~13s | ~$0.0014 | ✗ `(empty)` at 800 tok (pre–reasoning fix) |
| `z-ai/glm-5` | ~28s | ~$0.0026 | ✗ `(empty)` at 800 tok (pre–reasoning fix) |

**Practical default for agent / reliable offloads: still prefer
`moonshotai/kimi-k2.7-code` or `deepseek/deepseek-chat` until GLM is
re-benchmarked with `reasoning: low`.** `meta-llama/llama-3.3-70b-instruct`
stays a good cheap pick for mechanical text. And **always review the output** —
offloaded drafts have shipped subtle bugs (e.g. an HTML-escaper that omitted
`&`); you own every line before it ships.

### Agent reliability knobs (edge secrets)

After deploy, these optional secrets tune the agent path:

| secret | default | role |
|--------|---------|------|
| `AGENT_REASONING_EFFORT` | `low` | OpenRouter `reasoning` on agent model calls (`low`/`medium`/`high`/`off`/`unset`) |
| `RESPONDER_REASONING_EFFORT` | `low` | Same for `dynamic-responder` (body `reasoning` wins) |
| `AGENT_MODEL_RETRIES` | `2` | Retries for a **transient** OpenRouter failure inside one step (`Provider returned error`, 5xx, timeout, **429 throttle**). Permanent errors — bad key (401/403), out of credit (402), disallowed model — still fail fast |
| `AGENT_FALLBACK_MODEL` | `moonshotai/kimi-k2.7-code` | If the chosen model keeps failing transiently, the run finishes on this one instead of dying. Set to `""` to disable |
| `AGENT_CONTEXT_TOOL_BUDGET` | `60000` | Total chars of tool output kept at full size in the model's context. Older results are floored at 400 chars — **head *and* tail**, not head-only |
| `AGENT_REPEAT_THRESHOLDS` | `3,5,8` | Consecutive identical tool calls that trigger an advisory nudge. `off` disables. Must be distinct integers ≥ 2 |
| `AGENT_REPEAT_EXCLUDE` | *(empty)* | Comma-separated tool-name patterns (`*` wildcards) that are **transparent** to the repeat chain — they neither count nor reset it |
| `AGENT_SPILL_THRESHOLD` | `12000` | Results larger than this are stored whole in `routiner_tool_spills` and replaced with a preview + spill id |
| `AGENT_SPILL_PREVIEW_CHARS` | `4000` | Characters kept inline (split head/tail) when a result is spilled |
| `AGENT_SPILL_WINDOW_CHARS` | `40000` | Max characters one `read_spill` window returns |
| `SCHEDULER_KEY_ALERT_USD` | `1` | Board-note warning fires when the OpenRouter key's `limit_remaining` drops to or below this |
| `SCHEDULER_KEY_ALERT_COOLDOWN_H` | `24` | Hours between repeat key-balance notes |
| `SCHEDULER_KEY_CHECK_EVERY_MIN` | `15` | Probe the balance only on minutes divisible by this (the scheduler itself wakes every minute) |

Per-tool time budgets are declared in code (`TOOL_BUDGET_MS`), not by env: a
tool's ceiling is a property of what it does, and the loop already caps it at
the time actually left.
| `AGENT_MAX_STEPS` | `5` | Tool-loop steps per edge invocation (non-code) |
| `AGENT_CODE_MAX_STEPS` | `12` | Tool-loop steps when the `code` tool group is enabled |
| `AGENT_MAX_NO_PROGRESS` | `2` | Consecutive auto-continue segments with no tools/text before the chain stops with `error` |
| `AGENT_TOOL_RESULT_CAP` | `8000` | Max chars returned for non-file tool results |
| `AGENT_GH_READ_RESULT_CAP` | `120000` | Max chars for a single `gh_read_file` window (was 3500 and made agents claim files were too large) |
| `AGENT_GH_READ_DEFAULT_LINES` | `400` | Line window when auto-paging or when only `start_line` is set |
| `SCHEDULER_REAP_RUN_MIN` | `10` | Minutes of silence on a `status=running` row before the scheduler marks it `error` (stale-run reaper) |
| `SCHEDULER_AGENT_CONCURRENCY` | `1` | Max `openrouter-agent` routines fired **at once**. Claude/lead fires stay fully parallel. `0` = unbounded (the old behaviour) |

A run silent longer than `SCHEDULER_REAP_RUN_MIN` is auto-marked `error` (transcript
kept); open it in History and **Retry** (or reply `continue`) to resume. The
History UI also shows **"May have stalled"** for running rows past the same
threshold before the reaper fires.

> **Never fire agent routines simultaneously — it is the single biggest cause of
> agent-run failure, and it hides behind other symptoms.** The scheduler used to
> dispatch every due routine with one unbounded `Promise.allSettled`;
> `SCHEDULER_BATCH` capped how many were *claimed*, never how many ran at once.
> Holding the model and the key constant, `moonshotai/kimi-k2.7-code` errored
> **0% across 10 runs fired alone and 90% across 10 fired alongside others** —
> so this is not a model-quality problem and not a key problem. Per-*call*
> success actually **improves** under load (92.6% at 8+ calls/min vs 84.3% at
> 1–3/min), which is the tell: the OpenRouter key is fine, and the contention is
> between concurrent **edge-function invocations**, each running a whole tool
> loop. It surfaces as `OpenRouter call timed out (50000ms)` and
> `Run died mid-flight — the edge function was killed`, both of which read like
> model or network faults. A Claude `/fire` is exempt: it's a cheap POST that
> hands off elsewhere (4 fired at once, 0 errors), so only agent fires are pooled.
> Covered by `scripts/test-scheduler.mjs`.

> **"Did any tool run?" is not a test for progress.** `segmentMadeProgress` asks
> whether *any* tool ran or the model produced real text — so an agent calling
> `gh_read_file` with the identical path twelve times in a row scored full
> progress every segment, burned the step budget, and auto-continued into another
> segment doing the same thing. The repeat guard counts **consecutive identical**
> calls — keyed on `(tool name, deep-key-sorted arguments)`, so argument order
> can't disguise a repeat — and injects an escalating nudge at
> `AGENT_REPEAT_THRESHOLDS`. Three properties are load-bearing and pinned by
> `scripts/test-agent.mjs`: it is **advisory** (it never vetoes or rewrites a
> call — a legitimately repeated call must not be blocked); excluded tools are
> **transparent**, neither counting nor resetting, or a bookkeeping call
> interleaved into a loop launders it; and the chain is derived from the stored
> transcript rather than held in memory, because an auto-continue segment is a
> fresh edge invocation and in-memory state would reset at exactly the boundary a
> stuck run is most likely to cross. A *human* reply resets the chain; the
> injected `[auto-continue]` prompt does not.

> **One deadline per tool call, not one per HTTP request.** `gh()` clamped each
> request at `CALL_TIMEOUT_MS`, which bounded no total — and the tools that
> overrun are the multi-request ones: `gh_propose_edit` makes 4 + 2×files
> sequential GitHub calls, so ten files could spend 24 × 50s and eat a whole
> segment the model then had to auto-continue out of. Each tool now declares a
> ceiling in `TOOL_BUDGET_MS` and its sub-calls draw down one shared deadline,
> capped at the time actually left. Two details worth keeping: `gh()` refuses
> outright when the budget is spent (the old `Math.max(3_000, …)` floor bought
> one more request the tool had no time to use), and running dry mid-write
> reports exactly which files landed on which branch, because the branch already
> exists by then and the next call would otherwise 422 with no explanation.

> **The model is told where it is in the run.** A run spans up to six edge
> invocations across hours, and the model had no idea which one it was in or how
> much time was left — so it explored as leisurely on the last segment as the
> first, with `AUTO_CONTINUE_PROMPT` telling it to hurry and no numbers behind
> the instruction. `segmentOrientation` injects one labelled line per segment
> ("Segment 4 of at most 6 … this is the LAST segment"). Like every injected
> turn it carries `_source`, so it renders as a notice and — importantly — does
> not reset the repeat chain at the start of every segment.

> **A turn the machine injected is not a turn the human typed.** Both were a bare
> `role:"user"`, so History rendered every `[auto-continue]` prompt as if the
> human had sent it, and any "did the user say something?" test counted a machine
> nudge as a human interjection — which is precisely the reset the repeat guard
> above must not honour. Injected turns now carry `_source`
> (`auto-continue` / `repeat-guard`), which stays in the stored transcript and
> renders as a collapsed notice, never a user bubble. It is stripped in
> `compactMessages` before the request: it is ours, not OpenAI's, and an unknown
> message field is a 400 on the strict providers.

> **Oversized tool output is spilled, not truncated.** Two knobs were in direct
> contradiction: `AGENT_GH_READ_RESULT_CAP` let one `gh_read_file` return 120k
> chars while `AGENT_CONTEXT_TOOL_BUDGET` keeps 60k of tool output at full size —
> so a single large read was **2× the entire full-fidelity budget**, and reading
> a second file guaranteed the first was floored. The model then re-read the file
> it had already been handed, which is the loop the repeat guard exists to catch:
> truncation was *manufacturing* the loop. Now a result over
> `AGENT_SPILL_THRESHOLD` is stored whole in `routiner_tool_spills` and the
> context gets a head/tail preview plus a spill id, paged with **`read_spill`**.
> Three properties matter: the notice explicitly says the text was *stored, not
> lost* and forbids re-running the tool (a truncation notice that doesn't reads
> as a dead end); a failed insert falls back to the old inline cap, because a
> storage blip must never fail a successful tool call; and `read_spill` is
> **ungrouped** — always offered — since a spill only exists because a tool the
> run already had produced it, and gating it would strand the very output we just
> told the model to page. Spills are scoped to their run and cascade-delete with
> it; losing one costs a re-read, never work.

> **The model can pause a run; it could only ever end one.** Replying with text
> finishes the whole run, so a segment always stopped wherever the step budget
> happened to fall — mid-read, mid-edit, with the next segment paying to work out
> where it was. **`end_segment`** is the deliberate hand-off: it ends this
> segment and lets the auto-continue chain start the next one from the goal. It
> is ungrouped, since the ability to pause cannot depend on which tool groups a
> run happens to have. Five refusals guard the same thing — that something is
> left to resume, and a segment left to resume it in: **no goal** (handing off
> amnesia; the next orientation would read "no goal recorded yet" and start
> over); a **complete or blocked** goal (one owes a summary, the other stops the
> chain by design); the **last segment**, where `incomplete` files the run as
> out-of-segments rather than pausing it; and a segment that **ran no tools**, or
> **left `done` exactly as it found it** — either hands the next segment its own
> starting position, so it repeats this one. That last refusal is the "set the
> goal once and never touch it again" failure caught at the one moment the goal
> has to be current. A batch that opened a PR ignores the hand-off: that path
> owes the reader a summary and the next iteration is already set up to write one.

> **"Shall I proceed?" is not a pause — it is the run ending on a question
> nobody is there to answer.** Replying with text finishes a run, so a model
> that closed a turn asking for the go-ahead left a thread sitting until a human
> typed a word that was never in doubt: the task was the authorization, and the
> answer is always yes. That round trip was the single thing that made Routiner
> feel like babysitting rather than delegation. Two independent tells now resume
> the chain with `AUTO_PROCEED_PROMPT` instead of filing the run as done —
> `goalWantsMore` (the model's own goal still reads `phase: active` with a
> non-empty `remaining`, said in the one place compaction never touches) and
> `asksForGoAhead` (the closing text is shaped like a request for permission,
> matched against the last 400 characters, because the ask is a *closing* move
> and a summary that discusses options mid-paragraph is still finished). The
> escape hatch is unchanged and is the whole reason this is safe: something only
> a human can supply — a credential, a choice they care about, an irreversible
> action outside the task — goes through `set_goal phase='blocked'`, which stops
> the chain with a named cause. Prose cannot carry that, because prose cannot be
> told apart from thinking out loud. Three properties the tests pin: a goal
> marked `complete` **outranks the wording**, so a closing courtesy ("let me know
> if you want anything else") does not buy a model call to be told the work is
> done; a hard error or budget stop never proceeds, since the next segment
> inherits the same failure; and the chain is **bounded by machinery that already
> existed** — `segmentMadeProgress` now scores a tool-less segment whose only
> text is a permission ask as *no progress*, so two in a row hit
> `MAX_NO_PROGRESS` rather than trading pleasantries for the whole continue
> budget. A permission ask on the **last** segment is not filed as
> out-of-segments: the model did the work and closed with a question, so its own
> text is the ending and the reader can just answer it.

> **Delegating work across time needed no new machinery — only a tool.** A
> Routiner routine *is* a future agent run: the scheduler fires its `prompt` on
> its `account`/`trigger_key` at its `scheduled_at`. So "do this now, then check
> again tomorrow, then write it up Friday" was always one row per step; what was
> missing was the model's ability to write those rows. That is the **`schedule`
> tool group** — `schedule_task`, `reschedule_task`, `cancel_task` (with
> `read_routines`, in the `read` group, to see what is already there). A
> scheduled task **inherits the instance that scheduled it** — same account,
> trigger, model and tool groups — because a planning conversation has no reason
> to believe work can be done by anything else. Two details that decide whether
> the times are right: `resolveWhen` takes **either** `in_minutes` (an offset —
> models are unreliable at date arithmetic and reliable at counting) **or** `at`
> as ISO 8601, and a zone-less `at` is read in the **owner's** timezone, not UTC.
> That last one is the bug you would notice and never diagnose: a model told the
> owner's zone writes `09:00` meaning 9am where they live, and reading it as UTC
> lands a morning task in the middle of the night. The zone reaches the function
> as `tz` on the request body — only the browser knows it — is relayed by the
> auto-continue chain, and an unusable value degrades to UTC rather than failing
> a run that has nothing to do with time. The system prompt also states the
> current instant, so nothing guesses today's date.
>
> **Turning it on:** `Schedule work for later` is a checkbox on each agent
> instance (Settings → the account → the trigger) and is on by default for
> instances created from here on. An instance that predates it has an explicit
> stored tool list, which `normalizeTools` keeps as-is on purpose, so **existing
> instances need the box ticked once** — there is no way to tell "made before
> this shipped" from "deliberately unchecked", and guessing wrong would re-enable
> a capability someone had turned off.

> **A run has a goal, and it lives off the transcript.** `messages` is compacted
> between segments, so by segment four the model's record of its own plan is
> mostly gone — and `AUTO_CONTINUE_PROMPT` was telling it to "resume the task
> from the transcript", i.e. to reconstruct its plan from the part we deleted.
> **`set_goal`** writes `{objective, done[], remaining[], phase, blocked_reason}`
> to `routiner_runs.goal`, which nothing compacts; it is re-stated in the
> orientation turn every segment and shown above the transcript in History.
> `phase` is `active | blocked | complete`, and **`blocked` is a state, not
> prose**: a blocked run stops the auto-continue chain and files as `error`,
> because the next segment would inherit the same obstacle and burn a segment
> failing identically — which is exactly what a spent key retried for 8h45m
> across 45 messages did. `blocked` requires both a kebab-case `blocked_code` and
> a human-actionable `blocked_message`; a block with no stated cause is refused,
> since that is the dead-end the whole mechanism exists to prevent.

> **The key dying is the biggest outage this system has had, and it was
> silent.** The OpenRouter key hit its cap on 2026-08-04; every agent run failed
> and *nobody noticed for three weeks* — run volume went from ~26/week to two,
> because nothing watched the balance and the usage meter only helps a human who
> thinks to open it. The number is authoritative and one call away
> (`limit_remaining` on `GET /api/v1/key`), so the scheduler now checks it and
> writes an **`active` Board note** the first time it goes low. Three properties
> the tests pin: a key with **no cap configured never alarms** (it cannot run
> out this way, and crying wolf every 15 minutes trains you to ignore it); an
> **unreachable or garbled probe is silent**, because an OpenRouter blip must
> not manufacture a scare note about a healthy key; and the note carries a
> `[key-balance]` marker used for its own cooldown lookup, so a spent key files
> one note a day rather than 1,440. Delete the note to re-arm the alarm early.

> **A goal the model sets once and forgets is worse than no goal.** The first
> live run after shipping `set_goal` filed `success` while its own goal still
> read `phase: active, done: []` — set at step one, never touched again. On one
> segment that is untidy; across segments the next orientation turn reads
> "nothing done yet" and invites the run to redo finished work, which is exactly
> what the goal exists to prevent. Two fixes, because trusting the model to
> keep it current is what failed: `reconcileGoal` flips an `active` goal to
> `complete` when the run itself ends in `success` (the run's outcome is the
> authority, and `done`/`remaining` are never invented), and a segment after the
> first that inherits a goal with an empty `done` gets told so explicitly.

> **A 401 must name the gate.** A scheduled model-shootout run died reporting
> only *"dynamic-responder proxy returned 401 for every call"* — accurate and
> useless, because nothing in it said the gate was **on and deliberate**
> (`RESPONDER_SECRET` is set as an edge secret). The proxy now says so, names
> the `x-responder-secret` header, and notes that `scripts/glm.mjs` forwards
> `$RESPONDER_SECRET` — so the next caller to hit it can fix itself.

> **A pending retry is durable before the wait, never after.** The retry backoff
> in `openrouter()` was in-memory, so an edge function killed mid-sleep — which
> this deployment does under load — lost the retry with no record, leaving a row
> that simply went quiet and was indistinguishable from a hang. `onRetry` fires
> **before** each backoff and checkpoints the run, which also bumps `fired_at` so
> the scheduler's stale-run reaper does not mark a legitimately backing-off run
> as dead. A failing checkpoint never aborts a retry that would have succeeded.

> **The context floor keeps a tail, and slices by code point.** For every GitHub
> tool here the answer tends to sit at the *end* — `gh_read_pr`'s per-file
> patches, an error line appended after a successful-looking preamble, the last
> entries of a directory listing. Head-only flooring discarded exactly the part
> the model needed and sent it back to re-read the same file, manufacturing the
> loop the repeat guard then has to catch. Same 400 chars, split head/tail.
> Slicing is by Unicode code point: `String.slice` cuts a surrogate pair in half
> and emits a lone surrogate, which then rides into a jsonb column and a JSON
> request body as invalid text.

> **A spill locator must survive the floor that made it necessary.** A spilled
> result is a preview plus a locator, and the locator is the only route back to
> the stored text. It sits on the last line — and the compaction floor keeps 120
> characters of tail, far less than the locator is long. So flooring a spilled
> result destroyed the id and stranded exactly the text whose notice had just
> promised it was *stored, not lost*, leaving the model one way back: re-run the
> tool. Spilling exists to prevent that loop, and flooring was quietly restoring
> it. The floor now splits the locator off, floors only the preview, and
> re-attaches a compact locator — which is itself a valid locator, because a
> result floored in one segment is floored again in the next.

> **A truncation marker states how much it took.** `…[truncated for context]…`
> left the model unable to tell fifty lost characters from fifty thousand, so it
> could not judge whether recovering them was worth a step — and the cheapest
> way to find out is to re-run the tool, which is the loop the repeat guard then
> has to catch. Truncation was *manufacturing* the loop it is supposed to be
> defending against. Every marker now carries the numbers: chars dropped, chars
> total, lines total. Two smaller consequences worth keeping: the compaction
> budget charges a floored result what it **actually** occupies, marker included,
> since the flat 400 it used to charge now under-states the cost; and the
> fallback cap that catches a failed spill keeps a head **and** a tail sliced by
> code point, for the same two reasons the compaction floor does.

> **A model that returns nothing is failing, even when the response says ok.**
> An `ok: true` completion carrying neither content nor tool calls was accepted
> as a finished segment, so the loop broke with empty `finalText` — which
> `segmentMadeProgress` scores as no progress, and two in a row hard-error the
> run. The fallback model was never tried, though the error path directly above
> already falls back: an empty completion is the same failure (the model gave
> nothing usable), it simply is not flagged as an error by OpenRouter, so it has
> to be recognised at the call site rather than by the transient classifier. Both
> paths now share `canUseFallbackModel`, which is where the guards that make a
> fallback worth spending a step live: once per run, never to the model already
> running, and never without time left for the call. Diagnosed and fixed by the
> self-repair routine itself (#88) — the first agent-authored fix to land.

> **Classify retries on the HTTP status, never on the provider's prose.** For
> five days every agent run died on `Key limit exceeded (total limit)`, which
> reads like an exhausted key — so the retry classifier listed it as permanent
> and runs failed in ~0.3s with no retry and no model fallback. It was a **429
> throttle**, and the usage log proved it: the error first fired at **$1.51** of
> lifetime spend on that key, and the same key then spent **$5.87 more**. A real
> cap does not do that. Two bugs compounded — `openrouterOnce` discarded
> `resp.status` whenever the body carried a message, so the 429 never reached the
> classifier, and the deny-list regex short-circuited ahead of the `429|rate.?limit`
> branch that would have caught it. `OrResult` now carries `status`, and status
> wins over text in both directions.

> **…but "always retry it" was the other half of the same mistake — ask the key,
> don't infer.** The rule above was then wrong in the opposite direction, because
> a *throttled* key and a *spent* key emit the **identical** string with the
> identical 429. On **2026-08-04 16:04 UTC** the key genuinely hit its cap
> (**$12.12 of a $12 limit**, `limit_remaining: 0`) and every run since has failed
> — but now nothing failed fast: one run retried a dead key for **8h 45m across
> 45 messages**, then closed with "Retry to resume", which could only fail the
> same way. Both readings of that string are unfalsifiable from the string, so
> **stop classifying it by text or status at all**: OpenRouter reports the answer
> as a number on `GET /api/v1/key`, and `limit_remaining <= 0` is authoritative.
> `isKeyExhausted()` probes it *only* when a key-limit error fires; on `true` the
> run hard-stops with a message naming the real fix, skips the fallback model
> (same key — futile), and does not auto-continue. Three invariants the tests
> pin down: an unreachable or garbled probe must stay **retryable** (an
> OpenRouter API blip must never manufacture a hard stop), a key with **no limit
> set** can never be "exhausted", and a `false` is **never cached** — the run
> above had credit at 15:58 and was spent by 16:04, so a cached "no" would miss
> exactly the case this exists for. Only `true` is final.

### Tracking spend — the usage meter

Every proxied call is logged (tokens + dollar cost) to
`routiner_openrouter_usage`. Two read-only surfaces, both fed by the
**`openrouter-usage`** edge function (which also reads OpenRouter's live credit
balance via `/api/v1/key`, key-side so it never leaves Supabase):

- **CLI:** `node scripts/usage-meter.mjs` — neon terminal meter (credit bar,
  today/month/lifetime spend, by-model, recent calls). `--watch 30` to live-poll,
  `--plain` for logs, `--demo` to see it with sample data and no network.
- **Web:** open **`usage.html`** (also linked from the app's account menu → *Usage*) —
  the same numbers as a cyberpunk dashboard that auto-refreshes.

> Setup adds one table (migration `0008_openrouter_usage.sql`) and one function
> (`supabase functions deploy openrouter-usage`); `dynamic-responder` does the
> logging itself once redeployed.

> Setup (one-time, human): put the key in Supabase edge secrets as
> `OPENROUTER_API_KEY` and deploy the `dynamic-responder` function (Supabase →
> Edge Functions → editor, or `supabase functions deploy dynamic-responder`).
> The proxy runs with JWT verification off, so no Supabase auth header is
> needed. Rotating the key never touches this repo or any session — just update
> the edge secret.
>
> **Hardening the proxy (recommended — all optional edge secrets):**
> - `RESPONDER_SECRET` — shared secret. When set, every proxy call must present
>   it (`x-responder-secret: <secret>`); `scripts/glm.mjs` forwards it from its
>   own `$RESPONDER_SECRET`. Without this the endpoint is world-callable.
> - `MAX_DAILY_SPEND` — daily USD cap (e.g. `5`). The proxy sums today's cost
>   from `routiner_openrouter_usage` and refuses (429) once the cap is hit.
> - `ALLOWED_MODELS` — comma-separated allowlist that replaces the built-in one
>   (the documented GLM/DeepSeek/Kimi/Llama set + `openrouter/auto`). Requests
>   for any other model are rejected 400.
> - `RESPONDER_REASONING_EFFORT` — default `low`. Caps GLM hidden reasoning so
>   `max_tokens` is left for the answer; body field `reasoning` overrides.

## If you're a routine session, or asked to "process the board" / "plan" / "schedule work"

A routine fires by resuming a Claude Code session in this repo with the
routine's prompt as a turn. If that prompt is a **specific task**, just do it
with your tools. If it asks you to **process the board / plan / schedule**, use
the **[`plan-routines`](.claude/skills/plan-routines/SKILL.md)** skill — it has
the exact Supabase REST recipes. The loop:

> **Report back when you finish — with detail.** So the human can see what a
> fired routine actually did (not just that it fired), POST a report to the
> `routiner-admin` edge function at the end of your run — it lands in the app's
> **History** tab (the single record of every run: each entry shows a
> plain-English recap and opens into the full exchange when clicked). `summary`
> is the only required field (a one-paragraph headline), but prefer a *detailed*
> report: pass any of the optional structured fields and the function composes
> them into a rich Markdown entry (URLs and `**bold**` render in History). If the session env has your
> `routineId` (the scheduler
> passes it in the fire body), include it so the run inherits the right owner +
> title:
> ```bash
> ADMIN="https://vonfdzttupyemtomsojy.supabase.co/functions/v1/routiner-admin"
> curl -s "$ADMIN" -H "Content-Type: application/json" -d '{
>   "action": "report",
>   "routineId": "<id-or-omit>",
>   "status": "success",
>   "summary": "<one-paragraph headline of what you did>",
>   "details": "<optional: longer narrative / context / what you found>",
>   "steps":   ["what you did first", "then this", "then that"],
>   "artifacts": [ {"label":"PR #123","url":"https://github.com/.../pull/123"},
>                  "path/to/file/you/changed.ts" ],
>   "models":  ["z-ai/glm-4.7 for the first-pass draft ($0.004)"],
>   "followups": ["anything left for next time / open questions"]
> }' >/dev/null
> ```
> `status` is `success | error | missed`. All fields except `summary` are
> optional — omit any you don't need. Omit `routineId` for ad-hoc runs.

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

## Fixing & merging code without Claude — the code-capable OpenRouter agent

The whole point of reducing Claude-reliance: a **non-Claude** model (Kimi K2.7
Code, GLM-5, GPT-5.6, Gemini…) can now **read the repo, propose a fix as a pull
request, and merge it** — no Claude Code session in the hot path. This is the
`code` tool group on an **OpenRouter agent account** (kind `openrouter-agent`),
executed by the `openrouter-agent` edge function through the **GitHub REST API**
(no shell/sandbox needed — GitHub *is* the sandbox).

**Tools the model gets** (when `code` is checked on the instance and a token is
configured): `gh_read_file` (read a file or list a dir; an omitted path lists the
root, and a 404 that's only a casing miss is corrected automatically instead of
costing the model a step), `gh_read_issue` + `gh_list_issues` (so *"read issue
#57 and fix it"* actually works), `gh_list_prs`, `gh_read_pr` (metadata +
per-file patches), **`gh_propose_edit`** (branch → apply exact find/replace edits
→ open PR — the preferred *fix* path), `gh_propose_change` (whole-file rewrite,
for new files), `gh_comment_pr`, and `gh_merge_pr` (the *merge* path).

> **`gh_propose_edit` is the important one.** `gh_propose_change` requires the
> model to emit the *complete* new file, which is impossible on anything large —
> agents used to read a 1300-line file, realise they couldn't reproduce it, and
> give up ("I don't have a way to get the full file content"). `gh_propose_edit`
> takes `{ path, old_string, new_string }` edits; the edge function reads the
> current file, applies them server-side, and commits the result. `old_string`
> must be unique (or pass `replace_all`), and a bad edit comes back as an
> actionable tool error the model can correct rather than a dead run.

> **The allowlist is the repo boundary; the token is not.** `GITHUB_ALLOWED_REPOS`
> takes `owner/name` patterns where either half may be `*`, so an org is
> authorized once rather than enumerated. Two properties the tests pin, both
> about not widening further than asked: `*` stops at the `/`, so `acme/*`
> cannot span owners or reach into a deeper path; and a pattern is regex-escaped
> before `*` is expanded, so `acme/my.repo` authorizes exactly that and never
> `acme/myXrepo`. A pattern is something the allowlist may hold and never
> something a caller may ask for — `resolveRepo` refuses a `*` in a requested
> repo, which would otherwise match its own allowlist entry and then 404 against
> GitHub with no useful error. And a deployment that sets **neither**
> `GITHUB_REPO` nor `GITHUB_ALLOWED_REPOS` now authorizes nothing rather than
> everything the token can reach: that state is reached by leaving a secret
> unset rather than by setting one wrong, which is exactly how a fail-open
> default goes unnoticed.

> **Edit matching cascades; it does not demand bytes.** Requiring a byte-exact
> `old_string` failed on drift that was never semantic — a model that read the
> file through its own tokenizer emits an em-dash for a hyphen, a curly
> apostrophe for a straight one, LF against a CRLF file, or drops a trailing
> space — and the error told it to "match the file EXACTLY … copy the text
> verbatim", which is advice that cannot work when the copy is already faithful.
> Four passes now run in order and the **first one that hits wins**: exact →
> Unicode punctuation and line endings folded → trailing whitespace ignored →
> indentation ignored. Strictness first is the load-bearing part: an exact match
> is never reinterpreted, and tolerance is only reached for once nothing
> stricter matched. Three properties the tests pin: the indentation pass matches
> **whole lines only** and replaces whole lines, because splicing inside a line
> would keep the file's indent and add the model's on top — a silent
> mis-indentation in Python or YAML is a real bug where a failed edit is only a
> lost step; a needle with **no non-whitespace character** is refused by every
> tolerant pass, since normalization can empty it (matching at every offset) or
> fold `\u200B \u00A0` into two ordinary spaces and hit the first pair in the
> file; and the whitespace scan is **linear**, because rescanning each run from
> every character is quadratic and one 100k-character stretch of spaces — a
> minified asset, a padded fixture — hung the tool loop rather than failing an
> edit. Every non-exact match is reported in the tool result **and written into
> the PR body**, so the reviewer knows the server matched text the model did not
> literally write. Verify with `node --experimental-strip-types
> scripts/test-agent.mjs`.

**Setup (one-time, human — Supabase → Edge Functions → secrets):**

- `GITHUB_TOKEN` — a fine-grained PAT with **Contents** + **Pull requests**
  read/write on the repo(s) you want the agent to touch. Without it the `code`
  checkbox is inert (the tools aren't even offered to the model).
- `GITHUB_REPO` — the default `owner/name` (e.g. `zparxmarketing/routiner`) the
  agent works on when a call doesn't name one.
- `GITHUB_ALLOWED_REPOS` *(optional)* — comma-separated allowlist. Omitted →
  only `GITHUB_REPO` is reachable (safe default; the agent can't wander to other
  repos your token happens to reach). Each entry is `owner/name` and either half
  may be `*`, matching any run of characters that is not a `/` — so `acme/*` is
  every repo under `acme`, `*/name` is that repo under any owner, and `*` (or
  `*/*`) is every repo the token can reach. Widening this is the decision that
  matters: the token says what the agent *could* touch, this says what it *may*.
- `AGENT_ALLOW_MERGE` *(optional)* — set to `true` to let `gh_merge_pr` actually
  merge. **Off by default**: until you set it, the agent opens PRs for you to
  review and merge, and merging returns a clear "disabled" message.
- `AGENT_MAX_STEPS` *(optional, default 5)* — tool-loop steps per edge
  invocation when the `code` group is **not** enabled.
- `AGENT_CODE_MAX_STEPS` *(optional, default 12)* — coding runs get a bigger
  tool-loop budget so read→fix→open→merge fits in one (or a few) segments.
- `AGENT_REASONING_EFFORT` *(optional, default `low`)* — OpenRouter reasoning
  control for agent model calls; keeps GLM from returning `(empty)`.
- `AGENT_MAX_NO_PROGRESS` *(optional, default 2)* — stop auto-continue after
  this many consecutive segments with no tool use and no real text.
- `AGENT_GH_READ_RESULT_CAP` *(optional, default 120000)* — max chars per
  `gh_read_file` result. Large files auto-page; pass `start_line`/`max_lines`.
- `SCHEDULER_REAP_RUN_MIN` *(optional, default 10)* — minutes of silence before
  the scheduler reaper marks a stuck `running` row as `error` (resumable).

**Migrations this path needs:** `0015_tool_output_spill.sql` (the spill table)
and `0016_run_goal.sql` (`routiner_runs.goal`). Apply both before deploying the
agent function. Neither is load-bearing for a run to *finish* — without them
spills fall back to the old inline truncation and `set_goal` writes are dropped
at checkpoint — but you lose exactly the two things they add.

Edge functions **auto-deploy from `main`** via
[`.github/workflows/deploy-edge-functions.yml`](.github/workflows/deploy-edge-functions.yml)
when `supabase/functions/**` changes (after a PR merges). Manual run:
Actions → *Deploy Edge Functions* → Run workflow.

One-time secrets (repo → Settings → Secrets → Actions):
- `SUPABASE_ACCESS_TOKEN` — from [Supabase account tokens](https://supabase.com/dashboard/account/tokens)
- `SUPABASE_PROJECT_ID` — project ref (optional; defaults to this project's ref)

Local / emergency: `supabase functions deploy openrouter-agent dynamic-responder
routiner-scheduler --no-verify-jwt`.

**Use it:** in the app, add an **OpenRouter agent** account, pick a coding model
(Kimi K2.7 Code is the default and a good, cheap fit), check **Fix code
(GitHub)**, and schedule a routine on it — e.g. *"Read issue #57, fix it, open a
PR, and if the change is small and obviously correct, merge it."* The run lands
in **History** (full transcript, resumable) like any other agent run, and every
model call is metered in `routiner_openrouter_usage`. This is the path to *"I
can merge and fix code without Claude."* Keep merge gated until you trust a
given model on your repo; start by letting it open PRs and reviewing them.

## Agents fixing themselves — the self-repair loop

The pieces for a recursively-improving system are now all present, and they're
worth naming because each one was individually blocking:

| Piece | Tool / knob | Without it |
|-------|-------------|-----------|
| **Remember** the plan | `set_goal` (`routiner_runs.goal`) | Between segments the transcript is compacted, so a long run forgot what it was doing — and `AUTO_CONTINUE_PROMPT` asked it to resume from the part that had been floored |
| **Keep** what it read | spill + `read_spill` | A 120k-char file read was 2× the whole context budget, so the next read floored it and the model re-read the same file |
| **See** what went wrong | `read_runs` (in the `read` group) | An agent asked "why do runs fail?" can only guess — it cannot see History at all. One literally reported *"I can't see raw execution History logs from these tools."* `read_runs` excludes the caller's own run row: a diagnosis run checkpoints its actions to `output` as it goes, so without that filter it reads itself and its own recap crowds out the real failures. |
| **Read** the ask | `gh_read_issue` | Runs died asking the human to paste the issue body |
| **Change** code | `gh_propose_edit` | Whole-file rewrites are impossible on real source files |
| **Survive** flakiness | `AGENT_MODEL_RETRIES`, `AGENT_FALLBACK_MODEL` | One `Provider returned error` ended the whole run |
| **Verify** the fix | `scripts/test-agent.mjs` + the **Agent checks** workflow | Nothing checked that a self-authored change actually works — and until CI ran on agent PRs, review was the only gate, so `AGENT_ALLOW_MERGE` could never responsibly be turned on |

`node --experimental-strip-types scripts/test-agent.mjs` runs the reliability
tests with no network and no Deno, so an agent (or CI, or you) can check a change
to the agent loop before it ships.

**The routines.** Two `library` routines ship with the app, both on an OpenRouter
agent instance with `read` + `code` enabled, and both deliberately **not
scheduled** — arm them from the Calendar when you want them running.

*"Verify: agent can open a PR (smoke test)"* is the one to run **first**, and
after any change to the agent loop. It makes one scripted find/replace edit to
`TODO.md` via `gh_propose_edit` and reports the PR URL. It exists because the
diagnosis half of self-repair and the *fix* half fail differently: a run can
diagnose perfectly and still never exercise the PR path, so a broken
`gh_propose_edit` would stay invisible. If the smoke test opens a PR, the
read → edit → branch → commit → PR chain is proven end to end.

*"Self-repair: diagnose failed agent runs"* reads its own failures and fixes one.
Its prompt tells it to pick the most common cause **that is fixable in this
repo's code**, to note configuration/credit problems without stopping on them,
and to confirm with `gh_read_file` that the bug still exists before proposing
anything — several failures in the log always predate fixes that already
shipped. Only when there is genuinely no code-fixable cause should it finish
without a PR.

> **Write that "don't stop on config problems" clause carefully.** The first
> version said *"if the top cause is a configuration or credit problem, do not
> open a PR — report it instead"*. The log was dominated by `Key limit exceeded`,
> so the agent dutifully reported the credit problem and stopped — a correct
> reading of the instructions that produced a no-op every single run. The model
> was obedient, not weak. Instructions that can dead-end will dead-end.

Keep `AGENT_ALLOW_MERGE` **off** for this routine's account until you've watched
a few of its PRs. The loop is: it reads its own failures → proposes a fix → you
review and merge → the edge function auto-deploys from `main` → the next run is
measurably better. Review every PR; a model diagnosing its own logs is a genuine
feedback loop, but it is not a substitute for judgment.

## Lead enrichment — the autonomous ICP flywheel

Scheduled **Perplexity deep research → Command's Review tab**, with no Claude in
the hot path. A `lead-enrichment` edge function (on this same zparx-dashboard
project) reads ICP targets from `lead_enrichment_targets`, runs Perplexity via
OpenRouter (reusing the `dynamic-responder` key), validates + de-dupes, and
inserts `pending` rows into `staged_leads` — which Command's Review tab reads.
Optionally mirrors to Abstrax `competitors` (RoiCal) when a target opts in.

Everything shares one `EnrichedLead` contract
(`supabase/functions/_shared/lead-schema.ts`). Setup, scheduling (pg_cron or a
thin Routiner routine), Abstrax sync, and tuning are in
**[`docs/LEAD_ENRICHMENT.md`](docs/LEAD_ENRICHMENT.md)**. Steer it by editing
`lead_enrichment_targets` (niche × location × decision-maker titles × count);
disabled rows are ignored, so the machine only spins on targets you enable.

**It gap-fills itself.** A discovery run optimises for breadth and often returns
no decision-maker — and in the first 26 leads, that one blank field decided
everything: leads with a named owner got imported, leads without one got
rejected. So after inserting, the engine automatically re-researches each new
lead that is missing a website, phone, or decision-maker, one business at a
time ("find the owner of THIS clinic" is a much easier question than "find me
ten clinics"). Writes are add-only and stamped `enrichment.deepened_at`, so the
pass is idempotent and can never clobber a value you trusted. Also callable
alone as `{"mode":"deepen"}` to drain the queue or back-fill older leads.

**It also refuses to ship fabrications.** Asked for 10 businesses in a city that
didn't have 10, `sonar-pro` padded the list with invented ones — three domains
that don't resolve, four "businesses" sharing a sequential phone block — despite
a prompt telling it in capitals to return fewer. Prompts can't be the control
for that, so every claimed website is now probed (apex **and** `www`) and a lead
is auto-quarantined (`status='rejected'`, score 0) only on **two** independent
signals: the second pass corroborated nothing **and** the site doesn't exist.
Either alone caps the score at 20 and records why, but keeps the lead visible —
a real business with no website must never be thrown away, and a timeout is
never read as fabrication. Quarantine counts appear in the History recap.

Two smaller fixes ride along: known business names go into the prompt as an
exclusion list (one run had been coming back 5-of-6 duplicates), and leads whose
address names another city or state are dropped as `offArea` (Huntsville targets
were returning Birmingham and Chattanooga businesses). Verify with
`node --experimental-strip-types scripts/test-lead-enrichment.mjs`.

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
  that fire as independent, parallel sessions. Also `model_policy` jsonb — the
  optional auto-routing table (`task_type → complexity → model`) edited in
  Settings and read by **both** the app and the scheduler; null = built-in
  default (`js/model-router.js`).
- **`routiner_tool_spills`** — oversized tool results, stored whole so the
  model's context can carry a preview + locator instead of a truncated blob.
  RLS per user; cascade-deleted with the run. Disposable: losing a row costs a
  re-read, never work.
- **`routiner_runs`** — run log (one row per fire). Also carries `goal`
  (`{objective, done[], remaining[], phase, blocked_reason}`), the one part of a
  run's intent that compaction never touches. Two timestamps that mean
  different things: `started_at` is when the run began and never moves;
  `fired_at` is bumped at every agent checkpoint, so it is the run's *last
  activity*. History reads the pair as "started 09:12 · took 41m" (rows written
  before `started_at` existed show no duration rather than an invented one).

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
- **Nothing the browser waits on to boot may be third-party, and nothing may
  fail silently.** For a long time the app "frequently had trouble loading —
  refresh a few times and it works". That was never one bug; it was four ways to
  reach the same blank white page, and a blank page hides its own cause, which
  is why it read as flakiness rather than as a defect. Verified end-to-end in a
  real browser by **`node scripts/test-boot.mjs`** (Playwright; skips cleanly if
  Chromium isn't installed) — run it if you touch the boot path. That script now
  also covers the **New chat** composer end to end (the pane comes up on an empty
  Chat, and sending posts a fresh run on the configured instance, carrying its
  model, tools, a title from the message and the reader's timezone) — the only
  automated coverage the Chat pane has.
  - **supabase-js is vendored** at `js/vendor/supabase-js.js`, *not* imported
    from esm.sh. A CDN import put two serial third-party round trips in front of
    every cold load (esm.sh resolves the unpinned `@2` tag with a short-TTL
    redirect stub, then serves the build) — and a module that fails to fetch
    takes the whole graph with it. Regenerate with
    `node scripts/vendor-supabase.mjs [version]`; it is a hand-run script, not a
    deploy step (the site publishes the repo as-is).
  - **The Google Fonts stylesheet loads non-blocking** (`media="print"`,
    flipped to `all` on load). A plain `<link rel="stylesheet">` to a third-party
    host blocks first paint, so a slow font CDN produced an *empty* page — not an
    unstyled one. Measured: with the blocking link, a font host that hangs paints
    nothing for 10s+; the test asserts this behaviourally, not just by attribute.
  - **`getSession()` is raced against a timeout**, with the stored session as a
    fallback. supabase-js serializes auth-storage access behind a Web Lock, and a
    lock held by a tab the OS killed — routine on iPadOS, which suspends
    backgrounded tabs — never resolves. `init()` awaited it with no timeout, so
    one wedged lock froze boot outright.
  - **The first data load retries once, then shows a *Try again* button.** It
    used to toast the error over an empty `<main>`, leaving refresh as the only
    way forward. Related: `showApp()` now paints a loading state immediately —
    before, a signed-in user stared at the sign-in card they had just used until
    `loadAll()`'s `render()` finally replaced it.
  - **`index.html` carries a boot watchdog** (a classic script, so it survives
    the module graph being what's broken) plus a placeholder in `#view`. If
    nothing has booted in 12s, or a script errors, it says so and offers Reload.
    `js/app.js` calls `window.__routinerBooted()` / `__routinerBootFailed()`.
- **Shell:** one top rail (`.topbar`) carries the brand, the nav tabs and the
  actions (clock · budget chip · a **+** for a new routine · account menu); the body below it
  is the only scrolling region. The rail stays a single row down to 1140px —
  shedding the clock, then the budget chip, then tightening the tabs as space
  runs out — so an iPad in landscape still gets one row; below that the nav wraps
  to a full-width second row, which buys those chips back. Verified for overflow
  at 20 widths from 1920 to 360; only phone widths scroll the nav, and a fade on
  its trailing edge says so.
- **The tab order leads with the work.** `Chat` (the `history` view — the runs
  and their transcripts) sits first, is what the app opens on, and carries no
  count badge; then Calendar,
  Board, Scheduled, Library, Archived. The separate model-testing Chat view is
  gone. The view id stays `history` throughout the code — only the label reads
  "Chat".
- **The master fire switch lives in Settings**, not the top rail: it is a
  rarely-flipped safety catch, not a per-session control. `paintFireSwitch` /
  `toggleFireSwitch` no-op when the drawer is closed, and it saves on flip rather
  than on Save. Note the tradeoff — with it out of the rail there is no
  at-a-glance sign that firing is paused.
- Key views in `app.js`: **Board** (`renderBoard`), **Calendar**
  (`renderCalendar` — full 24h, blocks colored by trigger within a per-account
  hue family), Scheduled / Library / Archived, **History** (`renderHistory`),
  the **budget forecast** (top-bar chip →
  projected spend from the scheduled queue), the Settings **accounts & triggers**
  manager, and the create/edit **drawer**. The Library holds every non-archived
  routine — scheduling doesn't remove it, only archiving takes one off the air.
- **The shell is exactly one viewport tall, and the Chat pane got stuck twice
  getting there.** Symptom both times, iPadOS only: the run list and transcript
  would not scroll, content just ran off the bottom of the window. Cause both
  times: a link in the height chain that Safari would not resolve, leaving the
  columns unbounded so no scroll container existed, while the `overflow: hidden`
  above them hid the evidence.
  - *First:* the pane took a percentage height (`#view { height: 100% }`)
    against a flex-derived parent.
  - *Then:* `.hx` was a **grid** whose implicit row is `auto` — stretching an
    auto row to a definite container height is a step Safari fumbles, so the row
    sized to its content instead.
  So today: `.content--flush` is `position: relative`, `#view` is
  `position: absolute; inset: 0` (a definite box that needs no ancestor height
  to resolve), and `.hx` is a **flex row** — never grid — with `min-height: 0`
  and `overflow: hidden` on both columns. `trackAppHeight()` measures
  `visualViewport.height` into `--app-h` (dvh stays the fallback), which also
  keeps the reply box above the on-screen keyboard.
- **Two smaller things made the pane *feel* broken even once it worked.** Both
  are worth not reintroducing:
  - The scroll columns had `overscroll-behavior: contain`. When a column has
    nothing to scroll — most `[Leads]` recaps are four lines — `contain`
    swallows the gesture entirely, so there was no scroll *and* no rubber-band,
    which reads as frozen. Nothing outside these columns scrolls, so containment
    bought nothing; it's gone.
  - The vendored token scale defines `--sp-1..4, 6, 8, 12, 16, 24` but **no
    `--sp-5`**. A bare `var(--sp-5)` makes the whole declaration invalid and the
    padding computes to `0`, silently — which is why the transcript, its header
    and the composer all sat flush against their edges. Always write
    `var(--sp-5, 20px)`; `.card` and `.cfg-sep` already did.
- **`fitHistoryPane()` is the belt to that braces.** After every render and on
  every resize it measures the space between `.hx`'s top edge and the bottom of
  the visual viewport, and pins the pane there in pixels if the laid-out height
  disagrees by more than 1px. Measured space is engine-independent, so the pane
  is scrollable even if some future engine mis-resolves the CSS. It writes
  nothing when the CSS is working (so it can't quietly become load-bearing).
  **No automated test covers this today** — the `round4` suite this file used to
  point at is not in `scripts/`. If you touch the height chain, verify the pane
  scrolls by hand on a narrow viewport, and treat restoring that coverage as
  worthwhile: the failure mode is silent, and it has recurred twice.
- **History is a Claude-Code-shaped workspace, not a list of cards.** A left rail
  (`#hx-rail`) lists every run — searchable, filterable to failures — and the
  right pane (`#hx-main`) holds the selected run's whole exchange *flat against
  the UI*: transcript scrolling in place, reply box pinned to the bottom. There is
  no modal. **A chat starts here, not from a routine.** The rail's **＋ New
  chat** button (and the pane itself, when there are no runs — the empty state is
  a composer, not the dead-end card it used to be) opens `newChatPaneHtml`: pick
  an instance, type, send. `startChat` posts the same fresh-run body a routine
  fire does, minus the `routineId`, so the thread it opens is an ordinary run and
  every existing affordance — reply, Retry, Stop, delete, the live poll — works
  on it unchanged; the title comes from the first line of the message, since a
  chat has no routine to borrow a name from. Two things to keep: `selectedRun`
  returns the `NEW_CHAT_ID` sentinel *stickily* (falling back to the newest run
  would throw away a half-typed message the moment the 8s poll landed), and
  `renderRunPane` repaints the new-chat pane only when its signature actually
  changes, because another run finishing must not rewrite the pane out from
  under the reader's cursor. `renderHistory` builds the workspace once; every later repaint (the
  8s live poll, a filter flip, a finished reply) goes through `refreshHistory`,
  which re-renders in place so the search box keeps focus, the reader keeps their
  scroll position and an unsent draft survives (`runDrafts`). `selectRun` swaps
  the pane; `continueRun` still posts `{ runId, prompt }` to the
  `openrouter-agent` function, and Stop/Retry live in the pane header.
  Below 900px the rail becomes an off-canvas panel that slides over the
  transcript — via the **☰ Runs** button, an edge swipe, the scrim or Escape.
- **Any run row can be replied to.** `isContinuable` is just "has a runId": the
  `openrouter-agent` continue path seeds a system prompt, uses the row's stored
  `output` as the assistant turn when there is no transcript, and falls back to
  the default model when the row carries none — so a lead-enrichment recap or a
  Claude-trigger report answers as readily as a full agent thread. `isAgentRun`
  is the stricter test, and it gates **Retry**/**Stop** only: retrying a
  lead-enrichment row would run the agent loop, not the enrichment engine. The
  only rows with no composer are the ones synthesised from a routine that never
  logged a run.
- **Rail rows can be deleted, two ways, because touch and pointer need
  different affordances.** On touch: **swipe the row left** to reveal Delete
  (`wireRowSwipe`), the iOS list gesture. On a pointer: hover reveals a trash,
  which opens a confirm strip in the row — there is no undo and the row is the
  only copy of that transcript. The hover trash is hidden under
  `@media (hover: none)` because iPadOS fakes `:hover` on tap and drops it on
  the next tap, so it works *exactly once* — which is precisely how it was
  reported. Both paths call `deleteRun`. Offered on run-backed rows only, and
  never while one is running (stop it first; deleting mid-write just orphans the
  agent's checkpoints). Rail rows are `div[role=button]`, not `<button>`, so
  they can hold those controls — buttons cannot nest.
  Two gesture details that matter: `touch-action: pan-y` on the row keeps
  vertical scrolling native while the horizontal axis is ours, and
  `wireRailSwipe` (the mobile rail's open/close swipe) bails when a gesture
  starts on a row, so the two never fight.
  And one CSS detail that is easy to lose: the row needs **`flex: 0 0 auto`**.
  `overflow: hidden` (which hides the Delete panel) makes the row a scroll
  container, and a scroll container's automatic minimum size is zero — so as a
  flex item in `#hx-list` every row shrank to a fraction of its content and the
  whole list rendered as clipped slivers. It only showed up with a long list,
  and "the list scrolls" stayed true throughout, which is why the first tests
  missed it — and why nothing guards it now: the `squash` case that asserted row
  height against content height at 197 runs is no longer in `scripts/`. Check a
  long list by hand until it is back. The rail still closes via ☰, the
  scrim, Escape, or a swipe starting on its header.
- **Run now on an agent instance lands in Chat** (`openRunInChat`) with the new
  run selected and the reply box focused, rather than leaving the reader to go
  find it. Claude-trigger fires create no row at fire time — the session reports
  back later — so there is nothing to jump to there.
- **A History row answers "where did this get to, and how long did it take."**
  The snippet is `lastWorkText` — the transcript read backwards to the last thing
  actually said or the last tool reached for, not the run's opening summary — so
  a row keeps showing its most recent real move. The stamp is the *start* time
  plus elapsed (`runDurationLabel`): `took 41m` for a single-round run,
  `running 6m` while one is live (the 8s poll ticks it), and `over 2d` for a
  thread you replied to later — that verb keeps elapsed time from claiming the
  model worked the whole span. Rows still sort by last activity, so a
  freshly-continued thread surfaces even though its stamp is older.
- **Past calendar blocks rename in place.** A block whose time has passed is a
  record of something that happened, so it carries a pencil that swaps its title
  for an input right on the grid (`startBlockRename` — Enter saves, Escape
  reverts, clicking away saves). Future blocks still open the drawer on tap.
  One thing to know: a recurring routine is a single row behind every one of its
  blocks, so renaming any of them renames the series — the toast says so.
- DB schema: `supabase/schema.sql` (one-paste setup for a fresh project) +
  incremental `supabase/migrations/`.
- Styling follows the ZPARX design system: dark-mode-first; lime and yellow are
  dark-surface-only accents.

> **Legacy:** an older file-based executor (a `routines/` folder with
> `scheduled/`/`done/`/`logs/` subfolders) predated the Supabase backend and has
> been removed. Plan/schedule through Supabase as above.
