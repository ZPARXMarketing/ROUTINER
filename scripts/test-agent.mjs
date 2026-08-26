// Tests for the openrouter-agent reliability logic.
//
//   node --experimental-strip-types scripts/test-agent.mjs
//
// There is no Deno in CI or in a routine session, so this loads the edge
// function under a stubbed Deno global and exercises its pure helpers in Node.
// Importing it at all is also a syntax check on the whole function.
//
// These cover the parts that decide whether a run finishes or dies: which model
// errors are retried, how tool output is kept inside the context budget, how
// find/replace edits are applied, and the write-path guards that must not
// regress. If you change any of those, run this before opening a PR.
import { readFileSync, writeFileSync } from "node:fs";

const SRC = new URL("../supabase/functions/openrouter-agent/index.ts", import.meta.url).pathname;
let src = readFileSync(SRC, "utf8");
src = src.replace(/^import "jsr:.*$/m, "// jsr import stripped");
// Export the pure helpers we want to test.
src += `
export { compactMessages, applyEdits, isTransientModelError, isHardError, isBudgetStop,
         normalizeAgentBranch, deniedWritePath, segmentMadeProgress, resolveReasoning,
         parseReasoningEffort, exhaustedMessage, detectOpenedPr,
         looksLikeKeyLimit, isKeyExhausted,
         repeatKey, repeatChainCount, repeatReminder, isHumanTurn, headTail,
         toolBudgetFor, segmentOrientation, TOOL_BUDGET_MS };
export function __resetKeyCache() { keySpentCache = null; }
`;
const OUT = `${process.env.TMPDIR || "/tmp"}/agent_under_test.ts`;
writeFileSync(OUT, src);

globalThis.Deno = {
  env: { get: () => undefined },
  serve: () => {},
};

const m = await import(OUT);

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};

console.log("\n— isTransientModelError (retry classification) —");
for (const s of [
  "Provider returned error",
  "OpenRouter call timed out (50000ms)",
  "upstream 503 service unavailable",
  "Rate limit exceeded",
  "fetch failed",
  "Internal Server Error",
]) eq(`transient: ${s}`, m.isTransientModelError(s), true);
for (const s of [
  "Invalid API key",
  'Model "foo/bar" is not allowed.',
  "Daily spend cap reached ($5.00 of $5.00).",
  "Insufficient credits to run this request.",
]) eq(`permanent: ${s.slice(0, 34)}`, m.isTransientModelError(s), false);

// A 429 that says "Key limit exceeded" is a throttle that clears, NOT a spend
// cap. Classifying it permanent stopped every retry and every model fallback,
// and killed agent runs in ~0.3s. The usage log disproved the "cap" reading:
// the error first fired at $1.51 of lifetime spend on the key, and that same
// key then spent $5.87 more afterwards. Do not re-add it to the deny-list.
const KEY_LIMIT =
  "Key limit exceeded (total limit). Manage it using https://openrouter.ai/...";
eq("key-limit 429 is transient", m.isTransientModelError(KEY_LIMIT, 429), true);
eq("key-limit statusless is transient", m.isTransientModelError(KEY_LIMIT), true);
eq("402 out-of-credit stays permanent", m.isTransientModelError("Insufficient credits", 402), false);
eq("401 stays permanent", m.isTransientModelError("No auth credentials found", 401), false);
eq("403 stays permanent", m.isTransientModelError("Forbidden", 403), false);

// Status beats body prose in both directions.
eq("429 beats permanent-looking prose", m.isTransientModelError("quota exceeded", 429), true);
eq("503 is transient on any prose", m.isTransientModelError("something odd", 503), true);
eq("402 beats transient-looking prose", m.isTransientModelError("try again later", 402), false);
// A local cap is ours, not OpenRouter's, and carries no status — still permanent.
eq("local daily cap permanent", m.isTransientModelError("Daily spend cap reached ($5.00 of $5.00)."), false);

