// openrouter-agent — run a named OpenRouter instance (e.g. Kimi, GLM) as a
// bounded tool-use agent, then store its full result in routiner_runs (the Log).
//
// Why this exists: Routiner's Claude accounts fire agentic Claude Code sessions;
// the built-in "OpenRouter" account runs Perplexity lead enrichment. This adds a
// THIRD executor — a user-addable OpenRouter "agent" account whose named
// instances each run a chosen model in a small tool loop that can:
//   • read the owner's Routiner data (routines / notes / staged leads),
//   • do web / deep research (Perplexity via OpenRouter),
//   • write into the owner's apps (a Routiner note, or find+save leads into
//     Command's Review tab via the lead-enrichment engine),
//   • work on code (the "code" tool group): read repo files, inspect PRs, and
//     propose a fix as a pull request / merge it — via the GitHub REST API, so
//     a non-Claude model can fix & merge code with no Claude session and no
//     shell/sandbox. Gated on a GITHUB_TOKEN edge secret (merge additionally on
//     AGENT_ALLOW_MERGE); see the code-tools section below.
//
// Key resolution (per call): the account's own OpenRouter key
// (routiner_settings.accounts[account].key) if the owner set one, else the
// server-side OPENROUTER_API_KEY edge secret. The key never reaches the browser.
//
// Auth (hard — the function is NOT world-callable):
//   1. RESPONDER_SECRET (Bearer or x-responder-secret), when that edge secret is set, OR
//   2. SUPABASE_SERVICE_ROLE_KEY as Bearer (scheduler / server callers), OR
//   3. a valid Supabase user JWT (Authorization Bearer, or body.accessToken so the
//      browser can authenticate without a CORS preflight — see agentPost in app.js).
// Owner user_id is resolved from the JWT when present, else routineId, else the
// single-owner fallback. GitHub write tools still require GITHUB_TOKEN; merge
// still requires AGENT_ALLOW_MERGE. Models may open PRs freely once authorized.
//
// Request (POST JSON):
//   Fresh run:  { prompt, model?, tools?: ("read"|"research"|"write"|"code")[], account?,
//                 triggerKey?, routineId?, title?, source?, ping? }
//   Continue:   { runId, prompt }   — resumes that stored run's transcript with
//               its own model/account/trigger/tools; the follow-up is `prompt`.
// Response:
//   { ok: true, runId, output, steps?, cost, model, keySource }   (ping: { ok, keySource, model })
//   { ok: false, error }
// The full message transcript is persisted on the run row (routiner_runs.messages)
// so the app can render the whole exchange and continue it (issues #51, #52).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const DEFAULT_MODEL = "moonshotai/kimi-k2.7-code";
const RESEARCH_MODEL = Deno.env.get("AGENT_RESEARCH_MODEL") || "perplexity/sonar-pro";

// Models this agent will bill against. Mirrors the OpenRouter ids offered in the
// app's instance picker (js/model-router.js MODELS). Override with the
// AGENT_ALLOWED_MODELS edge secret (comma-separated) to add/restrict.
const AGENT_DEFAULT_ALLOWED = [
  "openrouter/auto",
  "openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/gpt-5.6-luna",
  "google/gemini-3.1-pro-preview", "google/gemini-3.5-flash", "google/gemini-3-flash-preview",
  "deepseek/deepseek-chat", "moonshotai/kimi-k2.7-code", "moonshotai/kimi-k3",
  "meta-llama/llama-3.3-70b-instruct", "z-ai/glm-4.7", "z-ai/glm-5", "z-ai/glm-5.2",
];
const allowedModels = (): Set<string> => {
  const raw = Deno.env.get("AGENT_ALLOWED_MODELS");
  const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : AGENT_DEFAULT_ALLOWED;
  return new Set(list);
};

// Tunables (all optional env overrides).
const num = (name: string, def: number) => Number(Deno.env.get(name)) || def;
// Character-budget knobs where zero or a negative can never be meant: `num`
// passes a negative straight through, and a negative CONTEXT_TOOL_BUDGET made
// compactMessages floor EVERY tool result to the 400-char floor — silently.
// An invalid override is a misconfiguration: name it and use the default.
const budgetNum = (name: string, def: number): number => {
  const raw = Deno.env.get(name);
  if (raw == null || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`${name}="${raw}" is not a positive number; using default ${def}`);
    return def;
  }
  return Math.floor(n);
};
// Per-invocation step budget. Long jobs continue via auto-continue chains
// (see MAX_AUTO_CONTINUES) so one fire can span several edge invocations.
const MAX_STEPS = num("AGENT_MAX_STEPS", 5);
const CODE_MAX_STEPS = num("AGENT_CODE_MAX_STEPS", 12);
const stepBudgetFor = (enabled: Set<string>) => enabled.has("code") ? Math.max(MAX_STEPS, CODE_MAX_STEPS) : MAX_STEPS;
const MAX_TOKENS = Math.min(num("AGENT_MAX_TOKENS", 3072), 8192);
// Per-call cap. Reasoning models need headroom; still leave room for tools + save.
const CALL_TIMEOUT_MS = num("AGENT_CALL_TIMEOUT_MS", 50_000);
// Never start a model call with less than this — a 5s timeout always fails on
// Kimi/GLM and was being treated as a hard error (killing auto-continue).
const MIN_MODEL_CALL_MS = Math.min(num("AGENT_MIN_MODEL_CALL_MS", 25_000), CALL_TIMEOUT_MS);
// Wall budget for ONE edge invocation. Must stay under Supabase's ~150s idle
// limit so we can return JSON and/or spawn the next auto-continue segment.
const DEADLINE_MS = num("AGENT_DEADLINE_MS", 100_000);
// Smaller tool payloads → less context bloat → more steps fit before timeout.
// Non-file tools stay modest; gh_read_file uses GH_READ_RESULT_CAP (was 3500 for
// everything, which made the model report "file too large" on any real source file).
const TOOL_RESULT_CAP = budgetNum("AGENT_TOOL_RESULT_CAP", 8_000);
// File reads need room for real source (js/app.js alone is ~136k). Still capped so
// a single blob can't explode the context window.
const GH_READ_RESULT_CAP = Math.min(budgetNum("AGENT_GH_READ_RESULT_CAP", 120_000), 400_000);
const OUTPUT_CAP = budgetNum("AGENT_OUTPUT_CAP", 60_000);
// How many background segments after the first (total segments = 1 + this).
// 5 × ~100s ≈ set-and-forget multi-minute jobs without blowing one request.
const MAX_AUTO_CONTINUES = Math.min(num("AGENT_MAX_AUTO_CONTINUES", 5), 12);
// Consecutive auto-continue segments with zero progress (no tools, no real text)
// before we stop the chain instead of burning the full continue budget on timeouts.
const MAX_NO_PROGRESS = Math.min(num("AGENT_MAX_NO_PROGRESS", 2), 10);
// Reasoning-model control: GLM burns max_tokens thinking unless effort is capped.
// low/medium/high → { effort, exclude:true }; off/none → { enabled:false }; unset → omit.
const AGENT_REASONING_EFFORT = (Deno.env.get("AGENT_REASONING_EFFORT") || "low").trim();
// In-call retries for a transient OpenRouter failure ("Provider returned error",
// 5xx, timeouts). Without these ONE flaky response ended the whole run — the
// single biggest source of "the agent never finishes" in the run log.
const MODEL_RETRIES = Math.min(num("AGENT_MODEL_RETRIES", 2), 5);
// When the chosen model keeps failing transiently, finish the segment on a model
// known to be reliable rather than dying. Set to "" to disable falling back.
const FALLBACK_MODEL = (Deno.env.get("AGENT_FALLBACK_MODEL") ?? "moonshotai/kimi-k2.7-code").trim();
// Total characters of tool output kept at FULL size in the model's context. A
// single gh_read_file can now return 120k chars, so "keep the last 6 in full"
// could push ~700k chars (~180k tokens) into one request — which times out or
// 400s. This budget is what actually protects the context window.
const CONTEXT_TOOL_BUDGET = budgetNum("AGENT_CONTEXT_TOOL_BUDGET", 60_000);
const AUTO_CONTINUE_PROMPT =
  "[auto-continue] Resume the task from the transcript. Do NOT re-read files or re-list directories you already saw. Prefer finishing work (gh_propose_edit / write tools) over exploring — if you have read enough to make the change, make it now. When done, reply with a short final summary including any PR links — use no further tools if the work is complete.";

// ── Message provenance ───────────────────────────────────────────────────────
// A turn the machine injected is NOT a turn the human typed, and until now the
// transcript could not tell them apart: both were a bare `role:"user"`, so
// History rendered every [auto-continue] prompt as if the human had sent it,
// and any "did the user say something?" test counted a machine nudge as a human
// interjection. `_source` is carried on the message itself so the distinction
// survives into the stored transcript and the UI, not just this invocation.
const SRC_AUTO_CONTINUE = "auto-continue";
const SRC_REPEAT_GUARD = "repeat-guard";
const SRC_ORIENTATION = "orientation";
/** A `user` turn actually typed by a person (no `_source` = a human reply). */
function isHumanTurn(m: any): boolean {
  return m?.role === "user" && !m?._source;
}

