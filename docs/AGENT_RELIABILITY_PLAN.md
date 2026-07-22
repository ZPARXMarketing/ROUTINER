# Agent Reliability Plan — fixing timeouts, "(empty)" runs, and runs that never end

**Status: plan only — not yet implemented.** This is the agreed fix design for
the OpenRouter agent problems: GLM-class models time out or return `(empty)`
and accomplish nothing, and runs appear to "keep going forever" in History.
Once landed, agent runs either finish or fail honestly within minutes — the
prerequisite for letting the code-capable agents fix things themselves.

## Root causes (verified in the source)

1. **No watchdog / stale-run reaper — the "runs forever" symptom.**
   `openrouter-agent` inserts a `routiner_runs` row with `status:"running"`
   *before* its loop (`insertRunningRun`, `supabase/functions/openrouter-agent/index.ts:846`)
   and only flips it to `success`/`error` if the handler survives to the end
   (index.ts:955-961, 1040-1047). Supabase kills edge functions at ~150s wall
   clock; when that happens mid-segment, the row stays `"running"` forever.
   Nothing — scheduler, edge function, or UI — ever reconciles it.
   `renderHistory` (`js/app.js:963-1005`) shows "Working in background…"
   indefinitely for those rows.

2. **GLM's hidden reasoning tokens starve the reply — the "can't do much"
   symptom.** `openrouter()` (index.ts:296-328) and `dynamic-responder`'s
   fetch (`supabase/functions/dynamic-responder/index.ts:147-164`) send
   `max_tokens` (3072 / 2048 defaults) with **no `reasoning` parameter**. GLM
   4.7/5 are reasoning models: they burn the whole budget thinking, return no
   text → `(empty)` after 13–50s.

3. **Timeouts feed an auto-continue chain with no progress check.** A model
   timeout matches `isTransientModelError` (index.ts:658) → segment marked
   `incomplete` → `scheduleAutoContinue()` (index.ts:677-705) spawns another
   ~100s segment, capped only by `AGENT_MAX_AUTO_CONTINUES` (5). A GLM that
   times out every call burns the whole 6-segment chain (~10 min) making zero
   progress, checkpointing "Continuing… (segment N)" the whole time.

4. **Small step budgets + doc drift.** Real defaults: `AGENT_MAX_STEPS` 5,
   `AGENT_CODE_MAX_STEPS` 8 (index.ts:71-72). CLAUDE.md claims 12 for code
   and "a 6-step default" — the docs overstate reality.

## The fix — six surgical changes, no DB migrations

### 1. Stale-run reaper (`supabase/functions/routiner-scheduler/index.ts`)

The scheduler already fires every minute via pg_cron — add a `reapStaleRuns()`
pass at the top of the handler, wrapped in try/catch so it can never block
routine firing.

- New tunable: `SCHEDULER_REAP_RUN_MIN`, default **10** minutes. Rationale:
  every segment start and every tool batch bumps `fired_at` via
  `checkpointRun` (index.ts:664-673), and a segment is capped at
  `AGENT_DEADLINE_MS` = 100s, so a live run never goes >~3 min between bumps.
  10 min of silence = dead, with 3× margin.
- Query: `GET routiner_runs?status=eq.running&fired_at=lt.<now - REAP_MIN>`
  (select `id,title,output`, limit ~20). Then per-row **conditional** PATCH
  (`?id=eq.X&status=eq.running&fired_at=lt.<cutoff>` — the same atomic-claim
  pattern `processOne` uses) setting `status:'error'` and prepending to the
  output: *"⚠ Run died mid-flight — the edge function was killed before it
  could finish. Partial progress is saved; open this run and Retry (or reply
  'continue') to resume."* Do **not** touch `messages` — the transcript stays
  resumable.
- Only the agent ever writes `status:'running'` (the scheduler's `logRun`
  writes success/error/missed), so the reaper cannot touch Claude-trigger rows.
- **No auto-resurrection.** A wall-clock death usually means the model itself
  is timing out; auto-resuming re-burns the same money on the same failure,
  and there's no once-only guard without schema changes. The UI Retry button
  (change 5) covers recovery. Auto-resume is a possible future follow-up.