// ── Throttled key vs spent key ───────────────────────────────────────────────
// Both emit the SAME "Key limit exceeded (total limit)" text, so the string
// cannot decide it and neither can the 429. We were burned in both directions
// on this exact message: read as permanent while the key still had $10.49 left
// (runs died in 0.3s for five days), then read as transient once the key was
// truly spent at $12.12 of $12 (one run retried a dead key for 8h45m across 45
// messages). The only honest signal is OpenRouter's own limit_remaining.
console.log("\n— key exhaustion (throttle vs spent) —");
eq("429 looks like a key limit", m.looksLikeKeyLimit("anything", 429), true);
eq("key-limit prose matches statusless", m.looksLikeKeyLimit(KEY_LIMIT), true);
eq("an unrelated 500 does not", m.looksLikeKeyLimit("Provider returned error", 500), false);

const withKeyApi = async (payload, { ok = true } = {}) => {
  m.__resetKeyCache();
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok, json: async () => payload });
  try { return await m.isKeyExhausted("sk-test"); }
  finally { globalThis.fetch = real; }
};

eq("spent key (0 left) is exhausted",
  await withKeyApi({ data: { limit: 12, limit_remaining: 0 } }), true);
eq("overspent key is exhausted",
  await withKeyApi({ data: { limit: 12, limit_remaining: -0.13 } }), true);
eq("throttled key with credit left is NOT exhausted",
  await withKeyApi({ data: { limit: 12, limit_remaining: 10.49 } }), false);
// A key with no limit set can never be exhausted this way — it must stay retryable.
eq("unlimited key is not exhausted",
  await withKeyApi({ data: { limit: null, limit_remaining: null } }), false);
// The probe must never manufacture a hard stop when it cannot answer: an
// unreachable balance endpoint has to leave the error retryable, or a blip in
// OpenRouter's API would start killing otherwise-healthy runs.
eq("probe HTTP error stays retryable", await withKeyApi({}, { ok: false }), false);
eq("probe garbage response stays retryable", await withKeyApi({ data: {} }), false);
{
  m.__resetKeyCache();
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  eq("probe network failure stays retryable", await m.isKeyExhausted("sk-test"), false);
  globalThis.fetch = real;
}

// A "no" must never be cached. The run this fix exists for had credit at 15:58
// and was spent by 16:04 — caching the first answer would have missed it and
// let the run retry a dead key for another eight hours.
{
  m.__resetKeyCache();
  const real = globalThis.fetch;
  let left = 10.49;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { limit: 12, limit_remaining: left } }) });
  eq("has credit → not exhausted", await m.isKeyExhausted("sk-test"), false);
  left = 0;
  eq("runs out mid-run → still detected", await m.isKeyExhausted("sk-test"), true);
  globalThis.fetch = async () => { throw new Error("must not be called"); };
  eq("a spent key is cached, not re-probed", await m.isKeyExhausted("sk-test"), true);
  globalThis.fetch = real;
}

console.log("\n— compactMessages (context budget) —");
const big = (n) => "x".repeat(n);
const msgs = [
  { role: "system", content: "sys" },
  { role: "tool", content: big(50_000) }, // oldest
  { role: "assistant", content: "a" },
  { role: "tool", content: big(50_000) },
  { role: "tool", content: big(50_000) }, // newest
];
const out = m.compactMessages(msgs, 60_000);
const toolLens = out.filter((x) => x.role === "tool").map((x) => x.content.length);
const FLOORED = 400 + "\n…[truncated for context]…\n".length;
eq("newest kept full, older floored", toolLens, [FLOORED, FLOORED, 50_000]);
eq("total tool chars under control", toolLens.reduce((a, b) => a + b, 0) <= 61_000, true);
eq("input not mutated", msgs[1].content.length, 50_000);
eq("non-tool untouched", out[0].content, "sys");
const small = [{ role: "tool", content: "tiny" }, { role: "tool", content: big(70_000) }];
eq("small results never truncated", m.compactMessages(small, 10)[0].content, "tiny");
eq("zero budget floors big ones", m.compactMessages(small, 0)[1].content.length, FLOORED);

