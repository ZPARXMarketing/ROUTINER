# TODO — OpenRouter agent GitHub security hardening

Action items from the security audit of how OpenRouter agents get GitHub write access (`code` tool group → `gh_*` tools in `supabase/functions/openrouter-agent/index.ts`).

**Status key:** `[ ]` open · `[x]` done  
**Priority:** P0 = production blocker if `GITHUB_TOKEN` is live · P1 = reduce blast radius · P2 = defense in depth

Related code: `supabase/functions/openrouter-agent/index.ts`, `js/app.js` (`agentPost` / `fireAgent`), `supabase/functions/routiner-scheduler/index.ts`.

---

## P0 — Production blockers (if `GITHUB_TOKEN` is live)

### Auth & exposure

- [x] **Hard-auth `openrouter-agent`** *(shipped — solo-friendly)*
  - Accepts: valid user JWT (`Authorization` or body `accessToken`), **or** service-role Bearer (scheduler), **or** `RESPONDER_SECRET`.
  - Unauthenticated POSTs get `401` — random internet can no longer drive `GITHUB_TOKEN` / OpenRouter.
  - Browser still uses CORS-simple `text/plain` POST; token rides in JSON body (see `agentPost`).
  - Continuations by user JWT are scoped to that user's run rows.

- [x] **CORS-safe auth without preflight** *(shipped)*
  - Kept `text/plain` body path (gateway OPTIONS still broken).
  - `agentPost` attaches `accessToken` from the session; scheduler keeps service-role headers.

- [ ] **Confirm production deploy**
  - Redeploy `openrouter-agent` so the hard-auth code is live (`supabase functions deploy openrouter-agent`).
  - Smoke: signed-out / no-token POST → 401; signed-in Run-now agent → works; History continue → works; scheduler agent fire → works.

### Tool authorization (server-side)

- [ ] **Do not trust client-supplied `body.tools` for capability grants** *(deferred for solo use)*
  - You want models free to open PRs with your GitHub key when `code` is enabled.
  - Auth is the real boundary; re-binding tools to Settings is optional later if multi-user.

- [x] **Hard allowlist at `runTool` execution time** *(shipped)*
  - Only executes tools whose group is in the run's `enabled` set.
  - Unknown / hallucinated names (incl. `gh_*` when `code` is off) are rejected.
  - `code` still requires `GITHUB_TOKEN`; merge still requires `AGENT_ALLOW_MERGE`.

---

## P1 — Reduce blast radius when `code` is authorized

### Write surface

- [x] **Path policy for `gh_propose_change`** *(shipped — awaiting merge/deploy)*
  - Blocks `.github/**`, `.env*`, key/cert and credential-like paths; rejects `..` segments.
  - Caps files per PR (`AGENT_GH_MAX_FILES`, default 10) and chars per file (`AGENT_GH_MAX_FILE_CHARS`, default 400k).

- [x] **Safer branch handling** *(shipped — awaiting merge/deploy)*
  - Forces `agent/` branch prefix via `normalizeAgentBranch`.
  - On create `422`, **fails** (no silent overwrite of existing branches).
  - Base branch must be the repo **default** branch only.

- [x] **Safer merge (`gh_merge_pr`)** *(shipped — awaiting merge/deploy)*
  - `AGENT_ALLOW_MERGE` still **off** by default.
  - When enabled: only merges PRs whose head ref starts with `agent/` and is open.
  - Still no CI-green check (GitHub branch protection remains the backstop).

### Defaults & product

- [x] **Default tools: `code` off** *(shipped — awaiting merge/deploy)*
  - New agent accounts/instances default to `DEFAULT_AGENT_TOOLS` (read/research/write only).
  - Explicit Settings checkbox still enables GitHub when you want PRs.

---

## P2 — Defense in depth

### GitHub-side (operator / repo config)

- [ ] Use a **fine-grained PAT** on **one** repo only; minimal Contents + Pull requests.
- [ ] Set `GITHUB_REPO` and leave `GITHUB_ALLOWED_REPOS` narrow (or omit for default-only).
- [ ] Branch protection / rulesets on `main`: required reviews, status checks; consider blocking workflow file changes from non-admins.
- [ ] Keep `AGENT_ALLOW_MERGE` off until a given model is trusted on this repo.

### App / agent loop

- [ ] **Per-run audit log:** invoker user id, tools enabled, every `gh_*` call (repo / path / PR #) in a dedicated table or structured History fields.
- [ ] **Continuation auth:** re-check user ownership of `runId`; re-resolve tools from current settings (or freeze tools but still require auth). Disabling `code` later should not leave old runs fully armed without login.
- [ ] **Prompt-injection hygiene:** treat tool results (notes, PR bodies, file contents) as untrusted; system prompt alone is not a control.
- [ ] **Two-man rule for merge:** human “approve merge” that is not freely model-callable without a separate signed confirmation.
- [ ] Optional: separate PATs for read vs write if some agents only need research/read.

### Spend / abuse

- [ ] Ensure `MAX_DAILY_SPEND` is set in production (does not fail open silently without ops visibility).
- [ ] Rate-limit unauthenticated or abusive agent invocations once hard auth exists.

### Docs / honesty

- [ ] Update comments/docs that claim gateway “publishable key” gating for `openrouter-agent` if the app still strips auth headers.
- [ ] Document the real trust model: edge secrets + GitHub branch protection are the hard controls until P0/P1 land.

---

## Findings reference (why these todos exist)

| Severity | Finding |
|----------|---------|
| **Critical** | Endpoint often unauthenticated (`verify_jwt=false` + optional secret; browser sends no auth). Anyone who can POST can pass `tools:["code"]` and drive `GITHUB_TOKEN`. |
| **Critical** | Server trusts client `body.tools`; Settings checkboxes are not a security boundary. |
| **Critical** | `runTool` does not re-check the enabled tool set — hallucinated `gh_*` names can still hit GitHub if the token is set. |
| **High** | Unrestricted write paths (including `.github/workflows/**`); any base/branch; full file overwrite. |
| **High** | `gh_merge_pr` can merge **any** PR in the repo when merge is enabled, not only agent-created ones. |
| **High** | Branch create `422` continues and may write onto an existing branch. |
| **High** | New agent accounts default with `code` enabled. |
| **Medium** | Prompt/tool-result injection; secrets in file reads land in History; continuation keeps old tool grants; single shared PAT / single-tenant owner model. |
| **Low** | Comment spam; docs oversell gating; no strong “who invoked the agent” identity on GitHub when the edge function is unauthenticated. |

### What’s already in good shape (do not regress)

- [x] `code` tools omitted from model schema if no `GITHUB_TOKEN`
- [x] Repo allowlist via `GITHUB_REPO` / `GITHUB_ALLOWED_REPOS` (`resolveRepo`)
- [x] `AGENT_ALLOW_MERGE` default off
- [x] Bounded tool steps + wall-clock deadline
- [x] No shell/sandbox (GitHub REST only)
- [x] Changes flow through branch + PR (reviewable if merge stays off)
- [x] Model allowlist for OpenRouter billing

---

## Suggested implementation order

1. Auth on the edge function + fix client/scheduler to send credentials  
2. Server-side tool resolution + `runTool` allowlist  
3. Default `code` off + path/branch/merge guards  
4. Audit logging, continuation hardening, operator docs  

When an item ships, check it off here and note the PR/commit in the same line.