### 2. Reasoning-token control (fixes GLM at the source)

**`supabase/functions/openrouter-agent/index.ts`** — in `openrouter()`
(~index.ts:312-318), add a `reasoning` object to the request body, built from
new env `AGENT_REASONING_EFFORT` (default **`low`**):

| env value | body sent |
|---|---|
| `low` (default) / `medium` / `high` | `reasoning: { effort: <v>, exclude: true }` |
| `off` / `none` | `reasoning: { enabled: false }` |
| `unset` | omit the param entirely (today's behavior — kill switch) |

OpenRouter drops unsupported params for non-reasoning models, so this is safe
for Kimi/DeepSeek/Llama. Allow a per-call `opts.reasoning` override; the
`web_research` sub-call passes nothing. Tool-loop steps don't need deep
thinking — low effort leaves the `max_tokens` budget for actual output and
cuts latency well under `CALL_TIMEOUT_MS` (50s). Keep `AGENT_MAX_TOKENS` at
3072: the reasoning cap is the real fix; raising tokens alone just trades
empties for timeouts.

**`supabase/functions/dynamic-responder/index.ts`** — same builder with env
`RESPONDER_REASONING_EFFORT` (default **`low`**); an explicit `reasoning`
field in the request body wins over the env. When content comes back empty,
keep returning `"(empty)"` (back-compat) but append the finish reason when
available — e.g. `"(empty — hit max_tokens)"` — so callers can tell
starvation from a genuine blank.

**`scripts/glm.mjs`** — new `--reasoning <low|medium|high|off|default>` flag,
default `low`, forwarded as the `reasoning` body field. The 45s abort,
2-attempt retry, and `--ping` behavior are unchanged.

### 3. No-progress circuit breaker (`openrouter-agent/index.ts`)

Stop the auto-continue chain when it isn't achieving anything. No DB state —
carry the streak in the auto-continue POST body exactly like `continueDepth`:

- New tunable: `AGENT_MAX_NO_PROGRESS`, default **2**.
- `scheduleAutoContinue(runId, depth, noProgress)` includes `noProgress` in
  the POST body (~index.ts:688-693); the continuation handler reads
  `Number(body.noProgress) || 0` next to `continueDepth` (~index.ts:885).
- **Progress definition** (computed after `runAgentLoop` returns): the
  segment made progress iff `actions.length > 0` (tools actually ran) OR
  `finalText` is real content (not a `Paused on step…` / budget-stop /
  empty). No progress → streak+1; progress → reset to 0. The empty-content
  case (no tools, no text) is exactly the GLM failure mode and is covered.
- At both `scheduleAutoContinue` call sites (continuation path
  index.ts:951-953, fresh-run path index.ts:1036-1038): if the streak
  reaches the cap, don't continue — finalize with `status:'error'` and
  output like *"Stopped: 2 consecutive segments made no progress (model
  timing out or returning nothing). Try a faster model (kimi-k2.7-code,
  deepseek-chat) or reply to retry."*
- A chain that dies mid-flight (lost POST) is handled by the reaper, so
  in-body state is sufficient.

### 4. Better defaults

- `AGENT_CODE_MAX_STEPS` default 8 → **12** (matches what CLAUDE.md already
  documents; safe now that the breaker + reaper bound runaway, and
  reasoning-low drops per-step latency to ~10-15s).
- Leave `AGENT_MAX_TOKENS` (3072), `AGENT_CALL_TIMEOUT_MS` (50s),
  `AGENT_MIN_MODEL_CALL_MS` (25s), `AGENT_DEADLINE_MS` (100s), and
  `AGENT_MAX_AUTO_CONTINUES` (5) unchanged — with reasoning fixed, the
  existing budget math works.

### 5. UI honesty + one-click retry (`js/app.js`, small `css/app.css` class)