// The floor keeps a TAIL, not just a head. For every GitHub tool here the answer
// tends to sit at the end (gh_read_pr patches, a trailing error line), and
// head-only flooring discarded exactly that — sending the model back to re-read
// the same file, which is the loop the repeat guard below then has to catch.
const marked = `HEAD${"m".repeat(5_000)}TAIL`;
const floored = m.compactMessages([{ role: "tool", content: marked }], 0)[0].content;
eq("floor keeps the head", floored.startsWith("HEAD"), true);
eq("floor keeps the tail", floored.endsWith("TAIL"), true);

// Slicing by UTF-16 unit splits a surrogate pair and emits a lone surrogate,
// which then rides into a jsonb column and a JSON request body as invalid text.
const emoji = "🙂".repeat(5_000);
const cut = m.compactMessages([{ role: "tool", content: emoji }], 0)[0].content;
eq("no lone surrogate survives truncation", /[\uD800-\uDFFF]/.test(cut.replace(/🙂/g, "")), false);
eq("head/tail are whole emoji", cut.startsWith("🙂") && cut.endsWith("🙂"), true);

// `_source` is ours, not OpenAI's — it must never reach a provider.
const tagged = [{ role: "user", content: "go", _source: "auto-continue" }];
eq("_source stripped from the request", "_source" in m.compactMessages(tagged, 100)[0], false);
eq("_source kept on the stored message", tagged[0]._source, "auto-continue");

console.log("\n— repeat-tool guard (loop hygiene) —");
// segmentMadeProgress only asks "did ANY tool run" — so twelve identical reads
// scored full progress and burned the whole step budget. These pin the chain.
const call = (name, args) => ({
  role: "assistant",
  tool_calls: [{ id: "x", function: { name, arguments: JSON.stringify(args) } }],
});
const res = () => ({ role: "tool", tool_call_id: "x", content: "ok" });
const chainOf = (...turns) => m.repeatChainCount(turns.flat());

eq("key ignores argument order",
  m.repeatKey("gh_read_file", '{"a":1,"b":2}') === m.repeatKey("gh_read_file", '{"b":2,"a":1}'), true);
eq("key separates different tools",
  m.repeatKey("gh_read_file", "{}") === m.repeatKey("gh_list_prs", "{}"), false);

eq("one call is a chain of 1",
  chainOf([call("gh_read_file", { path: "a" }), res()]).count, 1);
eq("three identical calls count 3", chainOf(
  [call("gh_read_file", { path: "a" }), res()],
  [call("gh_read_file", { path: "a" }), res()],
  [call("gh_read_file", { path: "a" }), res()],
).count, 3);
eq("a different argument resets", chainOf(
  [call("gh_read_file", { path: "a" }), res()],
  [call("gh_read_file", { path: "a" }), res()],
  [call("gh_read_file", { path: "b" }), res()],
).count, 1);
eq("a human turn resets the chain", chainOf(
  [call("gh_read_file", { path: "a" }), res()],
  [{ role: "user", content: "actually, do this instead" }],
  [call("gh_read_file", { path: "a" }), res()],
).count, 1);
// The auto-continue prompt is a machine turn: a run stuck on one call across a
// segment boundary is exactly the case this guard exists for, so it must NOT
// launder the chain the way a genuine human interjection does.
eq("an auto-continue prompt does NOT reset", chainOf(
  [call("gh_read_file", { path: "a" }), res()],
  [call("gh_read_file", { path: "a" }), res()],
  [{ role: "user", content: "[auto-continue] …", _source: "auto-continue" }],
  [call("gh_read_file", { path: "a" }), res()],
).count, 3);
eq("isHumanTurn: bare user turn", m.isHumanTurn({ role: "user", content: "hi" }), true);
eq("isHumanTurn: injected turn", m.isHumanTurn({ role: "user", content: "hi", _source: "auto-continue" }), false);

