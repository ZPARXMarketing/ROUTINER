#!/usr/bin/env node
// Routiner — OpenRouter model shootout.
//
// Benchmarks several OpenRouter models *through the same dynamic-responder proxy
// a routine uses*, so the numbers reflect this environment's real constraints
// (notably the proxy's ~45s timeout and how each model spends its token budget).
// For each model it runs a small suite of coding sub-tasks, N samples each,
// EXECUTES the returned function against assertion cases (objective correctness,
// not vibes), and prints a Markdown leaderboard: pass-rate, latency, cost,
// and empty/error counts.
//
// Why this exists: the human-written model labels in CLAUDE.md were contradicted
// by measurement (GLM reasoning models return "(empty)" on short offloads). This
// makes that check repeatable so the guidance stays honest as models change.
//
// Usage:
//   node scripts/bench-models.mjs                          # default models, 2 samples
//   node scripts/bench-models.mjs --samples 3
//   node scripts/bench-models.mjs --models deepseek/deepseek-chat,z-ai/glm-5
//   node scripts/bench-models.mjs --json                   # machine-readable results
//   node scripts/bench-models.mjs --max-tokens 800
//
// It reuses glm.mjs's conventions: endpoint resolution ($ROUTINER_GLM_URL /
// $ROUTINER_PROXY_URL / default), $RESPONDER_SECRET forwarding, and
// $ROUTINER_ACCOUNT/$ROUTINER_TRIGGER spend attribution.
//
// SECURITY NOTE: this executes model-generated code in-process (new Function) to
// grade it. The tasks ask for tiny pure functions and this is a dev tool run
// deliberately — do not point it at untrusted models without sandboxing.
//
// Exit codes: 0 ok · 1 proxy/network failure for every call · 3 bad usage.

const DEFAULT_URL =
  "https://vonfdzttupyemtomsojy.supabase.co/functions/v1/dynamic-responder";

const DEFAULT_MODELS = [
  "deepseek/deepseek-chat",
  "meta-llama/llama-3.3-70b-instruct",
  "moonshotai/kimi-k2.7-code",
  "z-ai/glm-4.7",
];

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const opts = {
  models: val("--models", "").trim() ? val("--models", "").split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_MODELS,
  samples: Math.max(1, Number(val("--samples", "2")) || 2),
  maxTokens: Number(val("--max-tokens", "800")) || 800,
  jsonOut: has("--json"),
  url: val("--url", process.env.ROUTINER_GLM_URL || process.env.ROUTINER_PROXY_URL || DEFAULT_URL),
  account: val("--account", process.env.ROUTINER_ACCOUNT || process.env.ROUTINER_GLM_ACCOUNT || "sparks9679"),
  triggerKey: val("--trigger-key", process.env.ROUTINER_TRIGGER || process.env.ROUTINER_GLM_TRIGGER || "t_a"),
};

// ── task suite: each is a self-grading coding sub-task ─────────────────────────
// `fn` is the name the prompt asks for; `cases` are [args, expected] pairs run
// against the returned function. A sample passes only if every case matches.
const TASKS = [
  {
    name: "hexcolor",
    fn: "isValidHexColor",
    prompt: 'Write a JavaScript function isValidHexColor(s) returning true ONLY for "#RGB" or "#RRGGBB" (hex digits, case-insensitive). Output ONLY the function — no prose, no code fences.',
    cases: [[["#fff"], true], [["#FFFFFF"], true], [["#Ab3"], true], [["fff"], false], [["#ffff"], false], [["#gggggg"], false], [[""], false]],
  },
  {
    name: "slugify",
    fn: "slugify",
    prompt: 'Write a JavaScript function slugify(s): lowercase, trim, replace runs of any non-alphanumeric chars with a single hyphen, and strip leading/trailing hyphens. Output ONLY the function — no prose, no code fences.',
    cases: [[["Hello, World!"], "hello-world"], [["  Foo   Bar  "], "foo-bar"], [["a--b__c"], "a-b-c"], [["Already-Slug"], "already-slug"]],
  },
  {
    name: "e164",
    fn: "isE164",
    prompt: 'Write a JavaScript function isE164(s) that validates E.164 phone numbers: a leading "+", then a nonzero leading digit, then up to 14 more digits (2 to 15 digits total). Output ONLY the function — no prose, no code fences.',
    cases: [[["+14155550100"], true], [["+499999999"], true], [["14155550100"], false], [["+0123"], false], [["+"], false], [["+1234567890123456"], false]],
  },
];

