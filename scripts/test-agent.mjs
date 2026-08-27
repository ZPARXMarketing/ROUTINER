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
         toolBudgetFor, segmentOrientation, TOOL_BUDGET_MS,
         sliceLines, spillResult, toolGroupOf, toolSpecs,
         normalizeGoal, renderGoal, parseStoredGoal, goalBlockStop, openrouter,
         reconcileGoal };
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
const toolResults = out.filter((x) => x.role === "tool");
const toolLens = toolResults.map((x) => x.content.length);
eq("newest kept full", toolLens[2], 50_000);
eq("older two floored", toolLens[0] < 600 && toolLens[1] < 600, true);
eq("total tool chars under control", toolLens.reduce((a, b) => a + b, 0) <= 61_000, true);
eq("input not mutated", msgs[1].content.length, 50_000);
eq("non-tool untouched", out[0].content, "sys");
const small = [{ role: "tool", content: "tiny" }, { role: "tool", content: big(70_000) }];
eq("small results never truncated", m.compactMessages(small, 10)[0].content, "tiny");
eq("zero budget floors big ones", m.compactMessages(small, 0)[1].content.length < 600, true);

// An unmeasured "…[truncated]…" leaves the model unable to tell fifty lost
// characters from fifty thousand, so it cannot judge whether recovering them is
// worth a step — and the cheapest way to find out is to re-run the tool, which
// is the loop the repeat guard then has to catch.
const quantified = m.compactMessages([{ role: "tool", content: big(50_000) }], 0)[0].content;
eq("floor marker states what was dropped", /49600 of 50000 chars/.test(quantified), true);
eq("floor marker states the total line count", /1 line total/.test(quantified), true);
const multiline = m.compactMessages([{ role: "tool", content: `${big(5_000)}\n${big(5_000)}` }], 0)[0].content;
eq("floor marker pluralizes lines", /2 lines total/.test(multiline), true);
// The marker grew when it started carrying counts, so the flat 400 the budget
// used to charge for a floored result now under-states what it really costs.
// Every floored result must be charged what it actually occupies.
const BUDGET = 12_000;
const many = Array.from({ length: 12 }, () => ({ role: "tool", content: big(5_000) }));
const kept = m.compactMessages(many, BUDGET).filter((x) => x.role === "tool");
const fullSize = kept.filter((x) => x.content.length === 5_000);
eq("the newest results fit the budget in full", fullSize.length, 2);
eq("the newest results are the ones kept", kept.slice(-2).every((x) => x.content.length === 5_000), true);
eq("a floored result is charged more than the bare 400-char floor",
   kept[0].content.length > 400, true);
eq("full-size results never exceed the budget",
   fullSize.reduce((a, x) => a + x.content.length, 0) <= BUDGET, true);

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

