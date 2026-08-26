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
src += `\nexport { drainWithLimit, accountKind, checkKeyBalance };\n`;
const OUT = `${process.env.TMPDIR || "/tmp"}/scheduler_under_test.ts`;
writeFileSync(OUT, src);

// A key must be present or the balance alarm short-circuits on "no-key" before
// it ever reaches the logic under test. Everything else stays unset so the
// module's own defaults are what get exercised.
globalThis.Deno = {
  env: { get: (n) => (n === "OPENROUTER_API_KEY" ? "sk-test" : undefined) },
  serve: () => {},
};
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

console.log("\n— key-balance alarm —");
// The largest outage this system has had was silent: the key hit its cap and
// every agent run failed for three weeks because nothing watched the balance.
// These pin the two ways a watchdog can be worse than none — crying wolf, and
// staying quiet when it matters.
const KEY_API = "https://openrouter.ai/api/v1/key";
const withKey = async (payload, { ok = true, throws = false, board = [], insertOk = true } = {}) => {
  const real = globalThis.fetch;
  const writes = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === KEY_API) {
      if (throws) throw new Error("network down");
      return { ok, json: async () => payload };
    }
    if (u.includes("routiner_notes") && (init.method || "GET") === "GET") {
      return { ok: true, json: async () => board };
    }
    if (u.includes("routiner_notes")) { writes.push(JSON.parse(init.body)); return { ok: insertOk }; }
    if (u.includes("routiner_routines")) {
      return { ok: true, json: async () => [{ user_id: "user-1" }] };
    }
    return { ok: true, json: async () => [] };
  };
  try { return { result: await m.checkKeyBalance(), writes }; }
  finally { globalThis.fetch = real; }
};

const LIMITED = (left) => ({ data: { limit: 12, limit_remaining: left } });

let r = await withKey(LIMITED(9.5));
eq("healthy balance stays quiet", r.result, "ok");
eq("…and writes nothing", r.writes.length, 0);

r = await withKey(LIMITED(0));
eq("a spent key warns", r.result, "warned-spent");
eq("…names the remaining balance", /\$0\.00 remaining/.test(r.writes[0].body), true);
eq("…carries the marker for cooldown lookups", r.writes[0].body.includes("[key-balance]"), true);
eq("…and lands as an active board note", r.writes[0].status, "active");

r = await withKey(LIMITED(0.4));
eq("a nearly-spent key warns before it dies", r.result, "warned-low");

// A key with no cap configured can never run out this way — alarming on it
// would cry wolf every 15 minutes forever.
r = await withKey({ data: { limit: null, limit_remaining: null } });
eq("an uncapped key never alarms", r.result, "no-limit");

// An unreachable or garbled probe must stay silent: an OpenRouter blip must not
// manufacture a scare note on a key that is perfectly healthy.
eq("an HTTP error is silent", (await withKey({}, { ok: false })).result, "probe-failed");
eq("a network failure is silent", (await withKey(LIMITED(0), { throws: true })).result, "probe-failed");
eq("a garbled payload is silent", (await withKey({ data: {} })).result, "no-limit");

// Cooldown: one note per window, or a spent key files 1,440 notes a day.
r = await withKey(LIMITED(0), { board: [{ id: "existing" }] });
eq("an existing recent note suppresses a duplicate", r.result, "already-warned");
eq("…and writes nothing", r.writes.length, 0);

console.log(`\n${fail ? "FAILURES" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