const secretHeader = () => {
  const secret = process.env.RESPONDER_SECRET || process.env.ROUTINER_RESPONDER_SECRET;
  return secret ? { "x-responder-secret": secret } : {};
};

async function callModel(model, prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  const started = Date.now();
  try {
    const res = await fetch(opts.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...secretHeader() },
      body: JSON.stringify({ model, max_tokens: opts.maxTokens, account: opts.account, trigger_key: opts.triggerKey, prompt }),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    const ms = Date.now() - started;
    if (!json || json.ok === false) return { ok: false, ms, error: json?.error || `HTTP ${res.status}` };
    return { ok: true, ms, content: (json.content ?? "").trim(), cost: json.usage?.cost };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e.name === "AbortError" ? "timeout(45s)" : String(e.message || e), timedOut: e.name === "AbortError" };
  } finally {
    clearTimeout(timer);
  }
}

// Strip ``` fences / stray "export" and pull out the requested function.
function extractFn(raw, name) {
  let code = String(raw || "").trim();
  code = code.replace(/^```[a-zA-Z]*\s*/m, "").replace(/```/g, "").trim();
  code = code.replace(/^\s*export\s+/gm, "");
  if (!code) return null;
  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function(`${code}\n; return (typeof ${name} === "function") ? ${name} : null;`);
    const fn = factory();
    return typeof fn === "function" ? fn : null;
  } catch {
    return null;
  }
}

function gradeSample(content, task) {
  const fn = extractFn(content, task.fn);
  if (!fn) return false;
  try {
    return task.cases.every(([args, expected]) => JSON.stringify(fn(...args)) === JSON.stringify(expected));
  } catch {
    return false;
  }
}

const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

async function main() {
  const results = [];
  for (const model of opts.models) {
    const rec = { model, runs: 0, passes: 0, empties: 0, errors: 0, timeouts: 0, latencies: [], cost: 0 };
    for (const task of TASKS) {
      for (let i = 0; i < opts.samples; i++) {
        const r = await callModel(model, task.prompt);
        rec.runs++;
        if (!r.ok) { rec.errors++; if (r.timedOut) rec.timeouts++; continue; }
        rec.latencies.push(r.ms);
        if (typeof r.cost === "number") rec.cost += r.cost;
        if (!r.content || r.content === "(empty)") { rec.empties++; continue; }
        if (gradeSample(r.content, task)) rec.passes++;
      }
    }
    const graded = rec.runs; // pass-rate is over all attempts (empty/error count as fails)
    rec.passRate = graded ? rec.passes / graded : 0;
    rec.medLatency = median(rec.latencies);
    results.push(rec);
  }

  // Rank: correctness first, then speed, then cost.
  results.sort((a, b) => b.passRate - a.passRate || a.medLatency - b.medLatency || a.cost - b.cost);

  if (opts.jsonOut) { process.stdout.write(JSON.stringify({ config: { samples: opts.samples, maxTokens: opts.maxTokens, tasks: TASKS.map((t) => t.name) }, results }, null, 2) + "\n"); process.exit(0); }

  const rows = results.map((r) => {
    const okCalls = r.latencies.length;
    const lat = okCalls ? `${r.medLatency}ms` : "—";
    const flags = [r.empties ? `${r.empties} empty` : "", r.timeouts ? `${r.timeouts} timeout` : "", r.errors - r.timeouts > 0 ? `${r.errors - r.timeouts} err` : ""].filter(Boolean).join(", ") || "—";
    return `| \`${r.model}\` | ${r.passes}/${r.runs} (${Math.round(r.passRate * 100)}%) | ${lat} | $${r.cost.toFixed(6)} | ${flags} |`;
  });
  const table = [
    `**OpenRouter model shootout** — ${opts.samples} sample(s) × ${TASKS.length} tasks (${TASKS.map((t) => t.name).join(", ")}), max_tokens=${opts.maxTokens}`,
    "",
    "| model | pass rate | median latency | total cost | notes |",
    "|-------|-----------|----------------|------------|-------|",
    ...rows,
  ].join("\n");
  process.stdout.write(table + "\n");

  const anyOk = results.some((r) => r.latencies.length);
  process.exit(anyOk ? 0 : 1);
}

main().catch((e) => { process.stderr.write(`bench-models.mjs: ${String(e.stack || e)}\n`); process.exit(1); });
