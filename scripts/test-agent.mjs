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
         parseReasoningEffort, exhaustedMessage, detectOpenedPr };
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
eq("newest kept full, older floored", toolLens, [425, 425, 50_000]);
eq("total tool chars under control", toolLens.reduce((a, b) => a + b, 0) <= 61_000, true);
eq("input not mutated", msgs[1].content.length, 50_000);
eq("non-tool untouched", out[0].content, "sys");
const small = [{ role: "tool", content: "tiny" }, { role: "tool", content: big(70_000) }];
eq("small results never truncated", m.compactMessages(small, 10)[0].content, "tiny");
eq("zero budget floors big ones", m.compactMessages(small, 0)[1].content.length, 425);

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