// ── Repeat-tool guard ────────────────────────────────────────────────────────
// The only loop-hygiene signal this function had was segmentMadeProgress, which
// asks "did ANY tool run, or was there real text?" — so a model calling
// gh_read_file with the identical path twelve times in a row scored full
// progress every segment, burned the step budget, and auto-continued into
// another segment doing the same thing. This counts CONSECUTIVE identical calls
// and injects an escalating nudge. It is advisory: it never vetoes or rewrites
// a call, because a legitimately repeated call must not be blocked.
const REPEAT_THRESHOLDS = ((): number[] => {
  const raw = (Deno.env.get("AGENT_REPEAT_THRESHOLDS") || "").trim();
  if (!raw) return [3, 5, 8];
  if (/^(off|none|0)$/i.test(raw)) return [];
  const parsed = raw.split(",").map((s) => Number(s.trim()));
  const bad = parsed.some((n) => !Number.isInteger(n) || n < 2);
  if (bad || parsed.length === 0 || new Set(parsed).size !== parsed.length) {
    // The harness throws at plugin load here. An edge function cannot: a throw
    // at module scope 500s every invocation with no run row and nothing in
    // History, which hides the misconfiguration far better than it reports it.
    // Naming it in the edge logs and using the default is the loud-enough form.
    console.error(`AGENT_REPEAT_THRESHOLDS="${raw}" is not distinct integers >= 2; using 3,5,8`);
    return [3, 5, 8];
  }
  return [...parsed].sort((a, b) => a - b);
})();
// Tool-name patterns (with `*` wildcards) that are TRANSPARENT to the chain:
// they neither increment nor reset it. That is what makes exclusion useful —
// gh_read_file(X) → read_runs → gh_read_file(X) must still count as two
// consecutive gh_read_file(X), or a bookkeeping call interleaved into a loop
// launders it. Empty by default: every tool is tracked.
const REPEAT_EXCLUDE = (Deno.env.get("AGENT_REPEAT_EXCLUDE") || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const REPEAT_ARGS_PREVIEW = 400;

// ── Per-tool time budgets ────────────────────────────────────────────────────
// Every tool used to receive the WHOLE remaining wall clock, so one slow call
// could consume the segment and leave nothing for the model to summarize with.
// A tool declares what it actually needs; the loop still caps that at the time
// genuinely left. These are ceilings, not reservations — a fast tool returns
// early and the rest stays available to the run.
const TOOL_BUDGET_MS: Record<string, number> = {
  // Single REST round-trips against Supabase or GitHub.
  read_spill: 15_000, set_goal: 15_000, end_segment: 5_000,
  read_routines: 15_000, read_notes: 15_000, read_runs: 20_000, read_leads: 15_000,
  write_note: 15_000, write_routine: 15_000,
  gh_read_file: 30_000, gh_read_pr: 30_000, gh_read_issue: 30_000,
  gh_list_prs: 20_000, gh_list_issues: 20_000, gh_comment_pr: 20_000, gh_merge_pr: 30_000,
  // Multi-request: branch → per-file read+write → open PR.
  gh_propose_edit: 75_000, gh_propose_change: 75_000,
  // Whole model calls of their own.
  web_research: 60_000,
  find_and_save_leads: 90_000,
};
/** A tool's ceiling, never more than the time actually left in the segment. */
function toolBudgetFor(name: string, remainingMs: number): number {
  const declared = TOOL_BUDGET_MS[name] ?? CALL_TIMEOUT_MS;
  return Math.max(0, Math.min(declared, remainingMs));
}
/** Below this there is no point starting another file write inside one PR. */
const GH_MIN_WRITE_MS = 6_000;

// ── Tool-output spill ────────────────────────────────────────────────────────
// A result larger than this is stored whole in routiner_tool_spills and replaced
// in the model's context with a head/tail preview plus a spill id it can page
// with read_spill. Truncation used to be lossy: AGENT_GH_READ_RESULT_CAP allowed
// 120k chars while AGENT_CONTEXT_TOOL_BUDGET keeps 60k at full size, so one big
// read was 2x the whole budget and a second read floored the first — sending the
// model back to re-read a file it had already been handed.
const SPILL_THRESHOLD = budgetNum("AGENT_SPILL_THRESHOLD", 12_000);
/** Characters of the original kept inline, split head/tail around the notice. */
const SPILL_PREVIEW_CHARS = budgetNum("AGENT_SPILL_PREVIEW_CHARS", 4_000);
/** Max characters one read_spill window may return. */
const SPILL_WINDOW_CHARS = budgetNum("AGENT_SPILL_WINDOW_CHARS", 40_000);
/**
 * Ceiling on the spill write itself. The insert carries the entire tool result
 * (up to GH_READ_RESULT_CAP), so it is the largest request this function makes
 * — and it sits inside the tool loop, where a stall costs the whole segment.
 * A spill is a cache: waiting past this is strictly worse than falling back to
 * the inline cap, which is what a timeout here does.
 */
const SPILL_WRITE_TIMEOUT_MS = 10_000;
/** Ceiling on one checkpoint write; see checkpointRun for why it is bounded. */
const CHECKPOINT_TIMEOUT_MS = 15_000;

// ── GitHub (the "code" tool group) ───────────────────────────────────────────
// Lets a non-Claude instance read the repo, inspect PRs, and — the whole point —
// propose a fix as a PR and merge it, entirely through the GitHub REST API (no
// shell/sandbox needed). Guard-railed: it only works when GITHUB_TOKEN is set,
// only touches allowed repos, and won't merge unless AGENT_ALLOW_MERGE is on.
const GH_API = "https://api.github.com";
const GH_TOKEN = () => Deno.env.get("GITHUB_TOKEN") || Deno.env.get("GH_TOKEN") || "";
const GH_DEFAULT_REPO = () => (Deno.env.get("GITHUB_REPO") || "").trim();
const GH_ALLOW_MERGE = () => /^(1|true|yes|on)$/i.test(Deno.env.get("AGENT_ALLOW_MERGE") || "");
// Caps on agent writes (gh_propose_change) — keep PRs reviewable and limit blast radius.
const GH_MAX_FILES = Math.min(num("AGENT_GH_MAX_FILES", 10), 30);
const GH_MAX_FILE_CHARS = Math.min(num("AGENT_GH_MAX_FILE_CHARS", 400_000), 1_000_000);
// Default window when the model pages a large file with start_line/max_lines.
const GH_READ_DEFAULT_LINES = Math.min(num("AGENT_GH_READ_DEFAULT_LINES", 400), 2_000);
// null = "only the default repo is allowed"; a set = that explicit allowlist.
const ghAllowedRepos = (): Set<string> | null => {
  const raw = Deno.env.get("GITHUB_ALLOWED_REPOS");
  if (!raw) return null;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? new Set(list.map((s) => s.toLowerCase())) : null;
};
// Resolve + authorize the repo for a code tool call.
function resolveRepo(arg?: unknown): { repo?: string; error?: string } {
  const def = GH_DEFAULT_REPO();
  const allow = ghAllowedRepos();
  const want = (typeof arg === "string" && arg.trim()) ? arg.trim() : def;
  if (!want) return { error: "no repo: set the GITHUB_REPO edge secret or pass repo as 'owner/name'." };
  if (!/^[^/\s]+\/[^/\s]+$/.test(want)) return { error: `bad repo '${want}' — want 'owner/name'.` };
  if (allow) { if (!allow.has(want.toLowerCase())) return { error: `repo '${want}' is not in GITHUB_ALLOWED_REPOS.` }; }
  else if (def && want.toLowerCase() !== def.toLowerCase()) return { error: `repo '${want}' not allowed (only '${def}'); set GITHUB_ALLOWED_REPOS to widen.` };
  return { repo: want };
}
// Block high-risk write paths (CI secrets exfil, env keys, credential dumps). Reads stay open.
function deniedWritePath(rawPath: string): string | null {
  const path = String(rawPath || "").replace(/^\/+/, "").replace(/\\/g, "/");
  if (!path || path.split("/").some((seg) => seg === ".." || seg === "")) {
    return "invalid path (empty segment or '..' not allowed)";
  }
  const lower = path.toLowerCase();
  if (lower === ".github" || lower.startsWith(".github/")) {
    return "writes under .github/ are blocked (workflows can exfiltrate secrets)";
  }
  if (/(^|\/)\.env($|\.|\/)/.test(lower) || lower.endsWith(".env")) {
    return ".env files are blocked";
  }
  if (/\.(pem|key|p12|pfx|jks)$/i.test(path)) return "key/cert files are blocked";
  if (/(^|\/)(id_rsa|id_ed25519|id_ecdsa|credentials\.json|service[-_]?account)/i.test(path)) {
    return "credential-like files are blocked";
  }
  return null;
}
// Agent branches must live under agent/ so merges can't target arbitrary long-lived branches.
function normalizeAgentBranch(raw: string): string {
  let b = String(raw || "").trim().replace(/[^a-zA-Z0-9._/-]/g, "-");
  if (!b || b.includes("..")) b = `agent/${Date.now().toString(36)}`;
  if (!b.startsWith("agent/")) b = `agent/${b}`;
  // Collapse accidental agent/agent/…
  b = b.replace(/^(agent\/)+/, "agent/");
  return b.slice(0, 200);
}
const ghPath = (p: string) => String(p).replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
// UTF-8-safe base64 both directions (GitHub contents API is base64).
const b64encode = (s: string) => btoa(unescape(encodeURIComponent(s)));
const b64decode = (s: string) => decodeURIComponent(escape(atob(String(s).replace(/\n/g, ""))));
async function gh(method: string, path: string, body?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<{ ok: boolean; status: number; data: any }> {
  const token = GH_TOKEN();
  // The old `Math.max(3_000, …)` floor meant an exhausted budget still bought
  // one more 3s request, so a tool over its deadline kept issuing calls it had
  // no time to use. Report the exhaustion instead of quietly borrowing time.
  if (timeoutMs <= 0) {
    return { ok: false, status: 0, data: { message: "no time left in this tool's budget" } };
  }
  const tMs = Math.max(1_000, Math.min(timeoutMs, CALL_TIMEOUT_MS));
  try {
    const r = await fetch(`${GH_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "routiner-openrouter-agent",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(tMs),
    });
    const text = await r.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    const msg = e instanceof DOMException && e.name === "TimeoutError" ? `GitHub call timed out (${tMs}ms)` : (e as Error).message;
    return { ok: false, status: 0, data: { message: msg } };
  }
}

// A 404 on a read is usually wrong casing, not a missing file ("todo.md" when
// the repo has "TODO.md"). Models were burning 3-4 of their ~12 steps guessing.
// Look the name up in its parent directory and either correct it or hand back
// the real listing, so one wrong guess costs one step instead of several.
async function resolveCasePath(
  repo: string,
  path: string,
  ref: string | undefined,
  tMs: number,
): Promise<{ path?: string; candidates?: string[] }> {
  const lastSlash = path.lastIndexOf("/");
  const parent = lastSlash === -1 ? "" : path.slice(0, lastSlash);
  const basename = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  const encodedParent = parent ? parent.split("/").map(encodeURIComponent).join("/") : "";
  const url = `/repos/${repo}/contents/${encodedParent}${ref ? `?ref=${encodeURIComponent(String(ref))}` : ""}`;
  try {
    const res = await gh("GET", url, undefined, tMs);
    if (!res.ok || !Array.isArray(res.data)) return {};
    const target = basename.toLowerCase();
    const matches = res.data.filter((e: any) => String(e?.name || "").toLowerCase() === target);
    if (matches.length === 1) return { path: String(matches[0].path) };
    if (matches.length > 1) return { candidates: matches.map((e: any) => String(e.path)) };
    return { candidates: res.data.slice(0, 20).map((e: any) => String(e.path)) };
  } catch {
    return {};
  }
}

// ── Edit matching ────────────────────────────────────────────────────────────
// gh_propose_edit used to demand a byte-exact, globally unique substring and
// hard-fail otherwise ("must match the file EXACTLY … re-read the file"). Every
// failure cost the model a step and usually a re-read of a file it already had
// — and the drift was almost never semantic. A model that read the file through
// its own tokenizer emits an em-dash where the source has a hyphen, a curly
// apostrophe where the source has a straight one, LF where the file has CRLF,
// or loses a trailing space. So matching cascades: each pass normalizes away one
// more class of drift and the FIRST pass that hits wins, which keeps an exact
// match exact and only reaches for tolerance when nothing stricter matched.
//
//   1 exact          byte-for-byte
//   2 punctuation    Unicode dashes/quotes/spaces → ASCII, CRLF → LF, zero-width dropped
//   3 trailing ws    …plus trailing spaces/tabs on every line ignored
//   4 indentation    …plus leading spaces/tabs ignored — whole lines only
//
// Pass 4 is deliberately the last and the narrowest: with indentation ignored the
// matched text can only be reconstructed line-wise, so it requires the match to
// cover whole lines and then replaces those whole lines, new_string's own
// indentation and all. That is the only splice that cannot silently produce a
// mis-indented file, which in Python or YAML would be a real bug rather than a
// failed edit. Every non-exact match is reported to the model and written into
// the PR body, because a reviewer needs to know the server matched something the
// model did not literally write.

/** Which normalization a match needed. Order is strictness, strictest first. */
type MatchPass = "exact" | "punctuation" | "trailing-whitespace" | "indentation";

const MATCH_PASSES: MatchPass[] = ["exact", "punctuation", "trailing-whitespace", "indentation"];

const PASS_LABEL: Record<MatchPass, string> = {
  "exact": "exact",
  "punctuation": "after normalizing Unicode punctuation/line endings",
  "trailing-whitespace": "after ignoring trailing whitespace",
  "indentation": "after ignoring indentation (whole lines replaced)",
};

/**
 * Fold one source character to its ASCII equivalent for matching purposes.
 * Returns "" to drop the character entirely.
 *
 * @param ch one code point from the source text
 * @returns the replacement text, "" to drop it, or the character unchanged
 */
function foldPunctuation(ch: string): string {
  switch (ch) {
    // Hyphens, dashes and the minus sign a model reflows into "—" or "–".
    case "‐": case "‑": case "‒": case "–":
    case "—": case "―": case "⁃": case "−":
      return "-";
    // Single quotes, including the prime and modifier letter apostrophe that
    // "smart quotes" substitution produces.
    case "‘": case "’": case "‚": case "‛":
    case "′": case "ʼ": case "´":
      return "'";
    case "“": case "”": case "„": case "‟": case "″":
      return '"';
    // Non-breaking and typographic spaces, which are invisible in a diff — and
    // therefore written as escapes here, where a literal would be invisible too.
    case "\u00A0": case "\u1680": case "\u2000": case "\u2001": case "\u2002":
    case "\u2003": case "\u2004": case "\u2005": case "\u2006": case "\u2007":
    case "\u2008": case "\u2009": case "\u200A": case "\u202F": case "\u205F":
    case "\u3000":
      return " ";
    // Zero-width and BOM: present in the file or in the model's copy, never both.
    case "\u200B": case "\u200C": case "\u200D": case "\uFEFF":
      return "";
    // CR is dropped rather than mapped, so a CRLF file matches an LF needle.
    case "\r":
      return "";
    default:
      return ch;
  }
}

/**
 * A normalized view of some text plus, for every code unit of that view, the
 * span of the ORIGINAL text that produced it. A match found in `text` maps back
 * to `[starts[a], ends[b - 1])` in the original, which is what makes a tolerant
 * match safe to splice: the replacement lands on real original coordinates, and
 * characters dropped in the middle of the span are consumed with it.
 */
interface MatchView {
  text: string;
  starts: number[];
  ends: number[];
}

/** True for a space or tab — the only whitespace indentation is made of. */
function isHorizontalSpace(ch: string): boolean {
  return ch === " " || ch === "\t";
}

/**
 * Build the punctuation-folded view of `src`.
 *
 * @param src original text
 * @returns the folded text and its per-code-unit map back to `src`
 */
function foldedView(src: string): MatchView {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of src) {
    const folded = foldPunctuation(ch);
    for (let k = 0; k < folded.length; k++) { starts.push(i); ends.push(i + ch.length); }
    text += folded;
    i += ch.length;
  }
  return { text, starts, ends };
}

/**
 * Drop leading and/or trailing horizontal whitespace from every line of a view,
 * carrying the original-coordinate map through unchanged.
 *
 * @param view a view to filter
 * @param dropLeading drop spaces/tabs that start a line
 * @param dropTrailing drop spaces/tabs that end a line
 * @returns the filtered view
 */
function dropLineWhitespace(view: MatchView, dropLeading: boolean, dropTrailing: boolean): MatchView {
  const { text } = view;
  const keep = new Array<boolean>(text.length).fill(true);
  // Two linear scans, each carrying "am I still inside the run" forward from the
  // previous character. Rescanning the run from every character instead would be
  // quadratic, and these run over whole files: one 100k-character stretch of
  // spaces — a minified asset, a padded fixture — would hang the tool loop.
  if (dropLeading) {
    let inRun = true;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") { inRun = true; continue; }
      if (!inRun) continue;
      if (isHorizontalSpace(text[i])) keep[i] = false;
      else inRun = false;
    }
  }
  if (dropTrailing) {
    let inRun = true;
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] === "\n") { inRun = true; continue; }
      if (!inRun) continue;
      if (isHorizontalSpace(text[i])) keep[i] = false;
      else inRun = false;
    }
  }
  let out = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (!keep[i]) continue;
    out += text[i];
    starts.push(view.starts[i]);
    ends.push(view.ends[i]);
  }
  return { text: out, starts, ends };
}

/**
 * Build the matching view for one pass.
 *
 * @param src original text
 * @param pass which normalization to apply
 * @returns the view, or null for `exact` (which needs no view)
 */
function viewFor(src: string, pass: MatchPass): MatchView | null {
  if (pass === "exact") return null;
  const folded = foldedView(src);
  if (pass === "punctuation") return folded;
  if (pass === "trailing-whitespace") return dropLineWhitespace(folded, false, true);
  return dropLineWhitespace(folded, true, true);
}

/** Every non-overlapping occurrence of `needle` in `hay`, as start offsets. */
function allOccurrences(hay: string, needle: string): number[] {
  const at: number[] = [];
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return at;
    at.push(i);
    from = i + needle.length;
  }
}

/** Extend `[start, end)` outward to whole lines of `text`. */
function toWholeLines(text: string, start: number, end: number): { start: number; end: number } {
  let s = start;
  while (s > 0 && text[s - 1] !== "\n") s--;
  let e = end;
  while (e < text.length && text[e] !== "\n") e++;
  return { start: s, end: e };
}

/**
 * Find every place `oldStr` occurs in `text` under one normalization pass,
 * expressed as spans of `text` itself.
 *
 * @param text the file text to search
 * @param oldStr the model's search text
 * @param pass which normalization to match under
 * @returns non-overlapping spans in original coordinates, ascending
 */
function findSpans(text: string, oldStr: string, pass: MatchPass): Array<{ start: number; end: number }> {
  if (pass === "exact") {
    return allOccurrences(text, oldStr).map((i) => ({ start: i, end: i + oldStr.length }));
  }
  const hay = viewFor(text, pass)!;
  const needle = viewFor(oldStr, pass)!;
  // Tolerance exists to absorb drift AROUND real content. A needle with no
  // non-whitespace character is nothing but drift: normalization can empty it
  // (an empty needle matches at every offset), or fold "\u200B \u00A0" down to
  // two ordinary spaces and hit the first pair of spaces in the file. Only the
  // exact pass, which is unambiguous, may match one.
  if (!/\S/.test(needle.text)) return [];
  const spans: Array<{ start: number; end: number }> = [];
  for (const at of allOccurrences(hay.text, needle.text)) {
    const end = at + needle.text.length;
    if (pass === "indentation") {
      // With indentation gone the match is only reconstructable line-wise, so
      // require it to sit on line boundaries in the normalized view.
      const atLineStart = at === 0 || hay.text[at - 1] === "\n";
      const atLineEnd = end === hay.text.length || hay.text[end] === "\n";
      if (!atLineStart || !atLineEnd) continue;
      spans.push(toWholeLines(text, hay.starts[at], hay.ends[end - 1]));
    } else {
      spans.push({ start: hay.starts[at], end: hay.ends[end - 1] });
    }
  }
  return spans;
}

/**
 * Apply find/replace edits to a file's text, matching with cascading strictness.
 *
 * Returns an error string instead of throwing so the model gets an actionable
 * message back as a tool result (and can fix its own edit) rather than the run
 * dying.
 *
 * @param text current file contents
 * @param edits the model's edits, applied in order
 * @param path the file's path, for error messages
 * @returns the new content, or an error; `notes` records any non-exact match
 */
function applyEdits(
  text: string,
  edits: Array<{ old_string?: unknown; new_string?: unknown; replace_all?: unknown }>,
  path: string,
): { content?: string; error?: string; notes?: string[] } {
  let out = text;
  const notes: string[] = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i] || {};
    const oldStr = String(e.old_string ?? "");
    const newStr = String(e.new_string ?? "");
    const replaceAll = e.replace_all === true;
    if (!oldStr) return { error: `edit ${i + 1} for '${path}' has an empty old_string.` };
    if (oldStr === newStr) return { error: `edit ${i + 1} for '${path}' is a no-op (old_string === new_string).` };

    let spans: Array<{ start: number; end: number }> = [];
    let matched: MatchPass | null = null;
    for (const pass of MATCH_PASSES) {
      const found = findSpans(out, oldStr, pass);
      if (found.length) { spans = found; matched = pass; break; }
    }
    if (!matched) {
      const first = oldStr.split("\n")[0].slice(0, 120);
      return {
        error: `edit ${i + 1} for '${path}': old_string not found, including after ignoring `
          + `whitespace, indentation, line endings and Unicode punctuation — so re-typing it the same way will not help. `
          + `First line looked for: ${JSON.stringify(first)}. Re-read '${path}' with gh_read_file and copy the current text.`,
      };
    }
    if (spans.length > 1 && !replaceAll) {
      return {
        error: `edit ${i + 1} for '${path}': old_string matches ${spans.length} times (${PASS_LABEL[matched]}). `
          + `Include more surrounding lines to make it unique, or pass replace_all: true.`,
      };
    }
    if (matched !== "exact") {
      notes.push(`edit ${i + 1} for '${path}' matched ${PASS_LABEL[matched]}, not literally.`);
    }
    // Splice by span rather than String.replace: replace() would treat "$&",
    // "$1" etc. in new_string as substitution patterns and silently mangle any
    // code containing a dollar sign (template literals, jQuery, …). Applying
    // last-to-first keeps the earlier spans' offsets valid.
    const targets = replaceAll ? spans : spans.slice(0, 1);
    for (let s = targets.length - 1; s >= 0; s--) {
      out = out.slice(0, targets[s].start) + newStr + out.slice(targets[s].end);
    }
  }
  return { content: out, ...(notes.length ? { notes } : {}) };
}

// Branch → write files → open PR. Shared by gh_propose_change (model supplies
// whole files) and gh_propose_edit (server derives whole files from find/replace
// edits), so both get the same path/branch/base guard rails.
async function openPrWithFiles(
  repo: string,
  args: Record<string, any>,
  files: Array<{ path: string; content: string }>,
  deadlineAt: number,
  notes: string[] = [],
): Promise<string> {
  // This makes 4 + 2×files sequential GitHub calls. Clamping each one at
  // CALL_TIMEOUT_MS bounded no total: ten files could spend 24 × 50s. They all
  // draw down one shared deadline instead.
  const tLeft = () => Math.max(0, deadlineAt - Date.now());
  if (files.length > GH_MAX_FILES) {
    return `error: too many files (${files.length}); max is ${GH_MAX_FILES} per PR. Split the work.`;
  }
  for (const f of files) {
    const deny = deniedWritePath(f.path);
    if (deny) return `error: blocked path '${f.path}': ${deny}`;
    if (f.content.length > GH_MAX_FILE_CHARS) {
      return `error: '${f.path}' is too large to write (${f.content.length} chars); max is ${GH_MAX_FILE_CHARS}. Split the change or raise AGENT_GH_MAX_FILE_CHARS (hard max 1e6).`;
    }
  }
  const title = String(args.title || "").trim() || "Routiner agent change";
  // Resolve default branch; only allow PRs targeting that branch (not release/* etc.).
  const meta = await gh("GET", `/repos/${repo}`, undefined, tLeft());
  const defaultBranch = (meta.ok && meta.data?.default_branch) ? String(meta.data.default_branch) : "main";
  let base = String(args.base || "").trim() || defaultBranch;
  if (base.toLowerCase() !== defaultBranch.toLowerCase()) {
    return `error: base branch must be the repo default ('${defaultBranch}'); got '${base}'.`;
  }
  base = defaultBranch; // use canonical casing from GitHub
  const baseRef = await gh("GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`, undefined, tLeft());
  if (!baseRef.ok) return `error: base branch '${base}' not found (${baseRef.status}).`;
  const baseSha = baseRef.data?.object?.sha;
  // Always under agent/; never silently write onto a pre-existing branch (422).
  const branch = normalizeAgentBranch(String(args.branch || "").trim() || `agent/${Date.now().toString(36)}`);
  const mk = await gh("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha }, tLeft());
  if (!mk.ok) {
    if (mk.status === 422) {
      return `error: branch '${branch}' already exists — pick a new name (or omit branch for an auto name). Refusing to overwrite.`;
    }
    return `error: create branch '${branch}' → ${mk.status}: ${String(mk.data?.message || "").slice(0, 160)}`;
  }
  const written: string[] = [];
  for (const f of files) {
    // The branch already exists by now, so running dry mid-write leaves real
    // state behind. Say exactly what landed and how to resume, rather than
    // letting the next call 422 on the existing branch with no explanation.
    if (tLeft() < GH_MIN_WRITE_MS) {
      return `error: ran out of time after writing ${written.length}/${files.length} file(s) to branch '${branch}' (${written.join(", ") || "none"}). `
        + `The branch exists and no PR was opened. Re-call with branch="${branch}" and only the remaining file(s) to finish, then open the PR.`;
    }
    const cur = await gh("GET", `/repos/${repo}/contents/${ghPath(f.path)}?ref=${encodeURIComponent(branch)}`, undefined, tLeft());
    const sha = (cur.ok && !Array.isArray(cur.data)) ? cur.data.sha : undefined;
    const put = await gh("PUT", `/repos/${repo}/contents/${ghPath(f.path)}`, {
      message: `${title} — ${f.path}`, branch, content: b64encode(f.content), ...(sha ? { sha } : {}),
    }, tLeft());
    if (!put.ok) return `error: write ${f.path} → ${put.status}: ${String(put.data?.message || "").slice(0, 160)}`;
    written.push(f.path);
  }
  // A tolerant edit match is a fact about the diff, so it belongs in the PR body
  // where the reviewer reads it — not only in a tool result the run discards.
  const shownNotes = notes.slice(0, 20);
  const noteBlock = notes.length
    ? `\n\n**Edits matched with normalization** (the server matched text the model did not write literally):\n`
      + shownNotes.map((n) => `- ${n}`).join("\n")
      + (notes.length > shownNotes.length ? `\n- …and ${notes.length - shownNotes.length} more` : "")
    : "";
  const pr = await gh("POST", `/repos/${repo}/pulls`, {
    title, head: branch, base,
    body: `${String(args.body || "")}${noteBlock}\n\n— proposed by a Routiner OpenRouter agent`.trim(),
  }, tLeft());
  if (!pr.ok) return `error: open PR → ${pr.status}: ${String(pr.data?.message || "").slice(0, 200)}`;
  return `opened PR #${pr.data.number}: ${pr.data.html_url} (branch ${branch} → ${base}, ${files.length} file(s))`
    + (notes.length
      ? `\nnote: ${notes.length} edit(s) matched with normalization, not literally — the PR body lists them. Check the diff before merging.`
      : "");
}

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, apikey, x-responder-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });

function bearerToken(req: Request): string {
  const h = req.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

// Verify a Supabase user access token via GoTrue. Returns the user id or null.
async function verifyUserJwt(token: string): Promise<string | null> {
  if (!token || !SB_URL) return null;
  // Service role or anon both work as apikey for /auth/v1/user when Authorization
  // is the user's JWT; prefer service role (always present on edge functions).
  const apikey = Deno.env.get("SUPABASE_ANON_KEY") || SB_KEY;
  if (!apikey) return null;
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return null;
    const u = await r.json();
    return typeof u?.id === "string" && u.id ? u.id : null;
  } catch {
    return null;
  }
}

// Hard auth for every call. Prevents the open internet from driving GITHUB_TOKEN /
// OPENROUTER_API_KEY even though verify_jwt is false at the gateway (needed so
// the browser can use a simple CORS POST with the token in the JSON body).
async function authorizeCaller(
  req: Request,
  body: Record<string, unknown>,
): Promise<{ ok: true; userId: string | null; via: string } | { ok: false; error: string }> {
  const bearer = bearerToken(req);
  const headerSecret = (req.headers.get("x-responder-secret") || "").trim();
  const gate = (Deno.env.get("RESPONDER_SECRET") || "").trim();

  if (gate && (bearer === gate || headerSecret === gate)) {
    return { ok: true, userId: null, via: "responder-secret" };
  }
  if (SB_KEY && bearer === SB_KEY) {
    return { ok: true, userId: null, via: "service-role" };
  }

  // Prefer header JWT; fall back to body.accessToken (CORS-simple browser path).
  const bodyTok = typeof body.accessToken === "string" ? body.accessToken.trim()
    : (typeof body.access_token === "string" ? body.access_token.trim() : "");
  const candidates = [bearer, bodyTok].filter((t) => t && t !== SB_KEY && t !== gate);
  for (const tok of candidates) {
    const userId = await verifyUserJwt(tok);
    if (userId) return { ok: true, userId, via: "user-jwt" };
  }

  return {
    ok: false,
    error: "Unauthorized — sign in, or call with the service role / RESPONDER_SECRET.",
  };
}

// ── Supabase REST helpers (service role) ─────────────────────────────────────
const rest = (path: string) => `${SB_URL}/rest/v1/${path}`;
const H = () => ({ apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json" });
async function sbGet(path: string): Promise<any[]> {
  const r = await fetch(rest(path), { headers: H() });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

// Map a tool function name → tool-group id (must match Settings checkboxes).
function toolGroupOf(name: string): string | null {
  // read_spill belongs to no group and is always available: a spill can only
  // exist because a tool the run already had produced it, so paging one back is
  // not a new capability — and gating it behind a group the run happens not to
  // have would strand the very output we just told the model to page.
  if (name === "read_spill" || name === "set_goal" || name === "end_segment") return "*";
  if (name === "read_routines" || name === "read_notes" || name === "read_leads" || name === "read_runs") return "read";
  if (name === "web_research") return "research";
  if (name === "write_note" || name === "find_and_save_leads") return "write";
  if (name.startsWith("gh_")) return "code";
  return null;
}

// The single owner user_id, resolved from a routineId when given (so the run row
// inherits the right owner + title), else inferred from existing rows — the same
// single-tenant fallback routiner-admin uses.
async function resolveOwner(routineId?: string): Promise<{ userId: string | null; title: string }> {
  if (routineId) {
    try {
      const rows = await sbGet(`routiner_routines?id=eq.${encodeURIComponent(routineId)}&select=user_id,title&limit=1`);
      if (rows?.[0]?.user_id) return { userId: rows[0].user_id, title: rows[0].title || "" };
    } catch { /* fall through */ }
  }
  for (const path of ["routiner_routines?select=user_id&limit=1", "routiner_notes?select=user_id&limit=1", "routiner_settings?select=user_id&limit=1"]) {
    try { const rows = await sbGet(path); if (rows?.[0]?.user_id) return { userId: rows[0].user_id, title: "" }; } catch { /* try next */ }
  }
  return { userId: null, title: "" };
}

// The account's per-account OpenRouter key override (else null → server key).
async function accountKeyOverride(userId: string | null, account?: string): Promise<string | null> {
  if (!account) return null;
  try {
    const q = userId ? `routiner_settings?user_id=eq.${encodeURIComponent(userId)}&select=accounts&limit=1`
                     : `routiner_settings?select=accounts&limit=1`;
    const rows = await sbGet(q);
    const accts = rows?.[0]?.accounts;
    if (!Array.isArray(accts)) return null;
    const a = accts.find((x: any) => x && x.id === account);
    const key = a && typeof a.key === "string" ? a.key.trim() : "";
    return key || null;
  } catch { return null; }
}

// ── OpenRouter ────────────────────────────────────────────────────────────────
// Build OpenRouter's `reasoning` body field from an effort string (or omit).
// OpenRouter drops unsupported params on non-reasoning models, so this is safe
// for Kimi/DeepSeek/Llama. Returns null → omit the field entirely.
function parseReasoningEffort(v: string): Record<string, unknown> | null {
  const s = String(v || "").toLowerCase().trim();
  if (!s || s === "unset" || s === "default") return null;
  if (s === "off" || s === "none") return { enabled: false };
  // exclude:false so reasoning text is returned for the History "Thoughts" panel.
  // Effort still caps hidden-token spend; low is the default.
  if (s === "low" || s === "medium" || s === "high") return { effort: s, exclude: false };
  return { effort: "low", exclude: false };
}

// Pull human-readable thoughts from an OpenRouter assistant message.
function extractReasoning(msg: any): string {
  if (!msg || typeof msg !== "object") return "";
  if (typeof msg.reasoning === "string" && msg.reasoning.trim()) return msg.reasoning.trim();
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) return msg.reasoning_content.trim();
  if (Array.isArray(msg.reasoning_details)) {
    return msg.reasoning_details
      .map((d: any) => (typeof d?.text === "string" ? d.text : (typeof d?.summary === "string" ? d.summary : "")))
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  return "";
}

// Build the assistant transcript entry, preserving reasoning for the UI + tool loops.
function assistantTurn(msg: any, toolCalls?: any[]): Record<string, unknown> {
  const content = (msg?.content ?? "").toString();
  const turn: Record<string, unknown> = { role: "assistant", content };
  if (toolCalls && toolCalls.length) turn.tool_calls = toolCalls;
  const reasoning = extractReasoning(msg);
  if (reasoning) turn.reasoning = reasoning;
  if (Array.isArray(msg?.reasoning_details) && msg.reasoning_details.length) {
    turn.reasoning_details = msg.reasoning_details;
  }
  return turn;
}
// Resolve per-call reasoning: explicit opts.reasoning wins (string | object | null).
// null = omit; undefined = use AGENT_REASONING_EFFORT env (default low).
function resolveReasoning(
  override?: string | Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (override === null) return null;
  if (override !== undefined) {
    if (typeof override === "object") return override;
    return parseReasoningEffort(String(override));
  }
  return parseReasoningEffort(AGENT_REASONING_EFFORT);
}

type OrOpts = {
  tools?: unknown[];
  maxTokens?: number;
  timeoutMs?: number;
  /** string effort, full object, or null to omit (default: AGENT_REASONING_EFFORT) */
  reasoning?: string | Record<string, unknown> | null;
  /** transient-failure retries (default 0 — callers in the loop opt in) */
  retries?: number;
  /** absolute epoch-ms wall deadline; no retry is started that can't fit */
  deadlineAt?: number;
  /**
   * Invoked BEFORE each backoff wait, so a pending retry is durable before the
   * process sleeps on it. A retry held only in memory disappears if the edge
   * function is killed mid-backoff — which this deployment does under load —
   * leaving a row that simply went quiet, indistinguishable from a hang. It
   * also bumps the run's last-activity stamp, so the scheduler's stale-run
   * reaper does not mark a legitimately backing-off run as dead.
   */
  onRetry?: (info: { attempt: number; retries: number; delayMs: number; error: string; status?: number }) => Promise<void> | void;
};
// `status` is the HTTP status OpenRouter answered with. It is the only reliable
// transient/permanent signal: the body message is provider prose and has already
// caused one outage by reading as permanent when it wasn't (see
// isTransientModelError). Keep it populated on every error path that has one.
// `exhausted` marks the one failure that no retry, no fallback model and no
// auto-continue can rescue: the key has spent its whole limit. It is set only
// from OpenRouter's own limit_remaining, never inferred from the message.
type OrResult = {
  ok: boolean; message?: any; usage?: any; error?: string; status?: number; exhausted?: boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retrying wrapper. OpenRouter routes to third-party providers, so a single call
// failing ("Provider returned error", 502/503, a slow cold start) says nothing
// about whether the next one will — retry before giving up on the whole run.
// Permanent failures (bad key, spend limit, unknown model) fail fast, unretried.
async function openrouter(
  key: string,
  model: string,
  messages: unknown[],
  opts: OrOpts = {},
): Promise<OrResult> {
  const retries = Math.max(0, opts.retries ?? 0);
  const deadlineAt = opts.deadlineAt ?? Number.POSITIVE_INFINITY;
  let last: OrResult = { ok: false, error: "no attempt was made" };

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Cap an attempt at the wall time actually left, not at CALL_TIMEOUT_MS —
    // a 50s clamp on a model that needs 70s fails identically on every retry.
    const wallMs = Number.isFinite(deadlineAt) ? Math.max(0, deadlineAt - Date.now() - 2_000) : CALL_TIMEOUT_MS;
    const perAttempt = Math.max(3_000, Math.min(opts.timeoutMs ?? CALL_TIMEOUT_MS, wallMs));
    // Only start an attempt that can actually finish inside the wall budget.
    if (attempt > 0 && Date.now() + perAttempt > deadlineAt) break;

    const r = await openrouterOnce(key, model, messages, { ...opts, timeoutMs: perAttempt });
    if (r.ok) return r;
    last = r;
    // A permanent error repeats identically — don't burn budget or spend on it.
    if (!isTransientModelError(r.error || "", r.status)) return r;
    // A key-limit error is retryable only while the key still has credit. Ask
    // OpenRouter rather than guessing from the message, which reads the same
    // whether the key is throttled for a minute or spent for good.
    if (looksLikeKeyLimit(r.error || "", r.status) && await isKeyExhausted(key)) {
      return { ...r, error: keyExhaustedMessage(), exhausted: true };
    }
    if (attempt < retries) {
      // A throttle needs longer than a flaky provider: backing off 750ms into a
      // rate limit just spends the retry budget re-hitting it.
      const throttled = r.status === 429;
      const backoff = throttled
        ? Math.min(8_000, 2_000 * 2 ** attempt)
        : Math.min(4_000, 750 * 2 ** attempt);
      if (Date.now() + backoff + 3_000 > deadlineAt) break;
      if (opts.onRetry) {
        // Durable before the wait, never after: the whole point is to survive
        // being killed during the sleep. Best-effort — a failed checkpoint must
        // not abort a retry that would otherwise have succeeded.
        try {
          await opts.onRetry({ attempt: attempt + 1, retries, delayMs: backoff, error: r.error || "", status: r.status });
        } catch { /* checkpoint failure is never a reason to skip the retry */ }
      }
      await sleep(backoff);
    }
  }
  return last;
}

async function openrouterOnce(
  key: string,
  model: string,
  messages: unknown[],
  opts: OrOpts = {},
): Promise<OrResult> {
  // Honour the caller-computed budget (already wall-aware in openrouter());
  // re-clamping to CALL_TIMEOUT_MS here silently undid that.
  const tMs = Math.max(3_000, opts.timeoutMs ?? CALL_TIMEOUT_MS);
  const reasoning = resolveReasoning(opts.reasoning);
  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://routiner.zparx.app",
        "X-Title": "Routiner Agent",
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? MAX_TOKENS,
        usage: { include: true },
        ...(reasoning ? { reasoning } : {}),
        ...(opts.tools && opts.tools.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
        messages,
      }),
      signal: AbortSignal.timeout(tMs),
    });
    const data = await resp.json();
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        error: data?.error?.message || `OpenRouter HTTP ${resp.status}`,
      };
    }
    return { ok: true, message: data?.choices?.[0]?.message || {}, usage: data?.usage || null };
  } catch (e) {
    const msg = e instanceof DOMException && e.name === "TimeoutError" ? `OpenRouter call timed out (${tMs}ms)` : (e as Error).message;
    return { ok: false, error: msg };
  }
}

