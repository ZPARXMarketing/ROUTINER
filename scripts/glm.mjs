#!/usr/bin/env node
// Routiner — GLM / OpenRouter offload helper (one command, zero deps).
//
// A routine session has NO OpenRouter key in its env; the key lives in Supabase
// edge secrets and is used only by the `dynamic-responder` proxy. This wraps the
// proxy call so a routine can offload a cheap coding sub-task in ONE line instead
// of pasting a multi-line curl + jq each time — with consistent model defaults
// and spend attribution, and clear diagnostics when the call can't get through.
//
// Usage:
//   node scripts/glm.mjs "Write a regex for E.164 phone numbers. Output only it."
//   echo "<long prompt>" | node scripts/glm.mjs            # prompt from stdin
//   node scripts/glm.mjs --model z-ai/glm-5 "<hard sub-task>"
//   node scripts/glm.mjs --max-tokens 2048 --system "You are terse." "<prompt>"
//   node scripts/glm.mjs --ping                            # end-to-end self-test
//   node scripts/glm.mjs --json "<prompt>"                 # raw proxy envelope
//
// On success it prints ONLY the model's text to stdout (so it composes in a
// pipeline). Diagnostics go to stderr. Exit code is non-zero on any failure.
//
// Env (all optional):
//   ROUTINER_PROXY_URL   override the dynamic-responder endpoint
//   ROUTINER_ACCOUNT     spend attribution (default: sparks9679)
//   ROUTINER_TRIGGER     spend attribution (default: t_a)

const PROXY_URL = process.env.ROUTINER_PROXY_URL ||
  "https://vonfdzttupyemtomsojy.supabase.co/functions/v1/dynamic-responder";
const USAGE_URL = process.env.ROUTINER_USAGE_URL ||
  "https://vonfdzttupyemtomsojy.supabase.co/functions/v1/openrouter-usage";
const ACCOUNT = process.env.ROUTINER_ACCOUNT || "sparks9679";
const TRIGGER = process.env.ROUTINER_TRIGGER || "t_a";
const DEFAULT_MODEL = "z-ai/glm-4.7"; // the documented coding default (fast & cheap)

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flagsWithValue = new Set(["--model", "--max-tokens", "--system"]);
// Everything that isn't a known flag (or a known flag's value) is the prompt.
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--ping" || a === "--json") continue;
  if (flagsWithValue.has(a)) { i++; continue; }
  if (a.startsWith("--")) continue;
  positional.push(a);
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}

// A POST to the proxy. Returns the parsed envelope, or throws with a message that
// distinguishes "couldn't reach the host" (the usual egress block) from API errors.
async function callProxy(body) {
  let resp;
  try {
    resp = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(
      `could not reach the proxy at ${PROXY_URL}\n` +
      `  (${e.cause?.code || e.message}) — this is almost always the routine ` +
      `environment's network policy blocking supabase.co.\n` +
      `  Allow that host in the environment's egress settings, then retry.`,
    );
  }
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!resp.ok || data?.ok === false) {
    throw new Error(`proxy returned HTTP ${resp.status}: ${data?.error || text}`);
  }
  return data;
}

async function runPrompt() {
  const argPrompt = positional.join(" ").trim();
  const prompt = argPrompt || (await readStdin());
  if (!prompt) {
    process.stderr.write("error: no prompt (pass it as an argument or on stdin)\n");
    process.exit(2);
  }
  const body = {
    prompt,
    model: val("--model", DEFAULT_MODEL),
    max_tokens: Math.max(Number(val("--max-tokens", "1024")) || 1024, 256),
    account: ACCOUNT,
    trigger_key: TRIGGER,
  };
  if (has("--system")) body.system = val("--system", "");

  const data = await callProxy(body);
  if (has("--json")) { process.stdout.write(JSON.stringify(data, null, 2) + "\n"); return; }
  const content = (data.content || "").trim();
  if (!content || content === "(empty)") {
    process.stderr.write(
      "warning: model returned no text (budget spent before output). " +
      "Raise --max-tokens (>=512) and/or add 'Output only the answer.' to the prompt.\n",
    );
    process.exit(1);
  }
  process.stdout.write(content + "\n");
  process.stderr.write(`\n[ok] ${data.model} · ${data.usage?.total_tokens ?? "?"} tok` +
    (data.usage?.cost != null ? ` · $${Number(data.usage.cost).toFixed(5)}` : "") + "\n");
}

// End-to-end self-test: make a trivial call, then confirm a usage row actually
// landed in the ledger. This is the on-demand green-light the setup was missing.
async function ping() {
  const stamp = `ping ${Date.now()}`;
  process.stderr.write(`[ping] POST ${PROXY_URL}\n`);
  const data = await callProxy({
    prompt: `Reply with exactly: pong (${stamp}). Output only that.`,
    model: DEFAULT_MODEL, max_tokens: 256, account: ACCOUNT, trigger_key: TRIGGER,
  });
  process.stderr.write(`[ping] proxy ok — model=${data.model} content=${JSON.stringify(data.content)}\n`);

  // Give the best-effort logging a moment, then check the ledger moved.
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const u = await (await fetch(USAGE_URL, { headers: { accept: "application/json" } })).json();
    const calls = u?.totals?.today?.calls ?? u?.totals?.lifetime?.calls ?? null;
    process.stderr.write(
      `[ping] usage meter reachable — today.calls=${u?.totals?.today?.calls ?? "?"}, ` +
      `credit_remaining=${u?.key?.limit_remaining ?? "?"}\n`,
    );
    process.stderr.write(
      calls
        ? `[ping] PASS — proxy works and the usage ledger is recording calls.\n`
        : `[ping] PARTIAL — proxy answered but no usage rows yet; check that ` +
          `dynamic-responder has SUPABASE_SERVICE_ROLE_KEY and was redeployed.\n`,
    );
  } catch {
    process.stderr.write(`[ping] proxy works, but couldn't read the usage meter to confirm logging.\n`);
  }
}

(has("--ping") ? ping() : runPrompt()).catch((e) => {
  process.stderr.write(`error: ${e.message}\n`);
  process.exit(1);
});
