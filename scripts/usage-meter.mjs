#!/usr/bin/env node
// Routiner — OpenRouter usage meter (CLI).
//
// Polls the `openrouter-usage` Supabase edge function (which holds the key and
// returns live credits + our per-call ledger) and renders a neon terminal meter:
// a credit progress bar, today / month spend, lifetime spend, a per-model
// breakdown, and the most recent calls. Each poll is appended to a local JSON
// history file for offline aggregation.
//
// No API key needed here — the edge function holds it. Zero dependencies.
//
// Usage:
//   node scripts/usage-meter.mjs                 # one snapshot (neon)
//   node scripts/usage-meter.mjs --watch 30      # refresh every 30s
//   node scripts/usage-meter.mjs --plain         # no colors (logs / CI)
//   node scripts/usage-meter.mjs --demo          # sample data, no network
//   node scripts/usage-meter.mjs --json          # raw JSON, then exit
//   node scripts/usage-meter.mjs --no-history    # don't write the history file
//
// Endpoint resolution (first that is set):
//   --url <u>  |  $ROUTINER_USAGE_URL  |  the project default below.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL = "https://vonfdzttupyemtomsojy.supabase.co/functions/v1/openrouter-usage";
const HISTORY_FILE = join(__dirname, "..", ".cache", "openrouter-usage-history.jsonl");

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const opts = {
  url: val("--url", process.env.ROUTINER_USAGE_URL || DEFAULT_URL),
  watch: has("--watch") ? Math.max(Number(val("--watch", 30)) || 30, 5) : 0,
  plain: has("--plain") || !process.stdout.isTTY,
  demo: has("--demo"),
  jsonOut: has("--json"),
  noHistory: has("--no-history"),
};

// ── neon palette (24-bit ANSI) ───────────────────────────────────────────────
const rgb = (r, g, b) => (s) => (opts.plain ? s : `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`);
const C = {
  magenta: rgb(255, 60, 172),
  cyan: rgb(60, 230, 255),
  lime: rgb(200, 255, 69),
  blue: rgb(77, 107, 255),
  yellow: rgb(245, 211, 59),
  red: rgb(255, 77, 94),
  grey: rgb(124, 135, 158),
  white: rgb(244, 247, 255),
};
const bold = (s) => (opts.plain ? s : `\x1b[1m${s}\x1b[0m`);
const dim = (s) => (opts.plain ? s : `\x1b[2m${s}\x1b[0m`);

const usd = (n) => `$${(Number(n) || 0).toFixed(Number(n) && Math.abs(n) < 1 ? 4 : 2)}`;
const num = (n) => (Number(n) || 0).toLocaleString("en-US");
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

// ── neon progress bar ─────────────────────────────────────────────────────────
function bar(frac, width = 34) {
  frac = Math.max(0, Math.min(1, Number(frac) || 0));
  const filled = Math.round(frac * width);
  const color = frac >= 0.9 ? C.red : frac >= 0.7 ? C.yellow : C.lime;
  const full = "█".repeat(filled);
  const empty = dim("░".repeat(width - filled));
  return `${color(full)}${empty}`;
}

function sampleData() {
  const now = Date.now();
  const mk = (min, model, tok, cost, account) => ({
    created_at: new Date(now - min * 60000).toISOString(),
    model, total_tokens: tok, cost, account, trigger_key: "A",
  });
  return {
    ok: true,
    key: { label: "routiner", usage: 18.42, limit: 50, limit_remaining: 31.58, is_free_tier: false },
    totals: { today: { cost: 0.0312, tokens: 41250, calls: 9 }, month: { cost: 4.187, tokens: 5123400, calls: 612 } },
    by_model: [
      { model: "z-ai/glm-4.7", cost: 2.91, tokens: 3810000, calls: 480 },
      { model: "z-ai/glm-5", cost: 0.97, tokens: 980000, calls: 88 },
      { model: "moonshotai/kimi-k2.7-code", cost: 0.21, tokens: 230400, calls: 31 },
      { model: "deepseek/deepseek-chat", cost: 0.09, tokens: 103000, calls: 13 },
    ],
    recent: [
      mk(2, "z-ai/glm-4.7", 5120, 0.0041, "sparks9679"),
      mk(7, "z-ai/glm-4.7", 3380, 0.0027, "zparxmarketing"),
      mk(15, "z-ai/glm-5", 9210, 0.0089, "sparks9679"),
      mk(41, "moonshotai/kimi-k2.7-code", 2100, 0.0014, "sparks9679"),
      mk(63, "z-ai/glm-4.7", 6740, 0.0054, "zparxmarketing"),
    ],
  };
}