async function logUsage(model: string, usage: any, account: string | null, triggerKey: string | null, ok = true, error: string | null = null) {
  if (!SB_URL || !SB_KEY) return;
  const row = {
    model,
    prompt_tokens: Number(usage?.prompt_tokens) || 0,
    completion_tokens: Number(usage?.completion_tokens) || 0,
    total_tokens: Number(usage?.total_tokens) || 0,
    cost: Number(usage?.cost) || 0,
    account, trigger_key: triggerKey, source: "openrouter-agent", ok,
    error: error ? String(error).slice(0, 500) : null,
  };
  await fetch(rest("routiner_openrouter_usage"), {
    method: "POST", headers: { ...H(), Prefer: "return=minimal" }, body: JSON.stringify(row),
  }).catch(() => {});
}

async function todaySpend(): Promise<number | null> {
  if (!SB_URL || !SB_KEY) return null;
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  try {
    const rows = await sbGet(`routiner_openrouter_usage?select=cost&created_at=gte.${since.toISOString()}&limit=100000`);
    return rows.reduce((s, r: any) => s + (Number(r.cost) || 0), 0);
  } catch { return null; }
}

// ── Tools ─────────────────────────────────────────────────────────────────────
// Build the OpenAI-style tool specs for the enabled tool groups.
function toolSpecs(enabled: Set<string>): unknown[] {
  const specs: unknown[] = [
    { type: "function", function: { name: "read_spill", description: "Read a stored oversized tool result by its spill id. When a result is too large for context you get a head/tail preview plus a spill id — page the rest with this instead of re-running the tool that produced it.",
      parameters: { type: "object", required: ["spill_id"], properties: {
        spill_id: { type: "string", description: "the id from the [spill …] line in a truncated result" },
        start_line: { type: "number", description: "1-based first line to return (default 1)" },
        max_lines: { type: "number", description: "how many lines (default 400)" },
      } } } },
    { type: "function", function: { name: "set_goal", description: "Record what this run is trying to achieve and how far it has got. A long run spans several background segments and the transcript is compacted between them — this is the one place your plan survives intact. Call it once early, then update `done`/`remaining` as you go, and set phase='complete' when finished or 'blocked' when you genuinely cannot proceed.",
      parameters: { type: "object", required: ["objective"], properties: {
        objective: { type: "string", description: "the run's goal in one sentence" },
        done: { type: "array", items: { type: "string" }, description: "what is finished, shortest useful phrasing" },
        remaining: { type: "array", items: { type: "string" }, description: "what is still left, in order" },
        phase: { type: "string", enum: ["active", "blocked", "complete"], description: "default active" },
        blocked_code: { type: "string", description: "required when phase='blocked': short kebab-case cause, e.g. 'needs-human'" },
        blocked_message: { type: "string", description: "required when phase='blocked': what a human must do" },
      } } } },
    { type: "function", function: { name: "end_segment", description: "Hand off to the next background segment at a clean stopping point, instead of being cut off mid-task when this segment's step budget runs out. Replying with text ends the WHOLE run, so this is the only way to pause. Call it once you have finished a coherent piece of work and the next piece would not fit — never as a way to avoid work. Requires a current goal: the next segment starts from it.",
      parameters: { type: "object", properties: {
        note: { type: "string", description: "one line on where you stopped, for the run log" },
      } } } },
  ];
  if (enabled.has("read")) {
    specs.push(
      { type: "function", function: { name: "read_routines", description: "List the owner's Routiner routines (title, prompt, status, schedule).",
        parameters: { type: "object", properties: { limit: { type: "number", description: "max rows (default 20)" } } } } },
      { type: "function", function: { name: "read_notes", description: "List the owner's Routiner board notes.",
        parameters: { type: "object", properties: { limit: { type: "number", description: "max rows (default 30)" } } } } },
      { type: "function", function: { name: "read_leads", description: "List recent leads in the CRM (Command's Review tab / staged_leads).",
        parameters: { type: "object", properties: { limit: { type: "number", description: "max rows (default 25)" } } } } },
      { type: "function", function: { name: "read_runs", description: "Read the agent run log (Routiner History): status, model, and the final output/error of past runs — including your own. Use this to diagnose why runs are failing before proposing a fix.",
        parameters: { type: "object", properties: {
          limit: { type: "number", description: "max rows (default 20, max 100)" },
          status: { type: "string", enum: ["success", "error", "running", "cancelled", "missed"], description: "filter to one status, e.g. 'error'" },
          since_hours: { type: "number", description: "only runs fired within the last N hours" },
        } } } },
    );
  }
  if (enabled.has("research")) {
    specs.push({ type: "function", function: { name: "web_research", description: "Run live web / deep research on a query via Perplexity and return the findings.",
      parameters: { type: "object", required: ["query"], properties: { query: { type: "string", description: "what to research" } } } } });
  }
  if (enabled.has("write")) {
    specs.push(
      { type: "function", function: { name: "write_note", description: "Save a note onto the owner's Routiner board (for later planning / reuse).",
        parameters: { type: "object", required: ["body"], properties: { body: { type: "string", description: "note text (markdown ok)" } } } } },
      { type: "function", function: { name: "find_and_save_leads", description: "Find businesses matching a niche/location and save the new ones into Command's Review tab (staged_leads).",
        parameters: { type: "object", required: ["niche"], properties: {
          niche: { type: "string" }, location: { type: "string" }, count: { type: "number", description: "how many (max 25)" },
          dmTitles: { type: "array", items: { type: "string" }, description: "decision-maker title hints" },
        } } } },
    );
  }
  // Code (GitHub) — only offered when a token is configured, so the model never
  // reaches for a capability the deployment can't back.
  if (enabled.has("code") && GH_TOKEN()) {
    const repoProp = { repo: { type: "string", description: "owner/name; omit to use the configured default repo" } };
    specs.push(
      { type: "function", function: { name: "gh_read_file", description: "Read a file (or list a directory) from the repo. Returns the text and its blob sha. For large files, pass start_line + max_lines to page through (do not claim the file is unreadable — page it).",
        parameters: { type: "object", required: ["path"], properties: { ...repoProp,
          path: { type: "string", description: "path within the repo, e.g. js/app.js (a directory path returns a listing)" },
          ref: { type: "string", description: "branch, tag, or commit sha (default: the repo's default branch)" },
          start_line: { type: "number", description: "1-based line to start at (optional; use with max_lines for large files)" },
          max_lines: { type: "number", description: `how many lines to return (default ${GH_READ_DEFAULT_LINES} when start_line is set; omit both to try the whole file up to the size cap)` } } } } },
      { type: "function", function: { name: "gh_list_prs", description: "List pull requests in the repo (number, title, state, branches).",
        parameters: { type: "object", properties: { ...repoProp, state: { type: "string", enum: ["open", "closed", "all"], description: "default open" } } } } },
      { type: "function", function: { name: "gh_read_pr", description: "Read one pull request: its metadata, mergeability, and per-file diffs (patches).",
        parameters: { type: "object", required: ["number"], properties: { ...repoProp, number: { type: "number", description: "the PR number" } } } } },
      { type: "function", function: { name: "gh_read_issue", description: "Read one GitHub issue: its title, body, labels, state and recent comments. Use this whenever the task references an issue number or an issues/ URL.",
        parameters: { type: "object", required: ["number"], properties: { ...repoProp, number: { type: "number", description: "the issue number" } } } } },
      { type: "function", function: { name: "gh_list_issues", description: "List issues in the repo (number, title, state). Pull requests are flagged with is_pull_request.",
        parameters: { type: "object", properties: { ...repoProp, state: { type: "string", enum: ["open", "closed", "all"], description: "default open" } } } } },
      { type: "function", function: { name: "gh_propose_edit", description: "PREFERRED way to fix code. Change part of one or more files with exact find/replace edits and open a pull request — you do NOT need the whole file, so this works on large files. The server reads the current file, applies your edits, and commits the result.",
        parameters: { type: "object", required: ["title", "edits"], properties: { ...repoProp,
          title: { type: "string", description: "PR title / commit message" },
          body: { type: "string", description: "PR description (markdown)" },
          base: { type: "string", description: "base branch to target (default: the repo's default branch)" },
          branch: { type: "string", description: "new branch name (default: an auto-generated agent/… name)" },
          edits: { type: "array", description: "find/replace edits, applied in order", items: { type: "object", required: ["path", "old_string", "new_string"],
            properties: {
              path: { type: "string", description: "file to edit" },
              old_string: { type: "string", description: "text to find — must match the file EXACTLY (indentation included) and be unique unless replace_all is true" },
              new_string: { type: "string", description: "replacement text" },
              replace_all: { type: "boolean", description: "replace every occurrence (default false)" },
            } } } } } } },
      { type: "function", function: { name: "gh_propose_change", description: "Replace whole file(s) and open a pull request. Requires the COMPLETE new content of each file — for changing part of an existing file prefer gh_propose_edit, which does not.",
        parameters: { type: "object", required: ["title", "changes"], properties: { ...repoProp,
          title: { type: "string", description: "PR title / commit message" },
          body: { type: "string", description: "PR description (markdown)" },
          base: { type: "string", description: "base branch to target (default: the repo's default branch)" },
          branch: { type: "string", description: "new branch name (default: an auto-generated agent/… name)" },
          changes: { type: "array", description: "files to write", items: { type: "object", required: ["path", "content"],
            properties: { path: { type: "string" }, content: { type: "string", description: "the FULL new file contents" } } } } } } } },
      { type: "function", function: { name: "gh_comment_pr", description: "Post a comment on a pull request or issue (e.g. to explain a proposed fix or leave review notes).",
        parameters: { type: "object", required: ["number", "body"], properties: { ...repoProp, number: { type: "number" }, body: { type: "string" } } } } },
      { type: "function", function: { name: "gh_merge_pr", description: "Merge a pull request. Only works when the deployment has enabled merging (AGENT_ALLOW_MERGE). Prefer squash.",
        parameters: { type: "object", required: ["number"], properties: { ...repoProp, number: { type: "number" },
          method: { type: "string", enum: ["squash", "merge", "rebase"], description: "default squash" } } } } },
    );
  }
  return specs;
}

