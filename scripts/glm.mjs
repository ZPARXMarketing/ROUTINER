#!/usr/bin/env node
// Routiner — GLM / OpenRouter proxy CLI.
//
// Thin wrapper around the `dynamic-responder` Supabase edge function (the
// OpenRouter proxy). The proxy holds the OPENROUTER_API_KEY in Supabase edge
// secrets, so no key is needed here — a routine session POSTs a prompt and gets
// the model's text back. See ROUTINER's CLAUDE.md ("Offloading cheap work to
// OpenRouter") for the full contract.
//
// Zero dependencies. Node 18+ (global fetch).
//
// Usage:
//   node scripts/glm.mjs --ping                  # health-check the proxy, exit 0/1
//   node scripts/glm.mjs "summarize this: ..."   # send a prompt, print the reply
//   node scripts/glm.mjs --model z-ai/glm-5 "hard task..."
//   node scripts/glm.mjs --max-tokens 2048 "..."
//   node scripts/glm.mjs --json "..."            # raw JSON response, then exit
//
// Options:
//   --ping                 send a tiny prompt and report proxy health (default
//                          if no prompt is given)
//   --model <id>           model id (default z-ai/glm-4.7, the coding default)
//   --max-tokens <n>       completion budget (default 1024; ping uses 512)
//   --account <a>          spend attribution (default sparks9679)
//   --trigger-key <k>      spend attribution (default A)
//   --json                 print the raw JSON response and exit
//   --url <u>              override the proxy endpoint
//
// Endpoint resolution (first that is set):
//   --url <u>  |  $ROUTINER_RESPONDER_URL  |  the project default below.

const DEFAULT_URL =
  "https://vonfdzttupyemtomsojy.supabase.co/functions/v1/dynamic-responder";

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
// first non-flag, non-flag-value token is the prompt
const flagsWithValue = new Set([
  "--model",
  "--max-tokens",
  "--account",
  "--trigger-key",
  "--url",
]);
let prompt = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (flagsWithValue.has(a)) {
    i++; // skip its value
    continue;
  }
  if (a.startsWith("--")) continue;
  prompt = a;
  break;
}

const opts = {
  url: val("--url", process.env.ROUTINER_RESPONDER_URL || DEFAULT_URL),
  model: val("--model", "z-ai/glm-4.7"),
  maxTokens: Number(val("--max-tokens", "")) || null,
  account: val("--account", "sparks9679"),
  triggerKey: val("--trigger-key", "A"),
  jsonOut: has("--json"),
  ping: has("--ping") || prompt === null,
};

// ── color (auto-off when not a TTY) ──────────────────────────────────────────
const plain = !process.stdout.isTTY;
const c = (code) => (s) => (plain ? s : `\x1b[${code}m${s}\x1b[0m`);
const green = c("38;2;200;255;69");
const red = c("38;2;255;77;94");
const cyan = c("38;2;60;230;255");
const grey = c("38;2;124;135;158");
const bold = (s) => (plain ? s : `\x1b[1m${s}\x1b[0m`);

const usd = (n) => `$${(Number(n) || 0).toFixed(6)}`;

async function call({ model, prompt, maxTokens }) {
  const started = Date.now();
  const res = await fetch(opts.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      account: opts.account,
      trigger_key: opts.triggerKey,
      prompt,
    }),
  });
  const ms = Date.now() - started;
  let body;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = { ok: false, error: `non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}` };
  }
  return { httpStatus: res.status, ms, body };
}

async function main() {
  if (opts.ping) {
    const { httpStatus, ms, body } = await call({
      model: opts.model,
      prompt:
        "Reply with the single word PONG and nothing else. Output only the answer.",
      maxTokens: opts.maxTokens || 512,
    }).catch((e) => ({ httpStatus: 0, ms: 0, body: { ok: false, error: String(e && e.message || e) } }));

    if (opts.jsonOut) {
      console.log(JSON.stringify({ httpStatus, ms, ...body }, null, 2));
      process.exit(body && body.ok ? 0 : 1);
    }

    const healthy = Boolean(body && body.ok);
    const tag = healthy ? green("● UP  ") : red("● DOWN");
    const model = (body && body.model) || opts.model;
    const cost = body && body.usage ? usd(body.usage.cost) : "—";
    const reply = body && typeof body.content === "string" ? body.content : "";
    console.log(`${tag} ${bold("GLM proxy")} ${grey("(" + opts.url.replace(/^https?:\/\//, "") + ")")}`);
    if (healthy) {
      console.log(
        `      ${cyan(model)}  ${grey(ms + "ms")}  cost ${cost}` +
          (reply && reply !== "(empty)" ? `  reply ${grey(JSON.stringify(reply.slice(0, 40)))}` : "")
      );
    } else {
      console.log(`      ${red("error:")} ${(body && body.error) || "HTTP " + httpStatus}`);
    }
    process.exit(healthy ? 0 : 1);
  }

  // arbitrary prompt
  const { httpStatus, ms, body } = await call({
    model: opts.model,
    prompt,
    maxTokens: opts.maxTokens || 1024,
  });
  if (opts.jsonOut) {
    console.log(JSON.stringify({ httpStatus, ms, ...body }, null, 2));
    process.exit(body && body.ok ? 0 : 1);
  }
  if (body && body.ok) {
    process.stdout.write((body.content || "") + "\n");
    process.exit(0);
  }
  console.error(red("glm: ") + ((body && body.error) || "HTTP " + httpStatus));
  process.exit(1);
}

main().catch((e) => {
  console.error(red("glm: ") + String((e && e.message) || e));
  process.exit(1);
});