console.log("\n— durable retry (checkpoint before the wait) —");
// A retry held only in memory disappears if the edge function is killed during
// the backoff — which this deployment does under load — leaving a row that just
// went quiet, indistinguishable from a hang. It also has to bump last-activity
// or the scheduler's stale-run reaper marks a backing-off run dead.
{
  const real = globalThis.fetch;
  const events = [];
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    // Fail transiently twice, then succeed.
    if (calls <= 2) return { ok: false, status: 503, json: async () => ({ error: { message: "Provider returned error" } }) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "done" } }], usage: {} }) };
  };
  const r = await m.openrouter("sk-test", "z-ai/glm-4.7", [{ role: "user", content: "hi" }], {
    retries: 2, timeoutMs: 5_000,
    onRetry: (info) => { events.push({ ...info, at: "before-sleep" }); },
  });
  globalThis.fetch = real;
  eq("the call eventually succeeds", r.ok, true);
  eq("one checkpoint per backoff", events.length, 2);
  eq("attempts are numbered from 1", events.map((e) => e.attempt), [1, 2]);
  eq("the retry ceiling is reported", events[0].retries, 2);
  eq("the delay is stated", events[0].delayMs > 0, true);
  eq("the cause is carried", /Provider returned error/.test(events[0].error), true);
  eq("a 503 is reported as such", events[0].status, 503);
}
// A checkpoint failure must never abort a retry that would have succeeded.
{
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 503, json: async () => ({ error: { message: "flaky" } }) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }) };
  };
  const r = await m.openrouter("sk-test", "z-ai/glm-4.7", [{ role: "user", content: "hi" }], {
    retries: 1, timeoutMs: 5_000,
    onRetry: () => { throw new Error("checkpoint died"); },
  });
  globalThis.fetch = real;
  eq("a thrown checkpoint does not kill the retry", r.ok, true);
}
// A permanent failure must not checkpoint a retry it is never going to make.
{
  const real = globalThis.fetch;
  const events = [];
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "No auth credentials found" } }) });
  const r = await m.openrouter("sk-test", "z-ai/glm-4.7", [{ role: "user", content: "hi" }], {
    retries: 2, timeoutMs: 5_000, onRetry: (i) => { events.push(i); },
  });
  globalThis.fetch = real;
  eq("a permanent error still fails fast", r.ok, false);
  eq("…and announces no retry", events.length, 0);
}

console.log("\n— run goal (survives compaction) —");
// `messages` is compacted between segments — old tool results are floored — so
// by segment four the model's record of its own plan is mostly gone, and
// AUTO_CONTINUE_PROMPT was asking it to resume from the part we deleted.
const G = (o, prev = null) => m.normalizeGoal(o, prev);
eq("an objective is required", "error" in G({}), true);
eq("phase defaults to active", G({ objective: "fix #57" }).phase, "active");
eq("an unknown phase is rejected", "error" in G({ objective: "x", phase: "paused" }), true);
eq("lists are cleaned of blanks",
  G({ objective: "x", done: ["a", "", "  ", "b"] }).done, ["a", "b"]);
eq("lists are capped", G({ objective: "x", remaining: Array(50).fill("s") }).remaining.length, 12);
// A blocked run with no stated cause is the dead-end this exists to prevent:
// the next segment and the human would both have nothing to act on.
eq("blocked demands a code and a message",
  "error" in G({ objective: "x", phase: "blocked" }), true);
eq("blocked with only a code is still refused",
  "error" in G({ objective: "x", phase: "blocked", blocked_code: "needs-human" }), true);
const blocked = G({ objective: "fix #57", phase: "blocked", blocked_code: "Needs-Human", blocked_message: "PR needs a maintainer" });
eq("a full block is accepted", blocked.phase, "blocked");
eq("the code is normalized", blocked.blocked_reason.code, "needs-human");

// Partial updates keep what the previous segment established.
const prev = G({ objective: "fix #57", done: ["read the issue"], remaining: ["open a PR"] });
eq("an update inherits the objective", G({ done: ["read", "edited"] }, prev).objective, "fix #57");
eq("an update replaces the list it names", G({ done: ["read", "edited"] }, prev).done, ["read", "edited"]);
eq("…and keeps the one it doesn't", G({ done: ["read"] }, prev).remaining, ["open a PR"]);