// Execute a single tool call. Returns a string result (capped by the caller).
// `enabled` is re-checked here so a model cannot invoke a tool group that was
// not offered for this run (e.g. hallucinating gh_* when code is off).
async function runTool(
  name: string,
  args: Record<string, any>,
  ctx: {
    userId: string | null; key: string; account: string | null; triggerKey: string | null;
    enabled: Set<string>; timeoutMs?: number; runId?: string | null;
    goalRef?: { current: RunGoal | null };
    handoffRef?: { current: string | null };
    segmentDepth?: number;
    toolsRunThisSegment?: number;
    doneAtSegmentStart?: number;
  },
): Promise<string> {
  const group = toolGroupOf(name);
  if (!group || (group !== "*" && !ctx.enabled.has(group))) {
    return `error: tool '${name}' is not enabled for this run.`;
  }
  // Defense in depth: never hit GitHub without a token even if code is enabled.
  if (group === "code" && !GH_TOKEN()) {
    return "error: no GITHUB_TOKEN configured on the deployment.";
  }
  // One ABSOLUTE deadline for the whole tool call, not a fresh budget per
  // sub-request. gh() already clamped each request at CALL_TIMEOUT_MS, but a
  // multi-request tool is the thing that overruns: gh_propose_edit makes ~6
  // sequential GitHub calls, so a per-request clamp let one tool spend 6 ×
  // CALL_TIMEOUT_MS and eat a segment the model then had to auto-continue out
  // of. Sub-calls now draw down a shared remaining budget.
  const toolDeadline = Date.now() + toolBudgetFor(name, ctx.timeoutMs ?? CALL_TIMEOUT_MS);
  const tLeft = () => Math.max(0, toolDeadline - Date.now());
  const owner = ctx.userId ? `user_id=eq.${encodeURIComponent(ctx.userId)}&` : "";
  try {
    switch (name) {
      case "set_goal": {
        // The goal lives on the run row, not in the transcript, precisely so
        // compaction cannot reach it — so there is nothing to persist here
        // beyond the holder the loop checkpoints.
        if (!ctx.goalRef) return "error: this run cannot record a goal.";
        const next = normalizeGoal(args, ctx.goalRef.current);
        if ("error" in next) return `error: ${next.error}`;
        ctx.goalRef.current = next;
        return `goal recorded (${next.phase}). ${renderGoal(next)}`;
      }
      case "end_segment": {
        // Every refusal below is a guard against the same failure: a segment
        // handed off with nothing for the next one to resume from, or no next
        // one to resume at all. The tool reports why rather than half-doing it.
        if (!ctx.handoffRef) return "error: this run cannot hand off to another segment.";
        const why = handoffRefusal(
          ctx.goalRef?.current ?? null,
          ctx.segmentDepth ?? 0,
          ctx.toolsRunThisSegment ?? 0,
          ctx.doneAtSegmentStart ?? 0,
        );
        if (why) return `error: ${why}`;
        ctx.handoffRef.current = String(args.note || "").trim().slice(0, 400) || "handed off at a clean stopping point";
        return "segment ended; the next segment resumes from your goal.";
      }
      case "read_spill": {
        const id = String(args.spill_id || "").trim();
        if (!id) return "error: missing spill_id";
        if (!/^[0-9a-f-]{36}$/i.test(id)) return `error: '${id}' is not a spill id. Use the id from a [spill …] line.`;
        // Scoped to this run: a spill id from another run is not this model's to
        // read, and a stale id from an earlier transcript should say so plainly
        // rather than silently return someone else's tool output.
        // Scope by BOTH owner and run where we have them. A spill id only ever
        // reaches the model through its own context, but an id-only lookup is a
        // wider query than this tool ever needs.
        const scope = (ctx.runId ? `&run_id=eq.${encodeURIComponent(ctx.runId)}` : "")
          + (ctx.userId ? `&user_id=eq.${encodeURIComponent(ctx.userId)}` : "");
        const rows = await sbGet(`routiner_tool_spills?id=eq.${encodeURIComponent(id)}${scope}&select=content,chars,tool_name&limit=1`);
        const row = rows?.[0];
        if (!row) return `error: no spill ${id} for this run. It may belong to a different run, or have been cleaned up — re-run the tool that produced it.`;
        const startLine = Math.max(1, Math.floor(Number(args.start_line) || 1));
        const maxLines = Math.max(1, Math.min(Math.floor(Number(args.max_lines) || GH_READ_DEFAULT_LINES), 5_000));
        const win = sliceLines(String(row.content ?? ""), startLine, maxLines);
        const bodyPoints = Array.from(win.body).length;
        const body = bodyPoints > SPILL_WINDOW_CHARS
          ? Array.from(win.body).slice(0, SPILL_WINDOW_CHARS).join("")
            + `\n…[${bodyPoints - SPILL_WINDOW_CHARS} of ${bodyPoints} chars of this window not shown — re-call read_spill with a smaller max_lines, or a later start_line to continue]`
          : win.body;
        const more = win.to < win.total
          ? `\n\n[lines ${win.from}-${win.to} of ${win.total}. More follows: read_spill with start_line=${win.to + 1}.]`
          : `\n\n[lines ${win.from}-${win.to} of ${win.total} — end of ${row.tool_name || "result"}.]`;
        return body + more;
      }
      case "read_routines": {
        const lim = Math.min(Number(args.limit) || 20, 100);
        const rows = await sbGet(`routiner_routines?${owner}select=id,title,prompt,status,recurrence,scheduled_at,account,model&order=updated_at.desc&limit=${lim}`);
        return JSON.stringify(rows);
      }
      case "read_notes": {
        const lim = Math.min(Number(args.limit) || 30, 200);
        const rows = await sbGet(`routiner_notes?${owner}select=id,body,status&order=created_at.desc&limit=${lim}`);
        return JSON.stringify(rows);
      }
      case "read_runs": {
        // The agent's own telemetry. Without this an agent asked to "find out why
        // runs fail" can only guess — it cannot see History at all.
        const lim = Math.min(Number(args.limit) || 20, 100);
        const st = typeof args.status === "string" && args.status.trim()
          ? `status=eq.${encodeURIComponent(args.status.trim())}&` : "";
        let since = "";
        const hrs = Number(args.since_hours);
        if (hrs > 0) {
          since = `fired_at=gte.${encodeURIComponent(new Date(Date.now() - hrs * 3_600_000).toISOString())}&`;
        }
        // Exclude the caller's own row. A diagnosis run checkpoints its actions
        // to `output` as it goes, so without this it reads itself: its own recap
        // comes back as the newest "error", crowding out the real failures. The
        // first self-repair run reported exactly that — "the returned run list
        // was truncated by the currently running self-repair run recursively
        // echoing its own actions".
        const notSelf = ctx.runId ? `id=neq.${encodeURIComponent(ctx.runId)}&` : "";
        const rows = await sbGet(
          `routiner_runs?${owner}${notSelf}${st}${since}select=id,title,status,model,fired_at,output&order=fired_at.desc&limit=${lim}`,
        );
        // Trim each output — a full transcript tail would blow the tool cap and
        // crowd out the rest of the diagnosis.
        const trimmed = (rows || []).map((r: any) => ({
          ...r,
          output: String(r.output || "").slice(0, 1200),
        }));
        return JSON.stringify(trimmed);
      }
      case "read_leads": {
        const lim = Math.min(Number(args.limit) || 25, 200);
        const rows = await sbGet(`staged_leads?select=business_name,website_domain,phone_e164,vertical,status,created_at&order=created_at.desc&limit=${lim}`);
        return JSON.stringify(rows);
      }
      case "web_research": {
        const query = String(args.query || "").trim();
        if (!query) return "error: empty query";
        // Research is slow; starting one with a few seconds left just guarantees
        // a timeout and wastes the step. Defer it to the next segment instead.
        if (tLeft() < 12_000) {
          return "error: not enough time left in this segment to research. Do it first thing next segment, or finish with what you already have.";
        }
        const r = await openrouter(ctx.key, RESEARCH_MODEL,
          [{ role: "system", content: "You are a precise research assistant. Answer with well-sourced, specific findings." }, { role: "user", content: query }],
          { maxTokens: 2000, timeoutMs: tLeft() });
        await logUsage(RESEARCH_MODEL, r.usage, ctx.account, ctx.triggerKey, r.ok, r.error ?? null);
        if (!r.ok) return `error: ${r.error}`;
        return (r.message?.content || "(empty)").toString();
      }
      case "write_note": {
        const bodyText = String(args.body || "").trim();
        if (!bodyText) return "error: empty note body";
        if (!ctx.userId) return "error: could not resolve owner to save the note";
        const res = await fetch(rest("routiner_notes"), {
          method: "POST", headers: { ...H(), Prefer: "return=minimal" },
          body: JSON.stringify({ user_id: ctx.userId, body: bodyText, status: "brainstorm" }),
        });
        return res.ok ? "saved note to the board (status: brainstorm)" : `error: insert failed (${res.status})`;
      }
      case "find_and_save_leads": {
        const niche = String(args.niche || "").trim();
        if (!niche) return "error: missing niche";
        // Cap enrichment wait so a single tool can't blow the whole agent budget.
        const enrichMs = Math.min(90_000, Math.max(10_000, tLeft()));
        const res = await fetch(`${SB_URL}/functions/v1/lead-enrichment`, {
          method: "POST", headers: { ...H() },
          body: JSON.stringify({
            niche, location: args.location ?? null, count: Math.min(Number(args.count) || 10, 25),
            dmTitles: Array.isArray(args.dmTitles) ? args.dmTitles : [], toCommand: true, syncAbstrax: false, report: false,
          }),
          signal: AbortSignal.timeout(enrichMs),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) return `error: ${data.error || `enrichment HTTP ${res.status}`}`;
        const t = data.totals || {};
        return `saved ${t.inserted ?? 0} new lead(s) to Command's Review tab (~$${Number(t.cost || 0).toFixed(4)}).`;
      }

      // ── Code (GitHub) ─────────────────────────────────────────────────────
      case "gh_read_file": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        // An omitted/"."/"/" path means "show me the repo root" — that's what the
        // model wants, and erroring here just cost it a step.
        let path = String(args.path ?? "").trim().replace(/^\.\/+/, "");
        if (path === "." || path === "/") path = "";
        const refQ = args.ref ? `?ref=${encodeURIComponent(String(args.ref))}` : "";
        let r = await gh("GET", `/repos/${repo}/contents/${ghPath(path)}${refQ}`, undefined, tLeft());
        // 404 is usually a casing miss. Resolve it against the parent listing
        // instead of making the model guess again.
        if (!r.ok && r.status === 404 && path) {
          const fix = await resolveCasePath(repo!, path, args.ref ? String(args.ref) : undefined, tLeft());
          if (fix.path && fix.path !== path) {
            const retry = await gh("GET", `/repos/${repo}/contents/${ghPath(fix.path)}${refQ}`, undefined, tLeft());
            if (retry.ok) { path = fix.path; r = retry; }
          } else if (fix.candidates?.length) {
            return `error: '${path}' not found. That directory contains:\n${fix.candidates.join("\n")}\n\nUse one of these exact paths (they are case-sensitive).`;
          }
        }
        if (!r.ok) return `error: read ${path || "/"} → ${r.status}: ${String(r.data?.message || "").slice(0, 160)}`;
        if (Array.isArray(r.data)) {
          return `directory ${path || "/"}:\n` + r.data.map((e: any) => `${e.type === "dir" ? "dir " : "file"}  ${e.path}`).join("\n");
        }
        // Contents API omits body for files > ~1MB — fall back to the Git Blobs API.
        let text = "";
        const blobSha = r.data?.sha ? String(r.data.sha) : "";
        if (r.data?.encoding === "base64" && r.data?.content) {
          try { text = b64decode(r.data.content); } catch {
            return `error: ${path} could not be decoded as UTF-8 text.`;
          }
        } else if (blobSha) {
          const blob = await gh("GET", `/repos/${repo}/git/blobs/${blobSha}`, undefined, tLeft());
          if (!blob.ok) return `error: read blob ${path} → ${blob.status}: ${String(blob.data?.message || "").slice(0, 160)}`;
          if (blob.data?.encoding === "base64" && blob.data?.content) {
            try { text = b64decode(blob.data.content); } catch {
              return `error: ${path} could not be decoded as UTF-8 text.`;
            }
          } else {
            return `error: ${path} is not a readable text file (size ${r.data?.size ?? "?"}).`;
          }
        } else {
          return `error: ${path} is not a readable text file.`;
        }
        const lines = text.split("\n");
        const totalLines = lines.length;
        const totalChars = text.length;
        const hasStart = args.start_line != null && Number(args.start_line) > 0;
        const hasMax = args.max_lines != null && Number(args.max_lines) > 0;
        // Auto-page when the whole file would exceed the read cap and the model
        // didn't already request a window — never return a silent partial file.
        let start = hasStart ? Math.max(1, Math.floor(Number(args.start_line))) : 1;
        let maxLines = hasMax
          ? Math.max(1, Math.min(Math.floor(Number(args.max_lines)), 5_000))
          : (hasStart ? GH_READ_DEFAULT_LINES : totalLines);
        if (!hasStart && !hasMax && totalChars > GH_READ_RESULT_CAP) {
          maxLines = GH_READ_DEFAULT_LINES;
          start = 1;
        }
        const end = Math.min(totalLines, start + maxLines - 1);
        const slice = lines.slice(start - 1, end).join("\n");
        const header = [
          `path: ${r.data.path || path}`,
          `sha: ${blobSha}`,
          `lines: ${start}-${end} of ${totalLines}`,
          `chars: ${slice.length} of ${totalChars}`,
        ].join("\n");
        let body = `${header}\n\n${slice}`;
        if (end < totalLines) {
          body += `\n\n…[more content after line ${end}. Re-call gh_read_file with start_line=${end + 1} and max_lines=${GH_READ_DEFAULT_LINES} (or a larger max_lines). For a full rewrite you need the complete file — page until lines cover 1-${totalLines}, or target a smaller change.]`;
        }
        return body;
      }
      case "gh_list_prs": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const state = ["open", "closed", "all"].includes(args.state) ? args.state : "open";
        const r = await gh("GET", `/repos/${repo}/pulls?state=${state}&per_page=20`, undefined, tLeft());
        if (!r.ok) return `error: list PRs → ${r.status}: ${String(r.data?.message || "").slice(0, 160)}`;
        return JSON.stringify((r.data || []).map((p: any) => ({ number: p.number, title: p.title, state: p.state, head: p.head?.ref, base: p.base?.ref, draft: p.draft, url: p.html_url })));
      }
      case "gh_read_pr": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const n = Number(args.number); if (!n) return "error: missing PR number";
        const pr = await gh("GET", `/repos/${repo}/pulls/${n}`, undefined, tLeft());
        if (!pr.ok) return `error: read PR ${n} → ${pr.status}: ${String(pr.data?.message || "").slice(0, 160)}`;
        const files = await gh("GET", `/repos/${repo}/pulls/${n}/files?per_page=50`, undefined, tLeft());
        const fileList = (files.ok && Array.isArray(files.data))
          ? files.data.map((f: any) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: String(f.patch || "").slice(0, 2000) }))
          : [];
        return JSON.stringify({ number: pr.data.number, title: pr.data.title, body: String(pr.data.body || "").slice(0, 1000),
          state: pr.data.state, mergeable: pr.data.mergeable, mergeable_state: pr.data.mergeable_state,
          head: pr.data.head?.ref, base: pr.data.base?.ref, files: fileList });
      }
      case "gh_propose_change": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const changes = Array.isArray(args.changes) ? args.changes.filter((c: any) => c && c.path) : [];
        if (!changes.length) {
          return "error: no changes provided (need at least one { path, content }). If you only want to alter part of a file, use gh_propose_edit instead — it does not need the whole file.";
        }
        const files = changes.map((c: any) => ({
          path: String(c.path || "").replace(/^\/+/, "").replace(/\\/g, "/"),
          content: String(c.content ?? ""),
        }));
        return await openPrWithFiles(repo!, args, files, toolDeadline);
      }
      case "gh_propose_edit": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const rawEdits = Array.isArray(args.edits) ? args.edits.filter((e: any) => e && e.path) : [];
        if (!rawEdits.length) return "error: no edits provided (need at least one { path, old_string, new_string }).";
        // Group by file so several edits to one file are applied in sequence.
        const byPath = new Map<string, any[]>();
        for (const e of rawEdits) {
          const p = String(e.path || "").replace(/^\/+/, "").replace(/\\/g, "/");
          if (!byPath.has(p)) byPath.set(p, []);
          byPath.get(p)!.push(e);
        }
        if (byPath.size > GH_MAX_FILES) {
          return `error: too many files (${byPath.size}); max is ${GH_MAX_FILES} per PR. Split the work.`;
        }
        const files: Array<{ path: string; content: string }> = [];
        const matchNotes: string[] = [];
        for (const [p, edits] of byPath) {
          const deny = deniedWritePath(p);
          if (deny) return `error: blocked path '${p}': ${deny}`;
          // Read the CURRENT file from the base branch — the agent never has to
          // reproduce it, which is what made whole-file rewrites fail on big files.
          const cur = await gh("GET", `/repos/${repo}/contents/${ghPath(p)}`, undefined, tLeft());
          if (!cur.ok) return `error: read ${p} → ${cur.status}: ${String(cur.data?.message || "").slice(0, 160)}`;
          if (Array.isArray(cur.data)) return `error: '${p}' is a directory, not a file.`;
          let text = "";
          if (cur.data?.encoding === "base64" && cur.data?.content) {
            try { text = b64decode(cur.data.content); } catch { return `error: ${p} is not UTF-8 text.`; }
          } else {
            const blob = cur.data?.sha ? await gh("GET", `/repos/${repo}/git/blobs/${cur.data.sha}`, undefined, tLeft()) : null;
            if (!blob?.ok || blob.data?.encoding !== "base64") return `error: ${p} is not a readable text file.`;
            try { text = b64decode(blob.data.content); } catch { return `error: ${p} is not UTF-8 text.`; }
          }
          const applied = applyEdits(text, edits, p);
          if (applied.error) return `error: ${applied.error}`;
          if (applied.notes) matchNotes.push(...applied.notes);
          files.push({ path: p, content: applied.content! });
        }
        return await openPrWithFiles(repo!, args, files, toolDeadline, matchNotes);
      }
      case "gh_read_issue": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const n = Number(args.number); if (!n) return "error: missing issue number";
        const r = await gh("GET", `/repos/${repo}/issues/${n}`, undefined, tLeft());
        if (!r.ok) return `error: read issue #${n} → ${r.status}: ${String(r.data?.message || "").slice(0, 160)}`;
        const cm = await gh("GET", `/repos/${repo}/issues/${n}/comments?per_page=20`, undefined, tLeft());
        const comments = (cm.ok && Array.isArray(cm.data))
          ? cm.data.map((c: any) => ({ user: c.user?.login, body: String(c.body || "").slice(0, 2000) }))
          : [];
        return JSON.stringify({
          number: r.data.number, title: r.data.title, state: r.data.state,
          is_pull_request: !!r.data.pull_request,
          labels: (r.data.labels || []).map((l: any) => (typeof l === "string" ? l : l?.name)).filter(Boolean),
          body: String(r.data.body || "").slice(0, 8000),
          url: r.data.html_url, comments,
        });
      }
      case "gh_list_issues": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const state = ["open", "closed", "all"].includes(args.state) ? args.state : "open";
        const r = await gh("GET", `/repos/${repo}/issues?state=${state}&per_page=30`, undefined, tLeft());
        if (!r.ok) return `error: list issues → ${r.status}: ${String(r.data?.message || "").slice(0, 160)}`;
        // The issues endpoint also returns PRs; mark them so the model can tell.
        return JSON.stringify((r.data || []).map((i: any) => ({
          number: i.number, title: i.title, state: i.state,
          is_pull_request: !!i.pull_request, url: i.html_url,
        })));
      }
      case "gh_comment_pr": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const n = Number(args.number); if (!n) return "error: missing PR/issue number";
        const bodyText = String(args.body || "").trim(); if (!bodyText) return "error: empty comment";
        const r = await gh("POST", `/repos/${repo}/issues/${n}/comments`, { body: bodyText }, tLeft());
        return r.ok ? `commented on #${n}: ${r.data?.html_url || "ok"}` : `error: comment #${n} → ${r.status}: ${String(r.data?.message || "").slice(0, 160)}`;
      }
      case "gh_merge_pr": {
        if (!GH_TOKEN()) return "error: no GITHUB_TOKEN configured on the deployment.";
        if (!GH_ALLOW_MERGE()) return "error: merging is disabled. Set the AGENT_ALLOW_MERGE edge secret to 'true' to allow it.";
        const { repo, error } = resolveRepo(args.repo); if (error) return `error: ${error}`;
        const n = Number(args.number); if (!n) return "error: missing PR number";
        // Only merge agent-created branches — never an arbitrary open PR in the repo.
        const prMeta = await gh("GET", `/repos/${repo}/pulls/${n}`, undefined, tLeft());
        if (!prMeta.ok) return `error: read PR #${n} → ${prMeta.status}: ${String(prMeta.data?.message || "").slice(0, 160)}`;
        const headRef = String(prMeta.data?.head?.ref || "");
        if (!headRef.startsWith("agent/")) {
          return `error: can only merge PRs whose head branch starts with 'agent/' (PR #${n} head is '${headRef || "?"}'). Open a new agent PR or merge manually.`;
        }
        if (prMeta.data?.state && prMeta.data.state !== "open") {
          return `error: PR #${n} is not open (state: ${prMeta.data.state}).`;
        }
        const method = ["squash", "merge", "rebase"].includes(args.method) ? args.method : "squash";
        const r = await gh("PUT", `/repos/${repo}/pulls/${n}/merge`, { merge_method: method }, tLeft());
        if (!r.ok) return `error: merge #${n} → ${r.status}: ${String(r.data?.message || "").slice(0, 200)}`;
        return `merged PR #${n} (${method})${r.data?.sha ? ` — commit ${String(r.data.sha).slice(0, 7)}` : ""}.`;
      }

      default:
        return `error: unknown tool '${name}'`;
    }
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

