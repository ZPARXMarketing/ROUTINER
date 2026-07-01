#!/usr/bin/env node
// Routiner — GLM proxy CLI.
//
// A thin, zero-dependency wrapper around the OpenRouter proxy edge function
// (`dynamic-responder`), the same endpoint documented in CLAUDE.md. A routine
// session has no OPENROUTER_API_KEY in its env — and shouldn't. The key lives
// in Supabase edge secrets and never leaves Supabase; this script just POSTs a
// prompt to the proxy and prints the model's text back.
//
// The `--ping` mode is a health check: it sends a tiny prompt and verifies the
// proxy answers, so a scheduled routine can confirm the GLM path is alive
// (edge function up, key present, OpenRouter reachable, credits not exhausted)
// without any human watching.
//
// Usage:
//   node scripts/glm.mjs --ping                        # health check → PONG
//   node scripts/glm.mjs "summarize this in one line"  # one-shot prompt
//   node scripts/glm.mjs --model z-ai/glm-5 "hard task"
//   echo "long text" | node scripts/glm.mjs --stdin "summarize:"
//   node scripts/glm.mjs --json --ping                 # raw JSON, then exit
//
// Flags:
//   --ping                 send a fixed health-check prompt and assert PONG
//   --model <id>           model id (default z-ai/glm-4.7 — the coding default)
//   --max-tokens <n>       token budget (default 1024; --ping uses 64)
//   --account <a>          spend-attribution account (default sparks9679)
//   --trigger-key <k>      spend-attribution trigger  (default A)
//   --stdin                read the prompt body from stdin, appended to argv text
//   --url <u>              override the proxy endpoint
//   --json                 print the raw proxy JSON response, then exit
//   --quiet                print only the model's text (or nothing on error)
//
// Endpoint resolution (first that is set):
//   --url <u>  |  $ROUTINER_GLM_URL  |  $ROUTINER_PROXY_URL  |  the default below.
//
// Exit codes: 0 ok · 1 proxy/network error · 2 ping assertion failed · 3 bad usage.

const DEFAULT_URL =
  "https://vonfdzttupyemtomsojy.supabase.co/functions/v1/dynamic-responder";

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
// Positional prompt text = every arg that isn't a flag or a flag's value.
const FLAGS_WITH_VALUE = new Set([
  "--model",
  "--max-tokens",
  "--account",
  "--trigger-key",
  "--url",
]);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    if (FLAGS_WITH_VALUE.has(a)) i++; // skip its value
    continue;
  }
  positional.push(a);
}

const opts = {
  ping: has("--ping"),
  model: val("--model", "z-ai/glm-4.7"),
  // --ping uses a comfortable floor: GLM-4.7 is a reasoning model and can burn
  // the whole budget on hidden reasoning tokens, returning "(empty)" (see
  // CLAUDE.md's ">=512" note). Too low a cap makes the health check flap.
  maxTokens: Number(val("--max-tokens", has("--ping") ? "512" : "1024")) || 1024,
  account: val("--account", process.env.ROUTINER_GLM_ACCOUNT || "sparks9679"),
  triggerKey: val("--trigger-key", process.env.ROUTINER_GLM_TRIGGER || "A"),
  stdin: has("--stdin"),
  url: val(
    "--url",
    process.env.ROUTINER_GLM_URL || process.env.ROUTINER_PROXY_URL || DEFAULT_URL,
  ),
  jsonOut: has("--json"),
  quiet: has("--quiet"),
};

const PING_PROMPT = "Reply with exactly: PONG. Output only the answer.";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

async function callProxy(prompt) {
  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    account: opts.account,
    trigger_key: opts.triggerKey,
    prompt,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const res = await fetch(opts.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: `non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}` };
    }
    if (!res.ok && json.ok === undefined) json.ok = false;
    return json;
  } catch (e) {
    const msg = e.name === "AbortError" ? "request timed out after 45s" : String(e.message || e);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  // Build the prompt.
  let prompt;
  if (opts.ping) {
    prompt = PING_PROMPT;
  } else {
    let text = positional.join(" ").trim();
    if (opts.stdin) {
      const piped = (await readStdin()).trim();
      text = [text, piped].filter(Boolean).join("\n\n");
    }
    if (!text) {
      process.stderr.write(
        "glm.mjs: no prompt given. Pass text, use --stdin, or --ping.\n",
      );
      process.exit(3);
    }
    prompt = text;
  }

  const started = Date.now();
  const resp = await callProxy(prompt);
  const ms = Date.now() - started;

  if (opts.jsonOut) {
    process.stdout.write(JSON.stringify(resp) + "\n");
    process.exit(resp.ok ? 0 : 1);
  }

  if (!resp.ok) {
    if (!opts.quiet) process.stderr.write(`GLM proxy error: ${resp.error || "unknown"}\n`);
    process.exit(1);
  }

  const content = (resp.content ?? "").trim();

  if (opts.ping) {
    const pass = /\bPONG\b/i.test(content);
    if (opts.quiet) {
      process.stdout.write(content + "\n");
    } else {
      const cost = resp.usage?.cost;
      const model = resp.model || opts.model;
      const costStr = typeof cost === "number" ? ` · $${cost.toFixed(6)}` : "";
      process.stdout.write(
        `${pass ? "✓ GLM proxy alive" : "✗ GLM proxy responded but assertion failed"}` +
          ` — "${content || "(empty)"}" via ${model} in ${ms}ms${costStr}\n`,
      );
    }
    process.exit(pass ? 0 : 2);
  }

  // Normal one-shot: print the model text.
  if (opts.quiet) {
    process.stdout.write(content + "\n");
  } else {
    const model = resp.model || opts.model;
    const cost = resp.usage?.cost;
    const costStr = typeof cost === "number" ? ` ($${cost.toFixed(6)})` : "";
    process.stdout.write(content + "\n");
    process.stderr.write(`— ${model} · ${ms}ms${costStr}\n`);
  }
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`glm.mjs: ${String(e.stack || e)}\n`);
  process.exit(1);
});