const threeSame = [
  call("gh_read_file", { path: "a" }), res(),
  call("gh_read_file", { path: "a" }), res(),
  call("gh_read_file", { path: "a" }), res(),
];
eq("no nudge below the first threshold",
  m.repeatReminder(threeSame.slice(0, 4)), null);
const nudge3 = m.repeatReminder(threeSame);
eq("first threshold nudges", !!nudge3, true);
eq("first threshold is the gentle form", nudge3.text.includes("consecutive_calls"), false);
const five = [...threeSame, call("gh_read_file", { path: "a" }), res(), call("gh_read_file", { path: "a" }), res()];
const nudge5 = m.repeatReminder(five);
eq("later threshold is the detailed form", nudge5.text.includes("consecutive_calls: 5"), true);
eq("detailed form names the tool", nudge5.tool, "gh_read_file");

// The preview cap bounds the REMINDER; the chain key always compares full args,
// so a looping whole-file gh_propose_change payload cannot ride into the request.
const fat = (n) => [call("gh_propose_change", { body: "z".repeat(20_000) }), res()];
const fatNudge = m.repeatReminder([...fat(), ...fat(), ...fat(), ...fat(), ...fat()]);
eq("huge arguments are previewed, not quoted whole", fatNudge.text.length < 2_000, true);
eq("preview says how much it dropped", /\+\d+ more chars/.test(fatNudge.text), true);

console.log("\n— per-tool time budgets —");
// Every tool used to get the WHOLE remaining wall, so one slow call could eat
// the segment and leave nothing to summarize with.
eq("a declared budget caps a generous remainder",
  m.toolBudgetFor("gh_read_file", 90_000), 30_000);
eq("the remainder caps a declared budget",
  m.toolBudgetFor("gh_propose_edit", 9_000), 9_000);
eq("an unknown tool falls back to the call timeout",
  m.toolBudgetFor("some_future_tool", 999_000), 50_000);
eq("never negative", m.toolBudgetFor("gh_read_file", -5), 0);
// A multi-request tool must be allowed more than a single round-trip, or the
// read→branch→write→PR chain cannot fit inside its own budget.
eq("multi-request tools out-budget single reads",
  m.TOOL_BUDGET_MS.gh_propose_edit > m.TOOL_BUDGET_MS.gh_read_file, true);

console.log("\n— segment orientation —");
const orient0 = m.segmentOrientation(0, 0, 100_000);
eq("names the segment", /Segment 1 of at most 6/.test(orient0), true);
eq("states the working time", /about 100s/.test(orient0), true);
eq("early segments mention the hand-off", /next segment/.test(orient0), true);
eq("no elapsed claim on a fresh run", /so far in this run/.test(orient0), false);
const orientLast = m.segmentOrientation(5, 8 * 60_000, 100_000);
eq("the last segment says so", /LAST segment/.test(orientLast), true);
eq("…and does not promise a next one", /carries to the next segment/.test(orientLast), false);
eq("reports elapsed once there is some", /8m so far in this run/.test(orientLast), true);
// It is injected, so it must never read as a human turn — otherwise it would
// reset the repeat chain at the start of every single segment.
eq("orientation never resets the repeat chain",
  m.isHumanTurn({ role: "user", content: orient0, _source: "orientation" }), false);

console.log("\n— applyEdits (gh_propose_edit core) —");
const file = "line one\nline two\nline three\n";
eq("single replace", m.applyEdits(file, [{ old_string: "line two", new_string: "LINE 2" }], "f").content,
   "line one\nLINE 2\nline three\n");