// The system prompt that frames an instance. Shared by fresh runs and by the
// reconstruction path for legacy runs that predate stored transcripts.
/**
 * Where this segment sits in the run, as a line the model can act on.
 *
 * A run can span six edge invocations across hours, and the model had no way to
 * know which one it was in or how much time was left — so it explored at the
 * same leisurely pace on the last segment as the first, and the transcript's
 * only urgency signal was AUTO_CONTINUE_PROMPT telling it to hurry with no
 * numbers behind the instruction.
 */
function segmentOrientation(depth: number, elapsedMs: number, wallMs: number): string {
  const secs = Math.max(0, Math.round(wallMs / 1000));
  const mins = Math.floor(elapsedMs / 60_000);
  const spent = mins >= 1 ? `${mins}m so far in this run; ` : "";
  return `[orientation] Segment ${depth + 1} of at most ${MAX_AUTO_CONTINUES + 1}. `
    + `${spent}about ${secs}s of working time in this segment. `
    + (depth >= MAX_AUTO_CONTINUES
      ? "This is the LAST segment — finish and summarize now; there is no next one."
      : "Unfinished work carries to the next segment, but each hand-off costs time — prefer finishing.");
}

function buildSystem(model: string, toolList: string): string {
  return `You are a Routiner agent instance running the model ${model}. You complete the user's task fully — like a coding agent that keeps going until the job is done. Results are saved to Routiner History; the user can also reply later.
You have these tool capabilities: ${toolList}.

Efficiency rules (critical — you have limited steps per segment):
- Prefer acting over exploring. A 404 on a read is corrected for you automatically when it's only a casing difference, and otherwise comes back with the real directory listing — read that listing instead of guessing again.
- Do not re-read a file you already have in the transcript. Call gh_read_file with path "." only when you truly don't know the layout.
- Large files: gh_read_file supports start_line + max_lines. If a read says "more content after line N", page with start_line=N+1 — do NOT say the file is too large or unreadable.
- A result ending in "[spill <id> …]" means the FULL text was stored, not lost: you got the head and tail. Page the middle with read_spill({"spill_id":"<id>","start_line":N,"max_lines":M}). Never re-run the original tool to see the rest.
- To change part of a file, use gh_propose_edit with exact find/replace edits. You do NOT need to have read the whole file, and you must never reproduce a large file just to change a few lines. Copy old_string verbatim from what you read, including indentation, and include enough surrounding lines to make it unique.
- Use gh_propose_change (whole-file) only for a new file or a total rewrite.
- If the task mentions an issue number or an issues/ URL, call gh_read_issue to get its contents — do not ask the user to paste it.
- For code fixes: read the target region → gh_propose_edit → stop tools and summarize with the PR URL.
- One focused change set per task. Do not start a second unrelated fix in the same run.
- Use read_* / web_research only when needed for the task. Skip them for pure code edits when the user already named the file/repo.
- gh_merge_pr only if merge is enabled and the head is agent/*; when unsure, open the PR and stop.
- When the work is done (PR opened, note saved, research answered), write a concise final summary and call NO more tools.

Do not claim to have done something a tool did not confirm.`;
}

// Shrink old tool payloads so long runs don't blow the context window / latency.
// Budget-based, not count-based: newest tool results are kept in full until
// `budget` characters are spent, then everything older is cut to a small floor.
// (Counting messages instead of characters is what let three large file reads
// put ~360k chars into a single request.) Never mutates the input.
//
// The floor keeps a HEAD **and** a TAIL, because for every GitHub tool here the
// answer tends to sit at the end: gh_read_pr's per-file patches, an error line
// appended after a successful-looking preamble, the last entries of a directory
// listing. Head-only flooring threw away exactly the part the model needed and
// sent it back to re-read the same file — the repeat loop the guard below
// watches for. Splitting the same 400 chars costs nothing extra.
const TOOL_FLOOR_CHARS = 400;
const TOOL_FLOOR_HEAD = 280;
const TOOL_FLOOR_TAIL = TOOL_FLOOR_CHARS - TOOL_FLOOR_HEAD;

/**
 * Keep a head and a tail of `text`, replacing the middle with a marker that
 * says how much went.
 *
 * The marker is quantitative on purpose. An unmeasured "…[truncated]…" leaves
 * the model unable to tell fifty lost characters from fifty thousand, so it
 * cannot judge whether recovering them is worth a step — and the cheapest way
 * to find out is to re-run the tool, which is the loop the repeat guard then
 * has to catch. Truncation was manufacturing the loop.
 *
 * Slicing is by Unicode code point, never by UTF-16 unit: `"…".slice(0, n)` can
 * cut a surrogate pair in half and emit a lone surrogate, which then rides into
 * a jsonb column and a JSON request body as invalid text.
 *
 * @param text the full text
 * @param head code points to keep from the start
 * @param tail code points to keep from the end
 * @param fate what happened to the middle, stated to the model
 * @returns `text` unchanged when it already fits, otherwise head + marker + tail
 */
function headTail(text: string, head: number, tail: number, fate = "dropped to save context"): string {
  const points = Array.from(text);
  if (points.length <= head + tail) return text;
  const omitted = points.length - head - tail;
  const lines = text.split("\n").length;
  const marker = `\n…[${omitted} of ${points.length} chars ${fate}; ${lines} line${lines === 1 ? "" : "s"} total]…\n`;
  return points.slice(0, head).join("") + marker + points.slice(points.length - tail).join("");
}

function compactMessages(messages: any[], budget: number = CONTEXT_TOOL_BUDGET): any[] {
  const cap = Number.isFinite(budget) && budget > 0 ? budget : 0;
  // `_source` is ours, not OpenAI's: it stays in the stored transcript (that is
  // the whole point) but must never reach a provider, where an unknown message
  // field is a 400 on the strict ones.
  const out = messages.map((m) => {
    if (!m || m._source === undefined) return m;
    const { _source: _drop, ...rest } = m;
    return rest;
  });
  let spent = 0;
  // Newest → oldest, so the model always keeps the results it's reasoning about.
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m?.role !== "tool") continue;
    const c = String(m.content ?? "");
    const len = Array.from(c).length;
    if (len <= TOOL_FLOOR_CHARS) { spent += len; continue; }
    if (spent + len <= cap) { spent += len; continue; }
    // Charge what the floored text actually costs, marker included — the marker
    // grew when it started carrying counts, and an under-count here would let
    // the budget drift above CONTEXT_TOOL_BUDGET.
    // Floor the preview but never the locator: without it the spilled text is
    // unreachable and re-running the tool is the model's only way back to it.
    const spill = splitSpillLocator(c);
    const flooredContent = spill
      ? `${headTail(spill.body, TOOL_FLOOR_HEAD, TOOL_FLOOR_TAIL)}\n${shortSpillLocator(spill.id)}`
      : headTail(c, TOOL_FLOOR_HEAD, TOOL_FLOOR_TAIL);
    out[i] = { ...m, content: flooredContent };
    spent += Array.from(flooredContent).length;
  }
  return out;
}

// ── Run goal ─────────────────────────────────────────────────────────────────
// The objective, carried across segments in a place compaction cannot reach.
// `messages` is compacted — old tool results are floored to a few hundred
// characters — so by segment four the model's record of what it already tried is
// mostly gone, and AUTO_CONTINUE_PROMPT was asking it to "resume from the
// transcript" it could no longer read.

type GoalPhase = "active" | "blocked" | "complete";
interface RunGoal {
  objective: string;
  done: string[];
  remaining: string[];
  phase: GoalPhase;
  blocked_reason?: { code: string; message: string };
}

const GOAL_LIST_MAX = 12;
const GOAL_ITEM_CHARS = 200;
const GOAL_OBJECTIVE_CHARS = 600;

function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, GOAL_LIST_MAX)
    .map((s) => (s.length > GOAL_ITEM_CHARS ? s.slice(0, GOAL_ITEM_CHARS) + "…" : s));
}

/**
 * Validate a model-authored goal. This IS a model/tool JSON boundary, so every
 * field is checked rather than trusted: an unknown `phase` silently stored would
 * make the run's state unreadable to the scheduler and the UI that route on it.
 */