- New const `RUN_STALE_MS = 10 * 60 * 1000` (client-side mirror of the reaper
  threshold). In `renderHistory()`'s row fn (~js/app.js:975):
  `const stale = busy && it.time && (Date.now() - new Date(it.time)) > RUN_STALE_MS`
  → status label **"May have stalled"** (warning style, not busy), meta
  "Open to retry" instead of "Working in background…". The reaper flips these
  to `error` within minutes; this just stops the UI lying in the meantime.
- Run modal: the reply composer already renders for any continuable run
  (`runModalHtml`, js/app.js:1050-1056 gates only on `isContinuable`), so no
  gating change. Add a **Retry** button (shown for `error` runs and stale
  running runs) that calls the existing
  `continueRun(it, '[retry] Resume the task from the transcript and finish it.')`
  — zero new network paths. Important: it must reuse `agentPost()`'s
  simple-CORS `text/plain` POST (js/app.js:1099-1108) — do not add headers;
  the Supabase gateway 500s CORS preflights on this project.
- Optional, fine to defer: a 30s `setInterval` on `loadAll()` while History
  is open and any run is `running`.

### 6. CLAUDE.md sync

- Fix the step-budget text: `AGENT_MAX_STEPS` default 5,
  `AGENT_CODE_MAX_STEPS` default 12 (the current text claims 12 vs a "6-step
  default"; the code was 5/8).
- Document the new knobs: `AGENT_REASONING_EFFORT`,
  `RESPONDER_REASONING_EFFORT`, `AGENT_MAX_NO_PROGRESS`,
  `SCHEDULER_REAP_RUN_MIN`, the `reasoning` body field on
  `dynamic-responder`, and `glm.mjs --reasoning`.
- Amend the GLM field notes: the `(empty)` failures were reasoning-token
  starvation; with `reasoning: low` GLM should be usable — **re-benchmark
  before trusting** (`node scripts/glm.mjs --model z-ai/glm-4.7
  --max-tokens 800 "<task>"`). Keep kimi-k2.7-code and deepseek-chat as the
  reliable agent picks until then.
- Note the reaper: a run silent >10 min is auto-marked `error` and can be
  resumed from History.

## Files to touch

| File | Change |
|---|---|
| `supabase/functions/routiner-scheduler/index.ts` | `reapStaleRuns()` pass + `SCHEDULER_REAP_RUN_MIN` |
| `supabase/functions/openrouter-agent/index.ts` | `reasoning` param, no-progress breaker, `CODE_MAX_STEPS` 12 |
| `supabase/functions/dynamic-responder/index.ts` | `reasoning` passthrough + env default, empty-reason hint |
| `scripts/glm.mjs` | `--reasoning` flag |
| `js/app.js` (+ `css/app.css`) | stale detection, Retry button |
| `CLAUDE.md` | doc sync |

All new behavior sits behind env knobs with safe defaults. After merging,
deploy: `supabase functions deploy openrouter-agent dynamic-responder
routiner-scheduler` (human step — edge functions don't auto-deploy from git).

## Verification checklist (post-implementation)

1. **Reasoning:** `node scripts/glm.mjs --model z-ai/glm-4.7 --max-tokens 800
   "Write isValidHexColor in JS. Output only code."` → real code, not
   `(empty)`, well under 45s. `--reasoning off` and `--reasoning default`
   plumb through; `node scripts/glm.mjs --ping` still exits 0.
2. **Agent loop:** curl `openrouter-agent` with a small prompt,
   `model: z-ai/glm-4.7`, `tools:["read"]` → `status:'success'` with
   non-empty output; a usage row lands in `routiner_openrouter_usage`.
3. **Reaper:** insert a fake stuck row (`status:'running'`,
   `fired_at = now() - 20 min`) via service-role REST, curl the scheduler →
   row flips to `error` with the died-mid-flight message, `messages` intact;
   fresh `running` rows untouched.
4. **Breaker:** temporarily set `AGENT_CALL_TIMEOUT_MS=3000` (every model
   call times out), fire a fresh run → chain ends `error` with the
   no-progress message after 2 dead segments, not 5 continues.
5. **UI:** with a stuck row present pre-reap, History shows "May have
   stalled"; open it → Retry sends a continuation that resumes from the
   transcript.
6. **Static:** `deno check` all three edge functions (no test suite exists).
