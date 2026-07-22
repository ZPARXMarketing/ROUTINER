# TODO — OpenRouter agent GitHub security hardening

Action items from the security audit of how OpenRouter agents get GitHub write access (`code` tool group → `gh_*` tools in `supabase/functions/openrouter-agent/index.ts`).

**Status key:** `[ ]` open · `[x]` done  
**Priority:** P0 = production blocker if `GITHUB_TOKEN` is live · P1 = reduce blast radius · P2 = defense in depth

Related code: `supabase/functions/openrouter-agent/index.ts`, `js/app.js` (`agentPost` / `fireAgent`), `supabase/functions/routiner-scheduler/index.ts`.

---

## P0 — Production blockers (if `GITHUB_TOKEN` is live)

### Auth & exposure

- [ ] **Hard-auth `openrouter-agent`**
  - Require a verified Supabase user JWT **or** `RESPONDER_SECRET` (for scheduler/service callers).
  - Stop relying on browser-only `sessionForFire` checks that never reach the edge function.
  - Do not leave the function world-open when `RESPONDER_SECRET` is unset.

- [ ] **Fix CORS properly so auth headers work**
  - Current `agentPost` uses `text/plain` and drops `Authorization` / `apikey` to avoid OPTIONS 500s.
  - Prefer a same-origin Netlify proxy or a working preflight path so the browser can send real auth.
  - Teach scheduler / CLI to send `RESPONDER_SECRET` (or service identity) when the gate is on — service-role as Bearer must not be confused with the secret.

- [ ] **Confirm production gate**
  - Verify whether `RESPONDER_SECRET` is set on the live project.
  - If unset while `GITHUB_TOKEN` is set: treat as **critical exposure** until P0 auth lands.

### Tool authorization (server-side)

- [ ] **Do not trust client-supplied `body.tools` for capability grants**
  - Resolve `account` + `triggerKey` → `routiner_settings` tools under the **authenticated** user.
  - Intersect requested tools with the stored allowlist.
  - Especially never accept raw `tools: ["code"]` without settings + auth.

- [ ] **Hard allowlist at `runTool` execution time**
  - Only execute tools present in the resolved `enabled` set **and** that pass preconditions (`code` ⇒ token + allowed repo).
  - Reject unknown / hallucinated tool names (e.g. model invents `gh_merge_pr` when `code` is off).

---

## P1 — Reduce blast radius when `code` is authorized

### Write surface

- [ ] **Path policy for `gh_propose_change`**
  - Deny (or require an explicit “dangerous paths” override): `.github/**`, env/secret-like paths, other high-risk globs.
  - Cap number of files and total bytes per propose call.

- [ ] **Safer branch handling**
  - Force branch prefix e.g. `agent/<runId>/…`.
  - On branch create `422`, **fail** unless the branch was created by this run (do not silently write onto existing branches).
  - Refuse `base` outside the configured default branch unless explicitly allowlisted.

- [ ] **Safer merge (`gh_merge_pr`)**
  - Keep `AGENT_ALLOW_MERGE` **off** by default (already).
  - If enabled: only merge PRs whose head matches `agent/*`, opened by this PAT, and optionally green checks / max diff size.
  - Prefer never auto-merging from untrusted prompt/issue content without a human gate.

### Defaults & product

- [ ] **Default tools: `code` off**
  - New OpenRouter agent instances should not enable “Fix code (GitHub)” by default (`NEW_AGENT_ACCOUNT` / `AGENT_TOOL_IDS` defaults).
  - Require explicit enable; optional second confirmation in Settings when `GITHUB_TOKEN` is present.

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