async function fetchData() {
  if (opts.demo) return sampleData();
  const res = await fetch(opts.url, { headers: { accept: "application/json" } });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Non-JSON from endpoint (HTTP ${res.status}): ${text.slice(0, 160)}`); }
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function writeHistory(d) {
  if (opts.noHistory || opts.demo) return;
  try {
    await mkdir(dirname(HISTORY_FILE), { recursive: true });
    const snap = {
      ts: new Date().toISOString(),
      key_usage: d.key?.usage ?? null,
      limit_remaining: d.key?.limit_remaining ?? null,
      today: d.totals?.today ?? null,
      month: d.totals?.month ?? null,
    };
    await appendFile(HISTORY_FILE, JSON.stringify(snap) + "\n");
  } catch { /* history is best-effort */ }
}

function render(d) {
  const out = [];
  const rule = dim("─".repeat(52));
  out.push("");
  out.push(`  ${C.magenta("◆")} ${bold(C.white("ROUTINER"))} ${C.cyan("OPENROUTER USAGE")} ${opts.demo ? C.yellow("[demo]") : ""}`);
  out.push(`  ${rule}`);

  // Credits
  const k = d.key;
  if (k) {
    if (k.limit != null && k.limit > 0) {
      const used = Number(k.usage) || 0;
      const frac = used / k.limit;
      out.push(`  ${C.grey("credits")}  ${bar(frac)} ${bold(C.white(`${Math.round(frac * 100)}%`))}`);
      out.push(`           ${C.white(usd(used))} ${dim("of")} ${C.white(usd(k.limit))}  ${C.grey("·")}  ${C.lime(usd(k.limit_remaining))} ${dim("left")}`);
    } else {
      out.push(`  ${C.grey("credits")}  ${C.white(usd(k.usage))} ${dim("used")}  ${dim("(no limit set / pay-as-you-go)")}`);
    }
    if (k.is_free_tier) out.push(`           ${C.yellow("free tier")}`);
  } else {
    out.push(`  ${C.grey("credits")}  ${dim("(live balance unavailable — key not set or OpenRouter unreachable)")}`);
  }
  out.push(`  ${rule}`);

  // Spend buckets
  const t = d.totals || {};
  const cell = (label, b) =>
    `  ${C.grey(label.padEnd(7))} ${bold(C.lime(usd(b?.cost).padStart(9)))}   ${C.cyan(num(b?.tokens).padStart(11))} ${dim("tok")}   ${C.white(String(b?.calls ?? 0).padStart(4))} ${dim("calls")}`;
  out.push(cell("today", t.today));
  out.push(cell("month", t.month));
  if (k) out.push(`  ${C.grey("life".padEnd(7))} ${bold(C.white(usd(k.usage).padStart(9)))}   ${dim("(lifetime spend on this key)")}`);
  out.push(`  ${rule}`);

  // By model
  if (d.by_model?.length) {
    out.push(`  ${C.magenta("by model")} ${dim("(this month)")}`);
    const maxCost = Math.max(...d.by_model.map((m) => m.cost), 0.000001);
    for (const m of d.by_model.slice(0, 6)) {
      out.push(`    ${C.white(m.model.padEnd(28).slice(0, 28))} ${bar(m.cost / maxCost, 14)} ${C.lime(usd(m.cost).padStart(8))} ${dim(`${m.calls}×`)}`);
    }
    out.push(`  ${rule}`);
  }

  // Recent calls
  if (d.recent?.length) {
    out.push(`  ${C.cyan("recent")}`);
    for (const r of d.recent.slice(0, 8)) {
      out.push(
        `    ${dim(ago(r.created_at).padStart(3))} ${C.grey("ago")}  ${C.white(r.model.padEnd(26).slice(0, 26))} ` +
        `${C.cyan(num(r.total_tokens).padStart(8))} ${dim("tok")}  ${C.lime(usd(r.cost).padStart(8))}` +
        (r.account ? `  ${dim(r.account)}` : ""),
      );
    }
  } else {
    out.push(`  ${dim("no calls logged yet — fire a routine that offloads to OpenRouter")}`);
  }
  out.push("");
  return out.join("\n");
}

async function tick() {
  let data;
  try {
    data = await fetchData();
  } catch (e) {
    const msg = `  ${C.red("✗ usage meter:")} ${e.message}`;
    if (opts.jsonOut) { console.log(JSON.stringify({ ok: false, error: e.message })); }
    else { if (opts.watch) process.stdout.write("\x1b[2J\x1b[H"); console.error(msg); }
    return false;
  }
  await writeHistory(data);
  if (opts.jsonOut) { console.log(JSON.stringify(data, null, 2)); return true; }
  if (opts.watch) process.stdout.write("\x1b[2J\x1b[H"); // clear for refresh
  console.log(render(data));
  if (opts.watch) console.log(dim(`  refreshing every ${opts.watch}s — ctrl-c to stop · ${new Date().toLocaleTimeString()}`));
  return true;
}

await tick();
if (opts.watch && !opts.jsonOut) {
  setInterval(tick, opts.watch * 1000);
}