function normalizeGoal(input: any, prev: RunGoal | null): RunGoal | { error: string } {
  const objectiveRaw = String(input?.objective ?? prev?.objective ?? "").trim();
  if (!objectiveRaw) return { error: "missing objective (state the run's goal in one sentence)" };
  const phaseRaw = String(input?.phase ?? prev?.phase ?? "active").trim().toLowerCase();
  if (phaseRaw !== "active" && phaseRaw !== "blocked" && phaseRaw !== "complete") {
    return { error: `phase must be one of active|blocked|complete (got '${phaseRaw}')` };
  }
  const phase = phaseRaw as GoalPhase;
  const goal: RunGoal = {
    objective: objectiveRaw.slice(0, GOAL_OBJECTIVE_CHARS),
    done: cleanList(input?.done ?? prev?.done),
    remaining: cleanList(input?.remaining ?? prev?.remaining),
    phase,
  };
  if (phase === "blocked") {
    const code = String(input?.blocked_code ?? prev?.blocked_reason?.code ?? "").trim().toLowerCase();
    const message = String(input?.blocked_message ?? prev?.blocked_reason?.message ?? "").trim();
    // A blocked run with no reason is the dead-end this exists to prevent: the
    // next segment (and the human) would have nothing to act on.
    if (!code || !message) return { error: "phase 'blocked' requires blocked_code (short kebab-case) and blocked_message (what a human must do)" };
    goal.blocked_reason = { code: code.slice(0, 60), message: message.slice(0, 400) };
  }
  return goal;
}

/** The goal rendered for the model — short, and never compacted away. */
function renderGoal(goal: RunGoal | null): string {
  if (!goal) return "";
  const lines = [`[goal] ${goal.objective}`, `phase: ${goal.phase}`];
  if (goal.done.length) lines.push(`done: ${goal.done.map((d) => `\n  ✓ ${d}`).join("")}`);
  if (goal.remaining.length) lines.push(`remaining: ${goal.remaining.map((d) => `\n  • ${d}`).join("")}`);
  if (goal.blocked_reason) lines.push(`blocked (${goal.blocked_reason.code}): ${goal.blocked_reason.message}`);
  return lines.join("\n");
}

/** Read back a stored goal, ignoring anything that is not a well-formed record. */
function parseStoredGoal(v: unknown): RunGoal | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const g = normalizeGoal(v, null);
  return "error" in g ? null : g;
}

// ── Tool-output spill ────────────────────────────────────────────────────────

/** Line-addressed window over spilled text, so read_spill pages like gh_read_file. */
function sliceLines(text: string, startLine: number, maxLines: number): { body: string; from: number; to: number; total: number } {
  const lines = text.split("\n");
  const from = Math.max(1, Math.min(startLine, lines.length));
  const to = Math.max(from, Math.min(from + maxLines - 1, lines.length));
  return { body: lines.slice(from - 1, to).join("\n"), from, to, total: lines.length };
}

/**
 * Store the full result and build the bounded replacement the model sees.
 *
 * Best-effort by contract: if the insert fails there is no spill row to point
 * at, so the caller keeps its own (capped) inline text. A storage problem must
 * never turn a successful tool call into an error or lose the result outright —
 * the whole point is to lose LESS than truncation did.
 *
 * @returns the replacement text, or null to keep the original inline.
 */
async function spillResult(
  text: string,
  toolName: string,
  args: Record<string, any>,
  ctx: { userId: string | null; runId?: string | null },
): Promise<string | null> {
  const total = Array.from(text).length;
  if (total <= SPILL_THRESHOLD) return null;
  let id = "";
  try {
    const res = await fetch(rest("routiner_tool_spills"), {
      method: "POST",
      headers: { ...H(), Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: ctx.userId, run_id: ctx.runId ?? null,
        tool_name: toolName, args, content: text, chars: total,
      }),
      signal: AbortSignal.timeout(SPILL_WRITE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const rows = await res.json().catch(() => null);
    id = Array.isArray(rows) && rows[0]?.id ? String(rows[0].id) : "";
  } catch {
    // Network/REST failure writing a disposable cache. Keeping the inline text
    // is strictly better than failing the tool call.
    return null;
  }
  if (!id) return null;

  const half = Math.max(1, Math.floor(SPILL_PREVIEW_CHARS / 2));
  const points = Array.from(text);
  const head = points.slice(0, half).join("");
  const tail = points.slice(points.length - half).join("");
  const lines = text.split("\n").length;
  return `${head}\n\n…[${total - SPILL_PREVIEW_CHARS} of ${total} chars omitted — the FULL result is stored, not lost]…\n\n${tail}\n\n`
    + `[spill ${id} — ${total} chars, ${lines} lines. `
    + `Read any part with read_spill({"spill_id":"${id}","start_line":N,"max_lines":M}). `
    + `Do NOT re-run ${toolName} to see the rest; page this spill instead.]`;
}

// ── Keeping a spill reachable through compaction ─────────────────────────────
// A spilled result is a preview plus a locator, and the locator is the only
// thing that makes the stored text reachable. It sits on the last line, and the
// compaction floor keeps 120 characters of tail — far less than the locator is
// long — so flooring a spilled result silently destroyed the id and stranded
// the very text the spill notice had just promised was "stored, not lost". The
// model's only route back to it was to re-run the tool: exactly the loop
// spilling exists to prevent. The floor now re-attaches a compact locator.

const SPILL_LOCATOR_PREFIX = "[spill ";

/** The compact locator kept when a spilled result is floored. */
function shortSpillLocator(id: string): string {
  return `${SPILL_LOCATOR_PREFIX}${id} — the full result is stored, not lost. `
    + `Page it with read_spill({"spill_id":"${id}"}); do NOT re-run the tool.]`;
}

/**
 * Split a tool result into its body and the spill id its trailing locator names.
 *
 * @param content a stored tool result
 * @returns the id and the body without the locator line, or null when there is no locator
 */
function splitSpillLocator(content: string): { id: string; body: string } | null {
  const nl = content.lastIndexOf("\n");
  const last = nl < 0 ? content : content.slice(nl + 1);
  if (!last.startsWith(SPILL_LOCATOR_PREFIX) || !last.endsWith("]")) return null;
  const m = /^\[spill ([0-9a-f-]{36})\b/i.exec(last);
  if (!m) return null;
  return { id: m[1], body: nl < 0 ? "" : content.slice(0, nl).trimEnd() };
}

// ── Repeat-tool chain ────────────────────────────────────────────────────────

/** Deep key-sort so two argument objects differing only in key order canonicalize alike. */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(rec).sort()) sorted[k] = sortJsonValue(rec[k]);
    return sorted;
  }
  return value;
}

/** Canonical identity of one call: `[tool name, deep-key-sorted args]`. */
function repeatKey(name: string, args: unknown): string {
  let parsed: unknown = args;
  if (typeof args === "string") {
    // Tool-call arguments arrive as a JSON string; malformed JSON keeps the raw
    // string, which still compares correctly against an identical repeat.
    try { parsed = JSON.parse(args || "{}"); } catch { parsed = args; }
  }
  return JSON.stringify([name, JSON.stringify(sortJsonValue(parsed))]);
}

/** Compile one `*`-wildcard pattern to an anchored RegExp; every other metacharacter is literal. */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
}
const REPEAT_EXCLUDE_RE = REPEAT_EXCLUDE.map(wildcardToRegExp);
function repeatTracked(name: string): boolean {
  return !REPEAT_EXCLUDE_RE.some((re) => re.test(name));
}

/**
 * Length of the run of consecutive identical tracked calls ending at the newest
 * call in `messages`. Derived from the transcript rather than held in memory,
 * because an auto-continue segment is a fresh edge invocation: in-memory state
 * would reset at exactly the boundary a stuck run is most likely to cross.
 * A human reply resets the chain (the context changed, so repetition across it
 * is not a loop); an injected auto-continue prompt does not.
 */
function repeatChainCount(messages: any[]): { key: string; count: number } {
  let key = "";
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isHumanTurn(m)) break;
    if (m?.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    // Within one assistant turn the calls are ordered oldest→newest.
    for (let j = m.tool_calls.length - 1; j >= 0; j--) {
      const tc = m.tool_calls[j];
      const name = tc?.function?.name || "";
      if (!repeatTracked(name)) continue; // transparent: neither counts nor resets
      const k = repeatKey(name, tc?.function?.arguments);
      if (count === 0) { key = k; count = 1; continue; }
      if (k !== key) return { key, count };
      count++;
    }
  }
  return { key, count };
}

const REPEAT_GENTLE =
  "You are repeating the exact same tool call with identical arguments. Carefully "
  + "analyze the previous result before calling again: if the task is not complete, "
  + "try a different approach or different arguments instead of repeating the call.";

function repeatDetailed(name: string, count: number, args: string): string {
  const shown = Array.from(args).length > REPEAT_ARGS_PREVIEW
    ? Array.from(args).slice(0, REPEAT_ARGS_PREVIEW).join("") + `… (+${Array.from(args).length - REPEAT_ARGS_PREVIEW} more chars)`
    : args;
  return "Repeated tool call detected:\n"
    + `- tool: ${name}\n`
    + `- consecutive_calls: ${count}\n`
    + `- arguments: ${shown}\n`
    + "The repeated calls are not making progress. Do not call this tool with these "
    + "exact arguments again. Inspect the latest result and choose a different action, "
    + "different arguments, or finish the task if enough evidence has been gathered.";
}

/**
 * The reminder to inject after this step's tool results, or `null` when the run
 * length has not reached a configured threshold. The preview cap bounds the
 * reminder only — the chain key always compares the full canonical arguments,
 * so a looping `gh_propose_change` payload cannot ride into the next request.
 */
function repeatReminder(messages: any[]): { text: string; tool: string; count: number } | null {
  if (REPEAT_THRESHOLDS.length === 0) return null;
  const { key, count } = repeatChainCount(messages);
  if (!REPEAT_THRESHOLDS.includes(count)) return null;
  let name = "the tool";
  let args = "";
  try {
    const [n, a] = JSON.parse(key) as [string, string];
    name = n; args = a;
  } catch { /* key is always our own JSON; a parse failure only costs detail */ }
  const text = count === REPEAT_THRESHOLDS[0] ? REPEAT_GENTLE : repeatDetailed(name, count, args);
  return { text, tool: name, count };
}

// Did THIS tool call actually open a pull request?
//
// This must key off the tool that ran, not off text appearing somewhere in a
// result. Testing `/opened PR #/` against every result meant an agent that
// merely READ a file containing that phrase — including this very function,
// whose success message is `opened PR #${n}` — was treated as having opened
// one: tools were disabled and the run reported a PR that never existed.
// Only a PR-opening tool counts, only from its own success line, and the URL
// is taken from the tool's output so the claim is always grounded.
const PR_OPENING_TOOLS = new Set(["gh_propose_change", "gh_propose_edit"]);
function detectOpenedPr(toolName: string, result: string): { opened: boolean; url: string } {
  if (!PR_OPENING_TOOLS.has(toolName)) return { opened: false, url: "" };
  const m = /^opened PR #\d+:\s*(\S+)/i.exec(String(result || "").trim());
  return m ? { opened: true, url: m[1] } : { opened: false, url: "" };
}

function isBudgetStop(text: string): boolean {
  return /time budget|maximum number of tool steps|mid-tools|Paused on step|will continue|Continuing in the background/i.test(text || "");
}

function isHardError(text: string): boolean {
  if (!/^⚠\s*Model error/i.test(text || "")) return false;
  // Timeouts / rate limits are recoverable — auto-continue should still fire.
  if (/timed out|timeout|rate.?limit|overloaded|temporar/i.test(text)) return false;
  return true;
}

// Worth another attempt. Deliberately broad: OpenRouter surfaces upstream
// provider flakiness through several unrelated strings, and treating any of them
// as fatal ends a run that would have succeeded on the next call. Anything NOT
// matched here is treated as permanent and fails fast — keep genuinely
// unrecoverable errors (bad key, out of credit, unknown model) out of this list.
// "Unrecoverable" means it repeats identically on the next call: a throttle does
// not qualify, however final its wording sounds.
function isTransientModelError(err: string, status?: number): boolean {
  const e = err || "";
  // The HTTP status wins when we have it. The body message is provider prose and
  // is not a reliable classifier — "Key limit exceeded (total limit)" is a 429
  // throttle that clears, but for days it was matched as a permanent spend cap
  // and killed runs instantly with no retry and no model fallback. The usage log
  // settled it: that error first fired at $1.51 of lifetime spend on the key, and
  // the same key then went on to spend $5.87 more. A real cap does not do that.
  if (status) {
    // Credentials and authorization genuinely repeat identically — fail fast.
    if (status === 401 || status === 403) return false;
    // 402 is OpenRouter's out-of-credit status. That is the real "ran out".
    if (status === 402) return false;
    if (status === 429) return true; // rate limit / key throttle — always retry
    if (status >= 500) return true;
  }
  // Never retry these, even though some contain retryable-looking words.
  // NOTE: "key limit exceeded" is deliberately NOT here — see above. Retrying it
  // is free when it is real (a rejected call bills $0 and logs 0 tokens), and it
  // rescues the run when it is a throttle, which is what it usually is.
  if (/insufficient credit|quota exceeded|daily spend cap|not allowed|invalid api key|unauthorized|no auth credentials/i.test(e)) {
    return false;
  }
  // Statusless fallback: the phrase alone, when we never saw a status code.
  if (/key limit exceeded/i.test(e)) return true;
  return /timed out|timeout|rate.?limit|overloaded|temporar|capacity|try again|provider returned error|no endpoints|no allowed providers|internal server error|service unavailable|bad gateway|gateway time|fetch failed|connection|socket|stream|econnreset|429|500|502|503|504|520|522|524|529/i
    .test(e);
}

// ── Is the key throttled, or actually spent? ─────────────────────────────────
// "Key limit exceeded (total limit)" is emitted for BOTH, and the text is
// identical in both cases, so neither the prose nor the 429 status can tell them
// apart. Getting it wrong is expensive in both directions, and we have now been
// bitten each way on the same error string:
//
//   • Read as permanent when it was a throttle (key at $1.51 of $12): runs died
//     in ~0.3s with no retry and no fallback, for five days.
//   • Read as transient when the key was genuinely spent ($12.12 of $12): one
//     run retried a dead key for 8h 45m across 45 messages before giving up,
//     then told the reader to "Retry" — which could only fail the same way.
//
// So stop inferring it. OpenRouter reports the answer as a number on
// GET /api/v1/key, and `limit_remaining <= 0` is authoritative: the key is spent
// and every subsequent call fails identically until a human raises the limit.
// Anything else (no limit set, balance left, or the probe itself failing) keeps
// the retry behaviour — an unreachable probe must never manufacture a hard stop.
const KEY_URL = "https://openrouter.ai/api/v1/key";

function looksLikeKeyLimit(err: string, status?: number): boolean {
  return status === 429 || /key limit exceeded|rate.?limit/i.test(err || "");
}

// Only a `true` is cached, and deliberately so. A spent key cannot become
// unspent mid-run, so that answer is final and worth reusing — but the reverse
// is not true, and caching a `false` would have missed the very run this fix is
// for: it had credit at 15:58, ran out at 16:04, and kept going for 8h45m. The
// probe only ever fires on a key-limit error, so re-asking costs nothing real.
let keySpentCache: boolean | null = null;

async function isKeyExhausted(key: string): Promise<boolean> {
  if (keySpentCache === true) return true;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5_000);
    const r = await fetch(KEY_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: ctl.signal,
    }).finally(() => clearTimeout(t));
    if (!r.ok) return false; // can't tell → keep retrying, don't invent a cap
    const d = await r.json().catch(() => null);
    const limit = d?.data?.limit;
    const left = d?.data?.limit_remaining;
    // No limit configured on the key → it can never be "exhausted" this way.
    if (limit == null || left == null) return false;
    const spent = Number(left) <= 0;
    if (spent) keySpentCache = true; // final — a spent key never refills mid-run
    return spent;
  } catch {
    return false; // network/abort → unknown, so stay retryable
  }
}

function keyExhaustedMessage(): string {
  return "OpenRouter key is out of credit — it has spent its entire configured limit, " +
    "so every model call is rejected before it runs. Retrying cannot fix this: raise or " +
    "reset the key's limit at https://openrouter.ai/settings/keys (or set a new " +
    "OPENROUTER_API_KEY in Supabase edge secrets), then Retry this run.";
}


// Persist transcript mid-run so History shows progress and auto-continue can resume.
// Never overwrites a user-cancelled run (status=cancelled) with running/success/error.
// Returns { cancelled } so a caller can detect a Stop for free (no separate read):
// a non-cancel patch that updates 0 rows means the row is no longer "running" —
// the status=neq.cancelled filter excluded it (Stop) or the row was deleted.
// `&select=id` keeps the returned payload tiny (never the big messages/output).
async function checkpointRun(
  runId: string | null,
  patch: Record<string, unknown>,
): Promise<{ cancelled: boolean }> {
  if (!runId) return { cancelled: false };
  const id = encodeURIComponent(runId);
  const isCancelPatch = patch.status === "cancelled";
  // Cancelling always wins; other patches only apply while not cancelled.
  const filter = isCancelPatch
    ? `routiner_runs?id=eq.${id}&select=id`
    : `routiner_runs?id=eq.${id}&status=neq.cancelled&select=id`;
  try {
    const res = await fetch(rest(filter), {
      method: "PATCH", headers: { ...H(), Prefer: "return=representation" },
      body: JSON.stringify({ ...patch, fired_at: new Date().toISOString() }),
      // A checkpoint carries the whole transcript and runs after every tool
      // batch — and one now runs before each model retry, where a stall would
      // swallow the retry itself. The function already fails open on error, so
      // a bounded write degrades to exactly that instead of costing a segment.
      signal: AbortSignal.timeout(CHECKPOINT_TIMEOUT_MS),
    });
    if (isCancelPatch) return { cancelled: true };
    // Fail open on any transport/HTTP error — don't stop a live run on a blip;
    // the explicit isRunCancelled checks still catch a real cancel.
    if (!res.ok) return { cancelled: false };
    const rows = await res.json().catch(() => null);
    if (!Array.isArray(rows)) return { cancelled: false };
    return { cancelled: rows.length === 0 };
  } catch {
    return { cancelled: false };
  }
}

