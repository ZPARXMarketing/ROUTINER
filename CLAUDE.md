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
| `AGENT_CONTEXT_TOOL_BUDGET` | `60000` | Total chars of tool output kept at full size in the model's context. Older results are floored at 400 chars |
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
> wins over text in both directions. Retrying a genuine cap is free anyway — a
> rejected call bills $0 and logs 0 tokens — so when the two signals disagree,
> prefer the retry.

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
> must match exactly and be unique (or pass `replace_all`), and a bad edit comes
> back as an actionable tool error the model can correct rather than a dead run.

**Setup (one-time, human — Supabase → Edge Functions → secrets):**

- `GITHUB_TOKEN` — a fine-grained PAT with **Contents** + **Pull requests**
  read/write on the repo(s) you want the agent to touch. Without it the `code`
  checkbox is inert (the tools aren't even offered to the model).
- `GITHUB_REPO` — the default `owner/name` (e.g. `zparxmarketing/routiner`) the
  agent works on when a call doesn't name one.
- `GITHUB_ALLOWED_REPOS` *(optional)* — comma-separated allowlist. Omitted →
  only `GITHUB_REPO` is reachable (safe default; the agent can't wander to other
  repos your token happens to reach).
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
| **See** what went wrong | `read_runs` (in the `read` group) | An agent asked "why do runs fail?" can only guess — it cannot see History at all. One literally reported *"I can't see raw execution History logs from these tools."* `read_runs` excludes the caller's own run row: a diagnosis run checkpoints its actions to `output` as it goes, so without that filter it reads itself and its own recap crowds out the real failures. |
| **Read** the ask | `gh_read_issue` | Runs died asking the human to paste the issue body |
| **Change** code | `gh_propose_edit` | Whole-file rewrites are impossible on real source files |
| **Survive** flakiness | `AGENT_MODEL_RETRIES`, `AGENT_FALLBACK_MODEL` | One `Provider returned error` ended the whole run |
| **Verify** the fix | `scripts/test-agent.mjs` | Nothing checked that a self-authored change actually works |

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
- **`routiner_runs`** — run log (one row per fire). Two timestamps that mean
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
  Chromium isn't installed) — run it if you touch the boot path.
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
  nothing when the CSS is working (asserted in the tests, so it can't quietly
  become load-bearing). If you touch this layout, run `round4` — it sabotages
  the chain on purpose and checks the guard still rescues it.
- **History is a Claude-Code-shaped workspace, not a list of cards.** A left rail
  (`#hx-rail`) lists every run — searchable, filterable to failures — and the
  right pane (`#hx-main`) holds the selected run's whole exchange *flat against
  the UI*: transcript scrolling in place, reply box pinned to the bottom. There is
  no modal. `renderHistory` builds the workspace once; every later repaint (the
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
  missed it: `squash` now asserts row height against content height at 197 runs. The rail still closes via ☰, the
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

> **Legacy:** the `routines/` folder (`scheduled/`, `done/`, `logs/`,
> `README.md`) is an older file-based executor that predates the Supabase
> backend. It is retained for reference only — the app no longer reads or writes
> those files. Don't use it; plan/schedule through Supabase as above.
