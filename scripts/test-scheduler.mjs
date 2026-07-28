// Tests for the routiner-scheduler dispatch logic.
//
//   node --experimental-strip-types scripts/test-scheduler.mjs
//
// Same approach as test-agent.mjs: no Deno in CI or in a routine session, so
// this loads the edge function under a stubbed Deno global and exercises its
// pure helpers in Node. Importing it at all is a syntax check on the function.
//
// The pool below is load-bearing. Agent routines fired simultaneously starve
// each other: measured on the run log, moonshotai/kimi-k2.7-code on one key
// errored 0% across 10 runs fired alone and 90% across 10 fired alongside
// others. Bounding that concurrency is the fix — so if drainWithLimit stops
// bounding, or stops preserving index order, these must fail.
import { readFileSync, writeFileSync } from "node:fs";

const SRC = new URL("../supabase/functions/routiner-scheduler/index.ts", import.meta.url).pathname;
let src = readFileSync(SRC, "utf8");
src = src.replace(/^import "jsr:.*$/m, "// jsr import stripped");
src += `\nexport { drainWithLimit, accountKind };\n`;
const OUT = `${process.env.TMPDIR || "/tmp"}/scheduler_under_test.ts`;
writeFileSync(OUT, src);

globalThis.Deno = { env: { get: () => undefined }, serve: () => {} };
const m = await import(OUT);

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs fn over idx, recording how many were in flight at once.
async function withPeak(idx, limit, work) {
  let inFlight = 0, peak = 0;
  const out = new Array(10);
  await m.drainWithLimit(idx, limit, out, async (i) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await work(i);
    inFlight--;
    return `v${i}`;
  });
  return { peak, out };
}

console.log("\n— drainWithLimit (agent fire concurrency) —");
{
  const { peak, out } = await withPeak([0, 1, 2, 3, 4], 1, () => sleep(5));
  eq("limit 1 → never two at once", peak, 1);
  eq("all five ran", out.filter(Boolean).length, 5);
  eq("results land at their own index", [out[0].value, out[4].value], ["v0", "v4"]);
}
{
  const { peak } = await withPeak([0, 1, 2, 3, 4], 2, () => sleep(5));
  eq("limit 2 → at most two at once", peak <= 2, true);
}
{
  const { peak } = await withPeak([0, 1, 2, 3, 4], 0, () => sleep(5));
  eq("limit 0 → unbounded (old behaviour)", peak, 5);
}
{
  // Sparse indices: the light and agent partitions share one output array, so a
  // pool must only ever write the indices it was handed.
  const out = new Array(6);
  await m.drainWithLimit([1, 4], 1, out, async (i) => `v${i}`);
  eq("writes only its own indices", out.map((x) => x?.value ?? null), [null, "v1", null, null, "v4", null]);
}
{
  // One failing fire must not take down the batch, or a single bad routine
  // would strand every other due routine in the same tick.
  const out = new Array(3);
  await m.drainWithLimit([0, 1, 2], 1, out, async (i) => {
    if (i === 1) throw new Error("boom");
    return `v${i}`;
  });
  eq("failure captured, not thrown", out.map((x) => x.status), ["fulfilled", "rejected", "fulfilled"]);
  eq("siblings still ran", [out[0].value, out[2].value], ["v0", "v2"]);
}
{
  const out = [];
  await m.drainWithLimit([], 1, out, async () => "never");
  eq("empty index list is a no-op", out.length, 0);
}
{
  // Ordering guarantee under uneven durations: slow first item must not shift
  // anyone else's slot.
  const out = new Array(3);
  await m.drainWithLimit([0, 1, 2], 3, out, async (i) => {
    await sleep(i === 0 ? 15 : 1);
    return `v${i}`;
  });
  eq("slow item keeps its index", out.map((x) => x.value), ["v0", "v1", "v2"]);
}

console.log("\n— accountKind (which fires go through the pool) —");
const accts = [
  { id: "a_claude" },
  { id: "a_agent", kind: "openrouter-agent" },
  { id: "a_leads", kind: "openrouter" },
];
eq("defaults to claude", m.accountKind(accts, "a_claude"), "claude");
eq("agent detected", m.accountKind(accts, "a_agent"), "openrouter-agent");
eq("lead enrichment detected", m.accountKind(accts, "a_leads"), "openrouter");
eq("unknown account → claude", m.accountKind(accts, "nope"), "claude");
eq("no settings → claude", m.accountKind(null, "a_agent"), "claude");

console.log(`\n${fail ? "FAILURES" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