async function getRunStatus(runId: string | null): Promise<string | null> {
  if (!runId) return null;
  try {
    const rows = await sbGet(
      `routiner_runs?id=eq.${encodeURIComponent(runId)}&select=status&limit=1`,
    );
    return rows?.[0]?.status ? String(rows[0].status) : null;
  } catch {
    return null;
  }
}

async function isRunCancelled(runId: string | null): Promise<boolean> {
  const s = await getRunStatus(runId);
  return s === "cancelled";
}

// Spawn another openrouter-agent invocation on the same run (service role).
// Uses EdgeRuntime.waitUntil when available so work continues after we respond.
// `noProgress` is the consecutive no-progress streak (carried in the POST body
// like continueDepth — no DB state needed).
function scheduleAutoContinue(runId: string, depth: number, noProgress = 0): boolean {
  if (!SB_URL || !SB_KEY || !runId) return false;
  if (depth >= MAX_AUTO_CONTINUES) return false;
  const url = `${SB_URL}/functions/v1/openrouter-agent`;
  const work = fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: SB_KEY,
      authorization: `Bearer ${SB_KEY}`,
    },
    body: JSON.stringify({
      runId,
      prompt: AUTO_CONTINUE_PROMPT,
      autoContinue: true,
      continueDepth: depth + 1,
      noProgress,
    }),
  }).then(async (r) => {
    const t = await r.text().catch(() => "");
    if (!r.ok) console.error("auto-continue failed", r.status, t.slice(0, 200));
  }).catch((e) => console.error("auto-continue error", e));

  const ER = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (ER && typeof ER.waitUntil === "function") {
    ER.waitUntil(work);
  }
  // If waitUntil is missing, still fire-and-forget (best effort on this platform).
  return true;
}

// A segment made progress if tools actually ran OR the model produced real text
// (not a budget-stop / "Paused on step…" / empty). GLM empty/timeout loops hit
// the no-progress path so we don't burn the full auto-continue chain.
function segmentMadeProgress(actions: string[], finalText: string): boolean {
  if (actions.length > 0) return true;
  const t = (finalText || "").trim();
  if (!t) return false;
  if (isBudgetStop(t)) return false;
  if (/^\(empty/i.test(t)) return false;
  return true;
}

// A run the model declared blocked must not auto-continue. The next segment
// would inherit the same obstacle and burn a segment failing the same way —
// which is exactly what happened when a spent key was retried for 8h45m. A
// block is a state with a named cause, so it stops the chain and says why.
/**
 * Reconcile a goal against how the run actually ended.
 *
 * The first live smoke test filed `success` while its own goal still read
 * `phase: active`, `done: []` — the model set the goal once and never touched
 * it again. On a one-segment run that is only untidy, but the goal exists to
 * carry intent ACROSS segments: a stale "nothing done yet" is read by the next
 * segment's orientation turn as work still outstanding, so the run is invited
 * to redo what it already finished. Trusting the model to keep it current is
 * what failed; the run's real outcome is the authority.
 *
 * Only the terminal transition is inferred. `done`/`remaining` are the model's
 * to describe and are never invented here.
 */
/**
 * Why a deliberate segment hand-off must be refused, or null to allow it.
 *
 * The model cannot pause on its own otherwise — replying with text ends the
 * whole run — so a segment always ended wherever the step budget happened to
 * fall, mid-task. `end_segment` lets it stop somewhere it chose. All three
 * refusals guard the same thing: that there is something to resume, and a
 * segment left to resume in.
 *
 * @param goal the run's current goal
 * @param depth this segment's auto-continue depth
 * @param toolsRun tool calls made this segment BEFORE this one
 * @returns the reason to refuse, or null
 */
function handoffRefusal(goal: RunGoal | null, depth: number, toolsRun: number, doneAtStart: number): string | null {
  // Handing off with no goal hands off amnesia: the next segment's orientation
  // would read "no goal recorded yet" and it would start over.
  if (!goal) {
    return "no goal recorded — call set_goal first, or the next segment has nothing to resume from.";
  }
  if (goal.phase !== "active") {
    return `the goal is '${goal.phase}', so there is nothing to hand off. `
      + (goal.phase === "complete"
        ? "Reply with your final summary instead."
        : "A blocked run stops rather than continuing; say what a human must do.");
  }
  // No next segment exists, so this would file the run as out-of-segments rather
  // than pausing it. Finishing badly here is still better than that.
  if (depth >= MAX_AUTO_CONTINUES) {
    return "this is the last segment — there is no next one to hand off to. "
      + "Finish what you can and reply with a summary of where things stand.";
  }
  // Without this a model could open every segment with end_segment and burn the
  // whole chain doing nothing, each segment scoring "progress" for the one tool
  // call it made — the no-progress guard's blind spot, reached by a new route.
  if (toolsRun < 1) {
    return "this segment has not done anything yet. Do some work first; "
      + "handing off an empty segment just spends one.";
  }
  // The goal is the entire hand-off. A segment that ran tools but left `done`
  // exactly as it found it is handing the next one the same starting position
  // it had, so the next segment repeats this one — which is the "set the goal
  // once and never touch it again" failure, now with a hand-off attached to it.
  if (goal.done.length <= doneAtStart) {
    return "the goal's `done` list has not changed this segment, so the next one "
      + "would resume from where this one started and repeat it. Call set_goal to "
      + "record what you finished, then end_segment.";
  }
  return null;
}

function reconcileGoal(goal: RunGoal | null, status: string): RunGoal | null {
  if (!goal) return null;
  if (status === "success" && goal.phase === "active") {
    return { ...goal, phase: "complete" };
  }
  return goal;
}

function goalBlockStop(goal: RunGoal | null, finalText = ""): string | null {
  if (!goal || goal.phase !== "blocked" || !goal.blocked_reason) return null;
  const notice = `⛔ Blocked (${goal.blocked_reason.code}): ${goal.blocked_reason.message}\n\n`
    + `Objective: ${goal.objective}\n`
    + "Auto-continue stopped — the next segment would hit the same obstacle. "
    + "Resolve the cause, then reply here to resume.";
  // Lead with the blocker, but keep what the model said underneath: it usually
  // holds the detail a human needs to clear the block, and a stop notice that
  // silently replaces it makes the run look like it produced nothing.
  const said = (finalText || "").trim();
  return said && !isBudgetStop(said) ? `${notice}\n\n---\n\n${said}` : notice;
}

function noProgressStopMessage(streak: number): string {
  return `Stopped: ${streak} consecutive segments made no progress (model timing out or returning nothing). Try a faster model (kimi-k2.7-code, deepseek-chat) or reply to retry.`;
}

// Ran out of auto-continue segments with the task still unfinished. Reported as
// an error, not a success, so History reflects what actually happened.
function exhaustedMessage(depth: number): string {
  return `⚠ Ran out of time: used all ${depth + 1} segment(s) of the auto-continue budget without finishing. Partial progress is saved — open this run and **Retry** (or reply "continue") to pick up where it stopped. If this keeps happening, narrow the task or raise AGENT_MAX_AUTO_CONTINUES.`;
}

type LoopResult = {
  finalText: string;
  actions: string[];
  cost: number;
  steps: number;
  incomplete: boolean; // true → worth auto-continuing
  openedPr: boolean;
  modelUsed: string;   // may differ from the requested model after a fallback
  goal: RunGoal | null;
};

// Run the bounded tool-use loop over `messages` (mutated in place).
/**
 * Is switching to FALLBACK_MODEL available right now?
 *
 * Shared by the two paths that reach for it: a transient model error, and an
 * `ok: true` completion carrying neither content nor tool calls. The second is
 * the same failure — the model returned nothing usable — but OpenRouter does not
 * flag it as an error, so it has to be recognised here rather than by the
 * transient classifier.
 *
 * @param activeModel the model the loop is using now
 * @param fellBack whether this run has already switched once
 * @param budgetMs milliseconds left for another model call
 * @returns true when a fallback is configured, allowed, different, and affordable
 */
function canUseFallbackModel(activeModel: string, fellBack: boolean, budgetMs: number): boolean {
  return !fellBack
    && !!FALLBACK_MODEL
    && FALLBACK_MODEL !== activeModel
    && allowedModels().has(FALLBACK_MODEL)
    && budgetMs >= MIN_MODEL_CALL_MS;
}

async function runAgentLoop(opts: {
  key: string; model: string; tools: unknown[]; messages: any[]; maxSteps?: number;
  runId?: string | null;
  depth?: number;
  runStartedAt?: string | null;
  goal?: RunGoal | null;
  ctx: { userId: string | null; account: string | null; triggerKey: string | null; enabled: Set<string> };
}): Promise<LoopResult> {
  const { key, model, tools, messages, ctx } = opts;
  const runId = opts.runId || null;
  const stepBudget = Math.max(1, opts.maxSteps || MAX_STEPS);
  const actions: string[] = [];
  let cost = 0, steps = 0, finalText = "";
  let openedPr = false;
  let prUrl = ""; // captured from the PR tool's own output — never asserted without it
  let incomplete = false;
  // The model actually used right now — may switch to FALLBACK_MODEL once if the
  // configured one is failing transiently. Reported back so History is honest.
  let activeModel = model;
  let fellBack = false;
  // Mutated by the set_goal tool, checkpointed with every other bit of progress.
  const goalRef: { current: RunGoal | null } = { current: opts.goal ?? null };
  // Set by the end_segment tool when the model chooses to hand off here.
  const handoffRef: { current: string | null } = { current: null };
  // How much the goal already claimed done when this segment began, so a
  // hand-off can require that the segment actually moved it forward.
  const doneAtSegmentStart = goalRef.current?.done.length ?? 0;
  const started = Date.now();
  const hardStop = started + DEADLINE_MS;
  const remaining = () => Math.max(0, hardStop - Date.now());
  // Reserve 8s to checkpoint + spawn auto-continue; never go below MIN_MODEL_CALL_MS
  // (a 5s model call always fails on Kimi/GLM and used to kill the chain).
  const callBudget = () => {
    const raw = remaining() - 8_000;
    if (raw < MIN_MODEL_CALL_MS) return 0;
    // Do NOT cap at CALL_TIMEOUT_MS here: slow models (Kimi/GLM) on a large
    // transcript need more than 50s, and clamping every attempt to 50s was
    // the chronic timeout that killed runs. The wall deadline bounds it.
    return raw;
  };

  // Returns true if the checkpoint revealed the run was cancelled (Stop pressed),
  // so the loop can halt with no extra DB read.
  const saveProgress = async (status: string, note: string): Promise<boolean> => {
    const recap = actions.length ? `\n\n---\n**Actions (${actions.length})**\n\n${actions.map((a) => `- ${a}`).join("\n")}` : "";
    const { cancelled } = await checkpointRun(runId, {
      status,
      output: `${note}${recap}`.slice(0, OUTPUT_CAP),
      messages,
      ...(goalRef.current ? { goal: goalRef.current } : {}),
    });
    return cancelled;
  };

  // One orientation line per segment, injected before the first model call.
  // Labelled, so it renders as a notice and never resets the repeat chain.
  {
    const runStart = opts.runStartedAt ? Date.parse(opts.runStartedAt) : NaN;
    const elapsed = Number.isFinite(runStart) ? Math.max(0, started - runStart) : 0;
    // The goal rides the same injected turn. It is re-stated every segment on
    // purpose: it is the one part of the run's intent that compaction never
    // touches, so re-reading it costs a few hundred tokens and replaces an
    // archaeology exercise over floored tool results.
    const carried = renderGoal(goalRef.current);
    // A goal carried into a later segment with nothing marked done is the
    // failure this nudge exists for: the first live run set its goal once and
    // never updated it, so a resumed segment would read "nothing done yet" and
    // be invited to redo finished work. Say so where it is actionable.
    const staleGoal = (opts.depth ?? 0) > 0
      && goalRef.current !== null
      && goalRef.current.done.length === 0;
    const upkeep = staleGoal
      ? "This goal still lists nothing as done, though a previous segment already ran. "
        + "Before doing anything else, call set_goal to move what is finished into `done` — "
        + "an out-of-date goal will have you repeat work you have already completed."
      : "Update this with set_goal as you make progress.";
    const body = carried
      ? `${segmentOrientation(opts.depth ?? 0, elapsed, DEADLINE_MS)}\n\n${carried}\n\n${upkeep}`
      : `${segmentOrientation(opts.depth ?? 0, elapsed, DEADLINE_MS)}\n\n`
        + "No goal recorded yet. Call set_goal early with the objective and your plan — it is the only part of your intent that survives into the next segment.";
    messages.push({ role: "user", content: body, _source: SRC_ORIENTATION });
  }

  for (let i = 0; i < stepBudget; i++) {
    steps = i + 1;
    const budget = callBudget();
    if (budget < MIN_MODEL_CALL_MS) {
      finalText = finalText || "Stopped: hit the time budget before a final answer.";
      incomplete = true;
      break;
    }

    const forModel = compactMessages(messages);
    // After a PR is opened, force a text-only wrap-up (no more tools).
    const useTools = openedPr ? [] : tools;
    const r = await openrouter(key, activeModel, forModel, {
      tools: useTools.length ? useTools : undefined,
      timeoutMs: budget,
      retries: MODEL_RETRIES,
      deadlineAt: hardStop,
      onRetry: async ({ attempt, retries, delayMs, error }) => {
        await saveProgress(
          "running",
          `Retrying step ${steps} in ${Math.round(delayMs / 1000)}s (attempt ${attempt}/${retries}) after: ${error.slice(0, 160)}`,
        );
      },
    });
    cost += Number(r.usage?.cost) || 0;
    await logUsage(activeModel, r.usage, ctx.account, ctx.triggerKey, r.ok, r.error ?? null);
    if (!r.ok) {
      const err = String(r.error || "unknown");
      // Retries inside openrouter() are already spent by here. If the chosen
      // model is the thing that's broken, finish the job on a reliable one
      // instead of ending the run — the user cares about the task, not the model.
      // The fallback model runs on the SAME key, so a spent key makes it futile:
      // switching models here just spends another step to fail identically.
      const canFallBack = !r.exhausted && isTransientModelError(err, r.status)
        && canUseFallbackModel(activeModel, fellBack, callBudget());
      if (canFallBack) {
        fellBack = true;
        actions.push(`model fallback: ${activeModel} → ${FALLBACK_MODEL} after "${err.slice(0, 120)}"`);
        activeModel = FALLBACK_MODEL;
        continue; // costs one step; far cheaper than losing the run
      }
      if (r.exhausted) {
        // Hard stop. A soft stop would auto-continue and invite a Retry, and both
        // can only fail the same way until a human raises the key's limit.
        finalText = `⚠ Run stopped on step ${steps}: ${err}`;
        incomplete = false;
      } else if (isTransientModelError(err, r.status)) {
        // Soft stop — checkpoint + auto-continue (do not mark as hard failure).
        finalText = `Paused on step ${steps}: ${err}. Continuing in the background if possible.`;
        incomplete = true;
      } else {
        finalText = `⚠ Model error on step ${steps}: ${err}`;
        incomplete = false;
      }
      break;
    }

    // Honour Stop: user (or UI) flipped the row to cancelled mid-loop.
    if (await isRunCancelled(runId)) {
      finalText = "⏹ Stopped by you. Partial progress is saved — Retry to resume.";
      incomplete = false;
      break;
    }

    const msg = r.message || {};
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!toolCalls.length || openedPr) {
      finalText = (msg.content || "").toString().trim() || (openedPr ? `Opened a pull request: ${prUrl}` : "");
      // An ok:true response with neither content nor tool calls is the model
      // returning nothing — the same class of failure as a transient error,
      // but it arrives unflagged. Accepting it ends the segment empty, which
      // counts as no-progress; two in a row kill the run. Fall back once,
      // exactly as the error path above does, before giving up on the model.
      if (!finalText && !openedPr
          && canUseFallbackModel(activeModel, fellBack, callBudget())) {
        fellBack = true;
        actions.push(`model fallback: ${activeModel} → ${FALLBACK_MODEL} after empty completion`);
        activeModel = FALLBACK_MODEL;
        continue; // costs one step; far cheaper than losing the run
      }
      messages.push(assistantTurn({ ...msg, content: msg.content || finalText }));
      incomplete = false;
      break;
    }

    messages.push(assistantTurn(msg, toolCalls));
    for (const tc of toolCalls) {
      const toolBudget = callBudget();
      if (toolBudget < 5_000) {
        finalText = finalText || "Stopped: hit the time budget mid-tools; partial progress is in the transcript.";
        incomplete = true;
        break;
      }
      const name = tc?.function?.name || "";
      let args: Record<string, any> = {};
      try { args = JSON.parse(tc?.function?.arguments || "{}"); } catch { /* leave empty */ }
      const raw = await runTool(name, args, {
        userId: ctx.userId, key, account: ctx.account, triggerKey: ctx.triggerKey, enabled: ctx.enabled, runId,
        timeoutMs: toolBudget, goalRef, handoffRef, doneAtSegmentStart,
        segmentDepth: opts.depth ?? 0,
        // Tool calls already made this segment. end_segment reads this to refuse
        // a hand-off from a segment that has not done anything yet.
        toolsRunThisSegment: actions.length,
      });
      // Spill before truncating: store the whole thing and hand the model a
      // preview plus a locator, so an oversized result becomes a fetch rather
      // than a loss. read_spill is excluded — spilling a spill read would loop.
      let result = raw;
      if (name !== "read_spill") {
        const spilled = await spillResult(raw, name, args, { userId: ctx.userId, runId });
        if (spilled !== null) result = spilled;
      }
      // Fallback cap for anything not spilled (a spill insert can fail, and it
      // must never fail the tool call). File reads keep the higher ceiling.
      const cap = name === "gh_read_file" ? GH_READ_RESULT_CAP : TOOL_RESULT_CAP;
      if (Array.from(result).length > cap) {
        // Head AND tail, by code point, for the same two reasons the compaction
        // floor keeps both: for these tools the answer often sits at the end (an
        // error line appended after a successful-looking preamble, the last
        // entries of a listing), and a UTF-16 slice can emit a lone surrogate.
        const head = Math.floor(cap * 0.7);
        result = headTail(result, head, cap - head, "dropped — the spill write failed, so this text is gone")
          + `\n[For files, re-call gh_read_file with start_line/max_lines to page.]`;
      }
      const line = `${name}(${JSON.stringify(args).slice(0, 200)}) → ${result.split("\n")[0].slice(0, 120)}`;
      actions.push(line);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      const pr = detectOpenedPr(name, result);
      if (pr.opened) { openedPr = true; prUrl = pr.url; }
    }
    // A deliberate hand-off ends the segment here rather than at whatever step
    // the budget ran out on. `incomplete` is what schedules the next segment, so
    // this is a pause, not a finish — the guards in handoffRefusal have already
    // established that a next segment exists and has a goal to resume from.
    // …except when this batch opened a PR. That path owes the reader a summary
    // and the next iteration is already set up to write one with tools off;
    // pausing instead would carry a finished piece of work into another segment
    // that no longer knows it happened.
    if (handoffRef.current && !openedPr) {
      finalText = `Handed off to the next segment: ${handoffRef.current}`;
      incomplete = true;
      await saveProgress("running", finalText);
      break;
    }
    // Advisory only, and after the results so the model sees what it just got
    // back before being told to stop asking for it again.
    const nudge = repeatReminder(messages);
    if (nudge) {
      messages.push({ role: "user", content: nudge.text, _source: SRC_REPEAT_GUARD });
      actions.push(`repeat-guard: ${nudge.tool} called ${nudge.count}× with identical arguments`);
    }
    // Checkpoint after every tool batch so History stays live — and reuse its
    // result to honour a Stop pressed mid-batch, with no extra DB round-trip.
    const cancelledMidBatch = await saveProgress(
      "running",
      openedPr
        ? "Working… pull request opened; writing summary…"
        : `Working… step ${steps}/${stepBudget}`,
    );
    if (cancelledMidBatch) {
      finalText = "⏹ Stopped by you. Partial progress is saved — Retry to resume.";
      incomplete = false;
      break;
    }

    if (openedPr) {
      // Next loop iteration will call the model with tools disabled for a final summary.
      continue;
    }
    if (finalText || callBudget() < MIN_MODEL_CALL_MS) {
      if (!finalText) {
        finalText = "Stopped: hit the time budget before a final answer.";
        incomplete = true;
      }
      break;
    }
  }

  if (!finalText) {
    finalText = "Stopped after the maximum number of tool steps without a final answer.";
    incomplete = !openedPr;
  }
  // Budget / step stops are incomplete unless we already landed a PR and summary.
  if (isBudgetStop(finalText) && !openedPr) incomplete = true;
  if (openedPr && isBudgetStop(finalText)) {
    finalText = `Opened a pull request: ${prUrl} — the model ran out of budget before writing a summary.`;
    incomplete = false;
  }
  if (isHardError(finalText)) incomplete = false;
  // Final cancel check so we never auto-continue a stopped run.
  if (await isRunCancelled(runId)) {
    finalText = "⏹ Stopped by you. Partial progress is saved — Retry to resume.";
    incomplete = false;
  }

  return { finalText, actions, cost, steps, incomplete, openedPr, modelUsed: activeModel, goal: goalRef.current };
}