eq("renders the objective", /\[goal\] fix #57/.test(m.renderGoal(prev)), true);
eq("renders progress", /✓ read the issue/.test(m.renderGoal(prev)), true);
eq("renders nothing for no goal", m.renderGoal(null), "");
eq("a stored goal round-trips", m.parseStoredGoal(JSON.parse(JSON.stringify(prev))).objective, "fix #57");
eq("garbage in the column is ignored", m.parseStoredGoal({ nonsense: 1 }), null);
eq("a null column is ignored", m.parseStoredGoal(null), null);

// The point of making "blocked" a state rather than prose: the chain stops.
// A spent key retried for 8h45m across 45 messages is what happens otherwise.
eq("a blocked goal stops the chain", typeof m.goalBlockStop(blocked), "string");
eq("…and names the cause", /needs-human/.test(m.goalBlockStop(blocked)), true);
eq("…and says why it stopped", /same obstacle/.test(m.goalBlockStop(blocked)), true);
eq("an active goal does not stop it", m.goalBlockStop(prev), null);
eq("no goal does not stop it", m.goalBlockStop(null), null);
// The block notice leads, but what the model said has to survive: it usually
// holds the detail a human needs to clear the block, and a stop that silently
// replaces it makes the run look like it produced nothing.
const withSaid = m.goalBlockStop(blocked, "I could not merge; the branch needs an approving review.");
eq("the model's own words are kept", /needs an approving review/.test(withSaid), true);
eq("…below the blocker, not above it", withSaid.indexOf("Blocked") < withSaid.indexOf("approving"), true);
// A budget-stop string is boilerplate, not a finding — appending it is noise.
eq("a budget stop is not appended",
  m.goalBlockStop(blocked, "Stopped: hit the time budget before a final answer."),
  m.goalBlockStop(blocked, ""));

// The first live run filed `success` while its own goal still read
// `phase: active, done: []` — the model set it once and never touched it again.
// One segment makes that untidy; across segments the next orientation turn reads
// "nothing done yet" and invites the run to redo finished work.
eq("a success completes an active goal", m.reconcileGoal(prev, "success").phase, "complete");
eq("…without inventing progress", m.reconcileGoal(prev, "success").done, prev.done);
eq("an error leaves the goal alone", m.reconcileGoal(prev, "error").phase, "active");
eq("a blocked goal is never overwritten by success", m.reconcileGoal(blocked, "success").phase, "blocked");
eq("a complete goal stays complete",
  m.reconcileGoal({ ...prev, phase: "complete" }, "success").phase, "complete");
eq("no goal stays no goal", m.reconcileGoal(null, "success"), null);

console.log("\n— tool-output spill —");
// AGENT_GH_READ_RESULT_CAP (120k) vs AGENT_CONTEXT_TOOL_BUDGET (60k) meant one
// large read was 2x the whole full-fidelity budget, so a second read floored the
// first and the model went back to re-read a file it had already been handed.
eq("sliceLines: a window in the middle",
  m.sliceLines("a\nb\nc\nd\ne", 2, 2), { body: "b\nc", from: 2, to: 3, total: 5 });
eq("sliceLines: clamps past the end",
  m.sliceLines("a\nb\nc", 2, 99), { body: "b\nc", from: 2, to: 3, total: 3 });
eq("sliceLines: a start past the end still returns the last line",
  m.sliceLines("a\nb\nc", 99, 5), { body: "c", from: 3, to: 3, total: 3 });

const withInsert = async (fn, { ok = true, id = "11111111-1111-4111-8111-111111111111" } = {}) => {
  const real = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (_u, init) => {
    sent = JSON.parse(init.body);
    return { ok, json: async () => (ok ? [{ id }] : null) };
  };
  try { return { out: await fn(), sent }; } finally { globalThis.fetch = real; }
};

const smallText = "x".repeat(100);
eq("a small result is never spilled",
  (await withInsert(() => m.spillResult(smallText, "gh_read_file", {}, { userId: "u", runId: "r" }))).out, null);

const bigText = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n");
const { out: replaced, sent } = await withInsert(
  () => m.spillResult(bigText, "gh_read_file", { path: "js/app.js" }, { userId: "u", runId: "r" }));
eq("a large result is replaced", typeof replaced === "string", true);
eq("the FULL text is what gets stored", sent.content, bigText);
eq("…and its length is recorded", sent.chars, Array.from(bigText).length);
eq("the replacement names the spill id", replaced.includes("11111111-1111-4111-8111-111111111111"), true);
eq("the replacement keeps the head", replaced.startsWith("line 0"), true);
eq("the replacement keeps the tail", /line 3999\b/.test(replaced), true);
eq("the replacement is far smaller than the original", replaced.length < bigText.length / 2, true);
// The model's standing instruction is "don't re-read a file you already have",
// so a truncated result that does not say the rest is retrievable reads as a
// dead end — which is exactly what sent agents back to re-run the same call.
eq("it says the text was stored, not lost", /not lost/.test(replaced), true);
eq("it names the retrieval tool", /read_spill/.test(replaced), true);
eq("it forbids re-running the tool", /Do NOT re-run gh_read_file/.test(replaced), true);

// A storage failure must never fail the tool call — losing LESS than truncation
// did is the whole point, so the caller keeps its own inline text.
eq("a failed insert falls back to inline",
  (await withInsert(() => m.spillResult(bigText, "gh_read_file", {}, { userId: "u", runId: "r" }), { ok: false })).out, null);
eq("an insert returning no id falls back too",
  (await withInsert(() => m.spillResult(bigText, "gh_read_file", {}, { userId: "u", runId: "r" }), { id: "" })).out, null);
{
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  eq("a thrown insert falls back too",
    await m.spillResult(bigText, "gh_read_file", {}, { userId: "u", runId: "r" }), null);
  globalThis.fetch = real;
}

// read_spill must be reachable regardless of which groups the run enabled: a
// spill only exists because a tool the run already had produced it, and gating
// it would strand the very output we just told the model to page.
eq("read_spill belongs to no group", m.toolGroupOf("read_spill"), "*");
const specNames = (en) => m.toolSpecs(new Set(en)).map((s) => s.function.name);
eq("offered with no groups at all", specNames([]).includes("read_spill"), true);
eq("offered alongside code tools", specNames(["code"]).includes("read_spill"), true);
eq("a run with no groups gets only the ungrouped tools",
  specNames([]).sort(), ["read_spill", "set_goal"]);

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

console.log("\n— applyEdits cascading strictness (whitespace / Unicode drift) —");
// A model that read the file through its own tokenizer emits an em-dash where
// the source has a hyphen, a curly apostrophe where it has a straight one, LF
// where the file has CRLF, or loses a trailing space. Demanding a byte-exact
// match failed every one of those and cost a step plus a re-read.
const fuzzSrc = "const a = 'x'; // half-open\nconst b = 2;   \n\tif (b) run();\n";

// Pass 1 stays exact: an exact match must never be reinterpreted.
const exact = m.applyEdits(fuzzSrc, [{ old_string: "const b = 2;", new_string: "const b = 3;" }], "f");
eq("exact match still wins", exact.content.includes("const b = 3;"), true);
eq("exact match reports no note", exact.notes, undefined);

// Pass 2 — Unicode punctuation the model substituted for ASCII.
const smart = m.applyEdits(fuzzSrc, [{ old_string: "const a = \u2018x\u2019; // half\u2010open", new_string: "const a = 'y';" }], "f");
eq("curly quotes and a Unicode hyphen match", smart.content.includes("const a = 'y';"), true);
eq("a tolerant match is reported", smart.notes.length, 1);
eq("the note names the normalization", /Unicode punctuation/.test(smart.notes[0]), true);

// A CRLF file against an LF needle is the same class of drift.
const crlf = m.applyEdits("one\r\ntwo\r\nthree\r\n", [{ old_string: "one\ntwo", new_string: "ONE" }], "f");
eq("CRLF file matches an LF old_string", crlf.content, "ONE\r\nthree\r\n");

// Pass 3 — the file has trailing whitespace the model did not copy.
const trailing = m.applyEdits(fuzzSrc, [{ old_string: "const b = 2;\n", new_string: "const b = 9;\n" }], "f");
eq("trailing whitespace is ignored", trailing.content.includes("const b = 9;"), true);
eq("trailing-whitespace match is reported", /trailing whitespace/.test(trailing.notes[0]), true);

// Pass 4 — indentation drift, and it replaces WHOLE lines so the model's own
// indentation lands verbatim. Splicing inside the line would keep the file's
// indent and add the model's on top, silently mis-indenting Python or YAML.
const indent = m.applyEdits(fuzzSrc, [{ old_string: "  if (b) run();", new_string: "\tif (b) walk();" }], "f");
eq("indentation drift matches", indent.content.includes("walk()"), true);
eq("whole-line replacement keeps exactly one indent", indent.content.includes("\tif (b) walk();"), true);
eq("the file's own indentation is gone", indent.content.includes("  \tif"), false);
eq("indentation match is reported", /indentation/.test(indent.notes[0]), true);

// Indentation tolerance is whole-lines-only: a mid-line needle must not reach
// pass 4, because its match could not be spliced back without guessing.
eq("a mid-line needle does not get indentation tolerance",
   !!m.applyEdits("  foo(bar) + baz\n", [{ old_string: "foo(bar)  +  baz", new_string: "q" }], "f").error, true);

// Strictness cascades: the first pass that hits wins, so a needle that matches
// exactly in one place must not be widened to a looser match elsewhere.
const both = "value = 1;\nvalue  =  1;\n";
eq("the strictest matching pass wins",
   m.applyEdits(both, [{ old_string: "value = 1;", new_string: "V" }], "f").content, "V\nvalue  =  1;\n");

// Ambiguity is still refused, and now says which pass found the duplicates.
const dup = m.applyEdits("a = 1;   \na = 1;\t\n", [{ old_string: "a = 1;\n", new_string: "b\n" }], "f");
eq("ambiguity found by a tolerant pass still errors", !!dup.error, true);
eq("the error names the pass", /trailing whitespace/.test(dup.error), true);

// The dead end this replaced: "must match EXACTLY — copy it verbatim" sent the
// model to re-type text that was never going to match. Say so instead.
const miss = m.applyEdits(fuzzSrc, [{ old_string: "no such text at all", new_string: "x" }], "f");
eq("a genuine miss says re-typing will not help", /will not help/.test(miss.error), true);
eq("a genuine miss quotes what was looked for", /no such text at all/.test(miss.error), true);

// replace_all under a tolerant pass hits every occurrence, not just the first.
const all = m.applyEdits("x \u2013 1\nx \u2014 1\n", [{ old_string: "x - 1", new_string: "ok", replace_all: true }], "f");
eq("replace_all spans tolerant matches", all.content, "ok\nok\n");

// Splicing by span must stay literal: "$&" in new_string is not a pattern.
eq("dollar patterns literal under a tolerant match",
   m.applyEdits("a \u2013 b\n", [{ old_string: "a - b", new_string: "$&$1" }], "f").content, "$&$1\n");

// A needle that normalizes to nothing has no match to offer; it must not become
// an empty-string match that hits at every offset.
eq("a whitespace-only needle never matches everywhere",
   !!m.applyEdits(fuzzSrc, [{ old_string: "\u200B \u00A0", new_string: "x" }], "f").error, true);

// The tolerant passes walk whole files, so their whitespace scan has to be
// linear. Rescanning each run from every character is quadratic, and one long
// stretch of spaces — a minified asset, a padded fixture — would hang the tool
// loop instead of failing an edit. This finishes instantly when linear and
// takes minutes when not.
// The trailing spaces after real() are what force the run past the exact and
// punctuation passes and into the whitespace scan this is testing.
const padded = `${" ".repeat(100_000)}\nreal();   \n`;
const t0 = Date.now();
const paddedOut = m.applyEdits(padded, [{ old_string: "real();\n", new_string: "fake();\n" }], "f");
eq("the whitespace scan is the pass under test", /trailing whitespace/.test(paddedOut.notes[0]), true);
eq("a huge whitespace run does not hang the matcher", Date.now() - t0 < 3_000, true);
eq("and the edit still applies", paddedOut.content.endsWith("\nfake();\n"), true);

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