eq("sequential edits", m.applyEdits(file, [
  { old_string: "line one", new_string: "1" },
  { old_string: "line three", new_string: "3" },
], "f").content, "1\nline two\n3\n");
eq("missing old_string errors", !!m.applyEdits(file, [{ old_string: "nope", new_string: "x" }], "f").error, true);
eq("ambiguous match errors", !!m.applyEdits("a\na\n", [{ old_string: "a", new_string: "b" }], "f").error, true);
eq("replace_all allowed", m.applyEdits("a\na\n", [{ old_string: "a", new_string: "b", replace_all: true }], "f").content, "b\nb\n");
eq("empty old_string errors", !!m.applyEdits(file, [{ old_string: "", new_string: "x" }], "f").error, true);
eq("no-op errors", !!m.applyEdits(file, [{ old_string: "line one", new_string: "line one" }], "f").error, true);
eq("multiline exact match", m.applyEdits(file, [{ old_string: "line one\nline two", new_string: "merged" }], "f").content,
   "merged\nline three\n");
// String.replace would expand these as substitution patterns and corrupt the file.
eq("dollar patterns are literal", m.applyEdits("const a = 1;\n", [
  { old_string: "const a = 1;", new_string: "const a = `${x}$& $1 $'`;" },
], "f").content, "const a = `${x}$& $1 $'`;\n");
eq("dollar patterns literal in replace_all", m.applyEdits("a\na\n", [
  { old_string: "a", new_string: "$&$1", replace_all: true },
], "f").content, "$&$1\n$&$1\n");

console.log("\n— status classification —");
eq("budget stop detected", m.isBudgetStop("Stopped after the maximum number of tool steps without a final answer."), true);
eq("timeout is not a hard error", m.isHardError("⚠ Model error on step 3: OpenRouter call timed out (50000ms)"), false);
eq("provider error is hard once retries are spent", m.isHardError("⚠ Model error on step 1: Provider returned error"), true);
eq("no tools + budget stop = no progress", m.segmentMadeProgress([], "Stopped: hit the time budget before a final answer."), false);
eq("tools ran = progress", m.segmentMadeProgress(["gh_read_file(...) → ok"], ""), true);

console.log("\n— detectOpenedPr (must only fire on a real PR tool) —");
const OK = "opened PR #123: https://github.com/o/r/pull/123 (branch agent/x → main, 1 file(s))";
eq("propose_edit success", m.detectOpenedPr("gh_propose_edit", OK), { opened: true, url: "https://github.com/o/r/pull/123" });
eq("propose_change success", m.detectOpenedPr("gh_propose_change", OK).opened, true);
// The regression: reading a file (or a run log) that merely CONTAINS the phrase
// made the agent claim it had opened a PR. This is the agent's own source line.
eq("reading source containing the phrase", m.detectOpenedPr("gh_read_file",
  "path: index.ts\n\nreturn `opened PR #${pr.data.number}: ${pr.data.html_url}`;").opened, false);
eq("read_runs echoing an old PR", m.detectOpenedPr("read_runs",
  '[{"output":"opened PR #57: https://github.com/o/r/pull/57"}]').opened, false);
eq("gh_list_prs listing PRs", m.detectOpenedPr("gh_list_prs", OK).opened, false);
eq("failed propose_edit", m.detectOpenedPr("gh_propose_edit", "error: open PR → 422: already exists").opened, false);
eq("phrase not at start of a PR tool result", m.detectOpenedPr("gh_propose_edit",
  "note: the template says opened PR #1").opened, false);

console.log("\n— write-path guards (must not regress) —");
eq("blocks .github", !!m.deniedWritePath(".github/workflows/deploy.yml"), true);
eq("blocks .env", !!m.deniedWritePath(".env.production"), true);
eq("blocks traversal", !!m.deniedWritePath("../../etc/passwd"), true);
eq("allows normal source", m.deniedWritePath("supabase/functions/openrouter-agent/index.ts"), null);
eq("forces agent/ prefix", m.normalizeAgentBranch("fix-thing"), "agent/fix-thing");
eq("no double prefix", m.normalizeAgentBranch("agent/agent/x"), "agent/x");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