async function insertRunningRun(row: Record<string, unknown>): Promise<string | null> {
  const ins = await fetch(rest("routiner_runs"), {
    method: "POST", headers: { ...H(), Prefer: "return=representation" },
    body: JSON.stringify(row),
  }).catch(() => null);
  if (!ins || !ins.ok) return null;
  const rows = await ins.json().catch(() => []);
  return rows?.[0]?.id || null;
}

// ── Handler ─────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  try {
    return await handleRequest(req);
  } catch (e) {
    // Uncaught throws become empty gateway 502s; always return JSON for the scheduler.
    return json({ ok: false, error: `Agent crashed: ${(e as Error).message || String(e)}` }, 500);
  }
});

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);

  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* empty ok */ }

  // Never leave tokens in anything we might echo later.
  const accessTokenForAuth = body.accessToken ?? body.access_token;
  delete body.accessToken;
  delete body.access_token;

  const auth = await authorizeCaller(req, { accessToken: accessTokenForAuth });
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);

  const allow = allowedModels();
  const runId = typeof body.runId === "string" ? body.runId.trim()
              : (typeof body.run_id === "string" ? body.run_id.trim() : "");

  const continueDepth = Math.max(0, Number(body.continueDepth) || 0);
  // Consecutive no-progress streak for auto-continue (human replies start at 0).
  const noProgressIn = Math.max(0, Number(body.noProgress) || 0);
  const isAutoContinue = body.autoContinue === true;

  // ── Continuation / stop: reopen a stored run ──
  // Human reply: { runId, prompt }. Auto-continue: { runId, prompt, autoContinue, continueDepth, noProgress }.
  // Stop: { runId, action: "stop" } — flips status to cancelled so the live loop + chain halt.
  if (runId) {
    const wantStop = body.action === "stop" || body.stop === true;
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!wantStop && !prompt.trim() && !isAutoContinue) {
      return json({ ok: false, error: "Missing 'prompt' (the follow-up message)." }, 400);
    }

    let row: any = null;
    try {
      const rows = await sbGet(`routiner_runs?id=eq.${encodeURIComponent(runId)}&select=id,user_id,routine_id,title,status,output,messages,model,account,trigger_key,tools,started_at,goal&limit=1`);
      row = rows?.[0] || null;
    } catch (e) { return json({ ok: false, error: `Could not load the run: ${(e as Error).message}` }, 502); }
    if (!row) return json({ ok: false, error: "Run not found." }, 404);

    // Signed-in callers may only continue their own runs (service/secret may continue any).
    if (auth.via === "user-jwt" && auth.userId && row.user_id && row.user_id !== auth.userId) {
      return json({ ok: false, error: "Unauthorized — that run belongs to another user." }, 403);
    }

    if (wantStop) {
      const stopMsg = "⏹ Stopped by you. Partial progress is saved — Retry to resume.";
      const prev = String(row.output || "");
      const output = (stopMsg + (prev && !prev.startsWith("⏹") ? "\n\n" + prev : "")).slice(0, OUTPUT_CAP);
      // Unconditional cancel (even if already error/success — idempotent enough).
      await fetch(rest(`routiner_runs?id=eq.${encodeURIComponent(runId)}`), {
        method: "PATCH", headers: { ...H(), Prefer: "return=minimal" },
        body: JSON.stringify({
          status: "cancelled",
          output,
          fired_at: new Date().toISOString(),
        }),
      }).catch(() => {});
      return json({ ok: true, runId, stopped: true, status: "cancelled", output });
    }

    // Already stopped — don't resurrect via auto-continue (human Retry still works with a prompt).
    if (isAutoContinue && row.status === "cancelled") {
      return json({
        ok: true, runId, stopped: true, status: "cancelled",
        output: row.output || "⏹ Stopped by you.",
        continuing: false,
      });
    }

    const userId = row.user_id || auth.userId || null;
    const account = typeof row.account === "string" ? row.account : null;
    const triggerKey = typeof row.trigger_key === "string" ? row.trigger_key : null;
    let model = typeof row.model === "string" && row.model.trim() ? row.model.trim() : DEFAULT_MODEL;
    if (!allow.has(model)) model = DEFAULT_MODEL;
    const enabled = new Set<string>(
      Array.isArray(row.tools) && row.tools.length ? row.tools.filter((t: unknown) => typeof t === "string") : ["read", "research", "write"],
    );
    const tools = toolSpecs(enabled);
    const toolList = enabled.size ? [...enabled].join(", ") : "none";

    const override = await accountKeyOverride(userId, account || undefined);
    const serverKey = Deno.env.get("OPENROUTER_API_KEY") || "";
    const key = override || serverKey;
    const keySource = override ? "account" : "server";
    if (!key) return json({ ok: false, error: "No OpenRouter key available to continue this run." }, 500);

    const capRaw = Deno.env.get("MAX_DAILY_SPEND");
    const cap = capRaw ? Number(capRaw) : 0;
    if (cap > 0) { const spent = await todaySpend(); if (spent != null && spent >= cap) return json({ ok: false, error: `Daily spend cap reached ($${spent.toFixed(4)} of $${cap.toFixed(2)}).` }, 429); }

    let messages: any[] = Array.isArray(row.messages) && row.messages.length ? row.messages.slice() : [];
    if (!messages.length) {
      messages = [{ role: "system", content: buildSystem(model, toolList) }];
      if (row.output) messages.push({ role: "assistant", content: String(row.output) });
    } else if (messages[0]?.role !== "system") {
      messages.unshift({ role: "system", content: buildSystem(model, toolList) });
    } else {
      // Refresh system prompt so efficiency rules apply to old transcripts.
      messages[0] = { role: "system", content: buildSystem(model, toolList) };
    }
    // The auto-continue POST carries AUTO_CONTINUE_PROMPT in its own `prompt`
    // field, so "is the prompt empty?" can never tell a machine nudge from a
    // human reply — it labelled neither, and isHumanTurn then read every
    // segment boundary as a human interjection, resetting the repeat chain at
    // exactly the boundary it exists to survive. The body's autoContinue flag
    // is the only authority on who is speaking.
    const humanPrompt = prompt.trim();
    messages.push(isAutoContinue
      ? { role: "user", content: humanPrompt || AUTO_CONTINUE_PROMPT, _source: SRC_AUTO_CONTINUE }
      : { role: "user", content: humanPrompt });

    await checkpointRun(runId, { status: "running", output: isAutoContinue ? `Continuing… (segment ${continueDepth + 1})` : "Working…" });

    const loop = await runAgentLoop({
      key, model, tools, messages, maxSteps: stepBudgetFor(enabled), runId,
      depth: continueDepth, runStartedAt: row.started_at ?? null, goal: parseStoredGoal(row.goal),
      ctx: { userId, account, triggerKey, enabled },
    });
    let { finalText, actions, cost, steps, incomplete, openedPr, modelUsed, goal } = loop;
    const recap = actions.length ? `\n\n---\n**Actions (${actions.length})**\n\n${actions.map((a) => `- ${a}`).join("\n")}` : "";

    // Progress streak: human follow-ups reset; auto-continue carries noProgressIn.
    const baseStreak = isAutoContinue ? noProgressIn : 0;
    const nextNoProgress = segmentMadeProgress(actions, finalText) ? 0 : baseStreak + 1;

    const wasCancelled = /Stopped by you/i.test(finalText) || (await isRunCancelled(runId));

    let continuing = false;
    let noProgressStop = false;
    const blockStop = goalBlockStop(goal, finalText);
    if (blockStop) {
      finalText = blockStop;
      incomplete = false;
    }
    if (!wasCancelled && incomplete && !isHardError(finalText)) {
      if (nextNoProgress >= MAX_NO_PROGRESS) {
        noProgressStop = true;
        finalText = noProgressStopMessage(nextNoProgress);
      } else {
        continuing = scheduleAutoContinue(runId, continueDepth, nextNoProgress);
      }
    }
    // Out of segments with the task unfinished. This used to be filed as
    // "success", so History showed green on runs that did nothing.
    const exhausted = !wasCancelled && incomplete && !continuing && !noProgressStop && !isHardError(finalText);
    if (exhausted) finalText = `${finalText}\n\n${exhaustedMessage(continueDepth)}`;

    const status = wasCancelled
      ? "cancelled"
      : (isHardError(finalText) || noProgressStop || exhausted || blockStop) ? "error" : (continuing ? "running" : "success");
    const note = continuing
      ? `${finalText}\n\n_Still working in the background (auto-continue ${continueDepth + 1}/${MAX_AUTO_CONTINUES})…_`
      : finalText;
    const output = `${note}${recap}`.slice(0, OUTPUT_CAP);

    const finalGoal = reconcileGoal(goal, status);
    await checkpointRun(runId, { status, output, messages, model: modelUsed, ...(finalGoal ? { goal: finalGoal } : {}) });

    return json({
      ok: true, runId, output, steps, cost: Number(cost.toFixed(6)), model: modelUsed, keySource,
      continuing, openedPr, continueDepth, noProgress: nextNoProgress,
      stopped: wasCancelled,
    });
  }

  // ── Fresh run ──
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : DEFAULT_MODEL;
  if (!allow.has(model)) return json({ ok: false, error: `Model "${model}" is not allowed. Allowed: ${[...allow].join(", ")}.` }, 400);

  const account = typeof body.account === "string" ? body.account : null;
  const triggerKey = typeof body.triggerKey === "string" ? body.triggerKey : (typeof body.trigger_key === "string" ? body.trigger_key : null);
  const routineId = typeof body.routineId === "string" ? body.routineId : (typeof body.routine_id === "string" ? body.routine_id : "");

  const fromRoutine = await resolveOwner(routineId);
  const userId = auth.userId || fromRoutine.userId;
  const routineTitle = fromRoutine.title;
  const override = await accountKeyOverride(userId, account || undefined);
  const serverKey = Deno.env.get("OPENROUTER_API_KEY") || "";
  const key = override || serverKey;
  const keySource = override ? "account" : "server";
  if (!key) return json({ ok: false, error: "No OpenRouter key: set OPENROUTER_API_KEY (edge secret) or paste a key on the account." }, 500);

  if (body.ping) {
    const r = await openrouter(key, model, [{ role: "user", content: "ping" }], { maxTokens: 1 });
    await logUsage(model, r.usage, account, triggerKey, r.ok, r.error ?? null);
    return r.ok ? json({ ok: true, keySource, model }) : json({ ok: false, error: r.error }, 502);
  }

  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) return json({ ok: false, error: "Missing 'prompt'." }, 400);

  const capRaw = Deno.env.get("MAX_DAILY_SPEND");
  const cap = capRaw ? Number(capRaw) : 0;
  if (cap > 0) {
    const spent = await todaySpend();
    if (spent != null && spent >= cap) return json({ ok: false, error: `Daily spend cap reached ($${spent.toFixed(4)} of $${cap.toFixed(2)}).` }, 429);
  }

  const enabled = new Set<string>(
    Array.isArray(body.tools) ? body.tools.filter((t: unknown) => typeof t === "string") : ["read", "research", "write"],
  );
  const tools = toolSpecs(enabled);
  const toolList = enabled.size ? [...enabled].join(", ") : "none";
  const title = (typeof body.title === "string" && body.title.trim()) ? body.title.trim() : (routineTitle || `${model} run`);

  const messages: any[] = [{ role: "system", content: buildSystem(model, toolList) }, { role: "user", content: prompt }];

  // Insert the run *before* the loop so History shows "running" and auto-continue can resume.
  let newRunId: string | null = null;
  if (userId) {
    newRunId = await insertRunningRun({
      user_id: userId,
      routine_id: routineId || null,
      title,
      status: "running",
      output: "Working…",
      messages,
      model,
      account,
      trigger_key: triggerKey,
      tools: [...enabled],
    });
  }

  const loop = await runAgentLoop({
    key, model, tools, messages, maxSteps: stepBudgetFor(enabled), runId: newRunId,
    depth: 0, runStartedAt: null,
    ctx: { userId, account, triggerKey, enabled },
  });
  let { finalText, actions, cost, steps, incomplete, openedPr, modelUsed, goal } = loop;

  const recap = actions.length ? `\n\n---\n**Actions (${actions.length})**\n\n${actions.map((a) => `- ${a}`).join("\n")}` : "";

  // Fresh run: streak starts at 0; no progress → 1 and may continue once more.
  const nextNoProgress = segmentMadeProgress(actions, finalText) ? 0 : 1;
  const wasCancelled = /Stopped by you/i.test(finalText) || (newRunId ? await isRunCancelled(newRunId) : false);

  let continuing = false;
  let noProgressStop = false;
  const blockStop = goalBlockStop(goal, finalText);
  if (blockStop) {
    finalText = blockStop;
    incomplete = false;
  }
  if (newRunId && !wasCancelled && incomplete && !isHardError(finalText)) {
    if (nextNoProgress >= MAX_NO_PROGRESS) {
      noProgressStop = true;
      finalText = noProgressStopMessage(nextNoProgress);
    } else {
      continuing = scheduleAutoContinue(newRunId, 0, nextNoProgress);
    }
  }
  const exhausted = !wasCancelled && incomplete && !continuing && !noProgressStop && !isHardError(finalText);
  if (exhausted) finalText = `${finalText}\n\n${exhaustedMessage(0)}`;

  const status = wasCancelled
    ? "cancelled"
    : (isHardError(finalText) || noProgressStop || exhausted || blockStop) ? "error" : (continuing ? "running" : "success");
  const note = continuing
    ? `${finalText}\n\n_Still working in the background (auto-continue 1/${MAX_AUTO_CONTINUES})…_`
    : finalText;
  const output = `${note}${recap}`.slice(0, OUTPUT_CAP);

  if (newRunId) {
    const finalGoal = reconcileGoal(goal, status);
    await checkpointRun(newRunId, { status, output, messages, model: modelUsed, ...(finalGoal ? { goal: finalGoal } : {}) });
  } else if (userId) {
    // Fallback: no early id (insert failed) — try one final insert.
    newRunId = await insertRunningRun({
      user_id: userId, routine_id: routineId || null, title, status, output,
      messages, model: modelUsed, account, trigger_key: triggerKey, tools: [...enabled],
    });
  }

  return json({
    ok: true, runId: newRunId, output, steps, cost: Number(cost.toFixed(6)), model: modelUsed, keySource,
    continuing, openedPr, continueDepth: 0, noProgress: nextNoProgress,
    stopped: wasCancelled,
  });
}
