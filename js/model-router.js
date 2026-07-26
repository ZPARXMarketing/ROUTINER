/* ============================================================
   Dynamic model selection for Routiner.

   "Let my software choose the best model." A routine can pin a model or
   set model="auto" and let ROUTING_POLICY pick one from its task type +
   complexity — the data-driven version of the get_model_for_task prototype.

   Execution reality: scheduled routines run as Claude Code sessions on the
   Claude account that fires them, so AUTO routes among Claude models — that
   path needs no extra keys and always runs. OpenRouter models are also
   selectable (handy once you add an OpenRouter key, and for the live test);
   they're never sent to the Anthropic fire endpoint.

   Pure logic + thin OpenAI-/Anthropic-compatible clients for the live test.
   No DOM / app coupling — app.js imports what it needs.
   ============================================================ */

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';

/* Models offered in the picker. `auto` = let Routiner choose per task.
   Claude ids run as scheduled Claude Code sessions; OpenRouter ids are for
   the live test / future OpenRouter execution. */
export const MODELS = [
  { id: 'auto', label: 'Auto — let Routiner choose', auto: true },
  // Claude — these actually fire your scheduled routines.
  { id: 'claude-fable-5', label: 'Claude Fable 5 — newest flagship (Claude 5)' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 — most capable' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — balanced' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 — fast & cheap' },
  // OpenRouter — selectable; used by the live test (needs an OpenRouter key).
  { id: 'openrouter/auto', label: 'OpenRouter Auto — provider routes it' },
  { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol — flagship (OpenRouter)' },
  { id: 'openai/gpt-5.6-terra', label: 'GPT-5.6 Terra — balanced (OpenRouter)' },
  { id: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna — fast & cheap (OpenRouter)' },
  { id: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro — most capable Gemini (OpenRouter)' },
  { id: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash — near-Pro, cheaper (OpenRouter)' },
  { id: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash — cheapest Gemini (OpenRouter)' },
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat — cheap (OpenRouter)' },
  { id: 'moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code (OpenRouter)' },
  { id: 'moonshotai/kimi-k3', label: 'Kimi K3 — newest Kimi (OpenRouter)' },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B (OpenRouter)' },
  { id: 'z-ai/glm-4.7', label: 'GLM 4.7 — fast, cheap coding (OpenRouter)' },
  { id: 'z-ai/glm-5', label: 'GLM 5 — most capable GLM (OpenRouter)' },
  { id: 'z-ai/glm-5.2', label: 'GLM 5.2 — Zhipu / Z.ai, June 2026 (OpenRouter)' },
];

/* ---------- Cost estimation ----------
   USD per 1M tokens {in, out}. OpenAI/Gemini rates are the published July-2026
   OpenRouter prices; rows flagged `approx` are best-effort estimates — treat
   every number this file produces as a budgeting guide, not a bill. Claude ids
   fire as Claude Code sessions on your subscription, so their rows are the
   API-equivalent rates (useful for comparing, not billed per-token). */
export const MODEL_PRICING = {
  'claude-fable-5': { in: 5, out: 25, approx: true },
  'claude-opus-4-8': { in: 5, out: 25, approx: true },
  'claude-sonnet-5': { in: 3, out: 15, approx: true },
  'claude-haiku-4-5-20251001': { in: 1, out: 5, approx: true },
  'openai/gpt-5.6-sol': { in: 5, out: 30 },
  'openai/gpt-5.6-terra': { in: 2.5, out: 15 },
  'openai/gpt-5.6-luna': { in: 1, out: 6 },
  'google/gemini-3.1-pro-preview': { in: 2, out: 12 },
  'google/gemini-3.5-flash': { in: 1.5, out: 9 },
  'google/gemini-3-flash-preview': { in: 0.5, out: 3 },
  'deepseek/deepseek-chat': { in: 0.27, out: 1.1, approx: true },
  'moonshotai/kimi-k2.7-code': { in: 0.6, out: 2.5, approx: true },
  'moonshotai/kimi-k3': { in: 3, out: 15, approx: true },
  'meta-llama/llama-3.3-70b-instruct': { in: 0.1, out: 0.25, approx: true },
  'z-ai/glm-4.7': { in: 0.6, out: 2.2, approx: true },
  'z-ai/glm-5': { in: 1, out: 3.2, approx: true },
  'z-ai/glm-5.2': { in: 0.81, out: 2.56, approx: true },
};

/* Estimation knobs: ~4 chars/token for English prose; a routine run carries
   system/context overhead on top of its prompt, and we assume a mid-size
   response since real output length is unknowable before the run. */
export const EST = { charsPerTok: 4, inputOverheadTok: 1500, outputTokDefault: 2000 };
export const estimateTokens = (text) => Math.ceil(String(text || '').length / EST.charsPerTok);

/* Predict one run's cost for a routine (or any {prompt, model, taskType,
   complexity} shape). Returns { model, inTok, outTok, usd, approx } or null
   when the resolved model has no pricing row (e.g. openrouter/auto). */
export function estimateRunCost(routine = {}, policy) {
  const model = effectiveModel(routine, policy);
  const p = MODEL_PRICING[model];
  if (!p) return null;
  const inTok = estimateTokens(routine.prompt) + EST.inputOverheadTok;
  const outTok = EST.outputTokDefault;
  return { model, inTok, outTok, usd: (inTok * p.in + outTok * p.out) / 1e6, approx: !!p.approx };
}

/* Compact money formatting for estimates (sub-cent amounts keep precision). */
export function fmtUSD(v) {
  if (!Number.isFinite(v)) return '—';
  if (v >= 100) return `$${Math.round(v)}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

export const TASK_TYPES = [
  { id: 'general', label: 'General' },
  { id: 'planning', label: 'Planning' },
  { id: 'execution', label: 'Execution' },
];
export const COMPLEXITIES = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

export const DEFAULT_MODEL = 'auto';
export const DEFAULT_TASK_TYPE = 'general';
export const DEFAULT_COMPLEXITY = 'medium';
export const FALLBACK_MODEL = 'claude-sonnet-5';

/* The routing table — the get_model_for_task() decision, as data. Routes to
   Claude models because that's what executes scheduled routines today. Swap a
   row to an OpenRouter id once you wire an OpenRouter execution path.

   This is the DEFAULT/fallback. The live policy is per-user, stored in
   routiner_settings.model_policy and edited in Settings; setActivePolicy()
   applies it here and the scheduler reads the same row, so the two stay in sync
   without hand-editing. routiner-scheduler keeps an identical copy of this
   default as its own fallback — update both when the default changes.
   ⚠ Verify these ids are still accepted by the routine /fire endpoint before a
   release — model ids get retired; keep MODELS above in sync with any change. */
export const ROUTING_POLICY = {
  planning: {
    low: 'claude-sonnet-5',
    medium: 'claude-sonnet-5',
    high: 'claude-opus-4-8',        // hard planning → most capable
  },
  execution: {
    low: 'claude-haiku-4-5-20251001',
    medium: 'claude-haiku-4-5-20251001', // execution → fast & cheap
    high: 'claude-sonnet-5',
  },
  general: {
    low: 'claude-haiku-4-5-20251001',
    medium: 'claude-sonnet-5',
    high: 'claude-opus-4-8',
  },
};

/* The same decision for **openrouter-agent** accounts, whose runs never touch
   Anthropic — so every cell is an OpenRouter id. Used only when neither the
   routine nor the agent instance pins a model, i.e. as a floor, not an override.
   Kimi K3 is the reach-for-it model on hard work, GLM 5.2 carries the ordinary
   coding load, and the cheap models take mechanical steps.
   ⚠ Mirrored as AGENT_ROUTING_POLICY in
   supabase/functions/routiner-scheduler/index.ts — update both together. */
export const AGENT_ROUTING_POLICY = {
  planning: {
    low: 'z-ai/glm-5.2',
    medium: 'z-ai/glm-5.2',
    high: 'moonshotai/kimi-k3',
  },
  execution: {
    low: 'deepseek/deepseek-chat',
    medium: 'z-ai/glm-5.2',
    high: 'moonshotai/kimi-k3',
  },
  general: {
    low: 'deepseek/deepseek-chat',
    medium: 'z-ai/glm-5.2',
    high: 'moonshotai/kimi-k3',
  },
};
export const DEFAULT_AGENT_MODEL = 'moonshotai/kimi-k2.7-code';

/* An agent routine's auto-routed model from its task type + complexity. */
export function agentModelForTask(taskType = DEFAULT_TASK_TYPE, complexity = DEFAULT_COMPLEXITY) {
  const row = AGENT_ROUTING_POLICY[taskType] || AGENT_ROUTING_POLICY[DEFAULT_TASK_TYPE];
  return row[complexity] || row[DEFAULT_COMPLEXITY] || DEFAULT_AGENT_MODEL;
}

/* Validate a stored/loaded policy into the ROUTING_POLICY shape. Returns a
   normalized copy, or null if it isn't usable (so callers fall back to the
   built-in default). Every task_type × complexity cell must be a non-empty
   string; missing cells are filled from ROUTING_POLICY so a partial policy is
   still safe. */
export function normalizePolicy(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  let anyValid = false;
  for (const tt of TASK_TYPES.map((t) => t.id)) {
    const src = raw[tt] && typeof raw[tt] === 'object' ? raw[tt] : {};
    out[tt] = {};
    for (const cx of COMPLEXITIES.map((c) => c.id)) {
      const v = typeof src[cx] === 'string' && src[cx].trim() ? src[cx].trim() : ROUTING_POLICY[tt][cx];
      if (typeof src[cx] === 'string' && src[cx].trim()) anyValid = true;
      out[tt][cx] = v;
    }
  }
  return anyValid ? out : null;
}

/* The policy currently in effect for auto-routing. Defaults to the built-in
   ROUTING_POLICY; the app calls setActivePolicy() with the user's saved policy
   (routiner_settings.model_policy) on load so previews/cards match what the
   scheduler will fire. */
let activePolicy = ROUTING_POLICY;
export function setActivePolicy(raw) { activePolicy = normalizePolicy(raw) || ROUTING_POLICY; }
export function getActivePolicy() { return activePolicy; }

/* Is this an Anthropic/Claude model (vs. an OpenRouter id)? */
export const isClaudeModel = (id) => /^claude-/i.test(id || '');

/* The prototype's get_model_for_task(), data-driven. */
export function getModelForTask(taskType = DEFAULT_TASK_TYPE, complexity = DEFAULT_COMPLEXITY, policy = activePolicy) {
  const row = policy[taskType] || policy[DEFAULT_TASK_TYPE] || {};
  return row[complexity] || row[DEFAULT_COMPLEXITY] || FALLBACK_MODEL;
}

/* A routine's *effective* model: an explicit pick wins; otherwise auto-route
   from its task type + complexity. Accepts camelCase or snake_case. */
export function effectiveModel(routine = {}, policy = activePolicy) {
  const m = routine.model || DEFAULT_MODEL;
  if (m && m !== 'auto') return m;
  return getModelForTask(
    routine.taskType ?? routine.task_type ?? DEFAULT_TASK_TYPE,
    routine.complexity ?? DEFAULT_COMPLEXITY,
    policy,
  );
}

/* Short display name for a model id (handles catalog + legacy/unknown ids). */
export function modelLabel(id) {
  const m = MODELS.find((x) => x.id === id);
  return m ? m.label.split(' — ')[0] : id;
}

/* What the card/preview shows: the resolved model, flagged when auto-chosen. */
export function displayModel(routine = {}, policy = activePolicy) {
  const eff = effectiveModel(routine, policy);
  const isAuto = !routine.model || routine.model === 'auto';
  return isAuto ? `Auto · ${modelLabel(eff)}` : modelLabel(eff);
}

/* ---------- Live-test clients (optional; preview a prompt on a model) ---------- */

/* OpenAI-compatible call to OpenRouter. */
export async function runViaOpenRouter(prompt, model, apiKey, opts = {}) {
  if (!apiKey) return { status: 'dryrun', text: 'No OpenRouter key set — add one in Settings to preview prompts on OpenRouter models.' };
  try {
    const resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(opts.referer ? { 'HTTP-Referer': opts.referer } : {}),
        ...(opts.title ? { 'X-Title': opts.title } : {}),
      },
      body: JSON.stringify({ model: model || 'openrouter/auto', max_tokens: opts.maxTokens || 2048, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await resp.json();
    if (!resp.ok) return { status: 'error', text: data?.error?.message || `HTTP ${resp.status}` };
    return { status: 'success', text: (data?.choices?.[0]?.message?.content || '').trim() || '(empty)', model: data?.model || model };
  } catch (e) { return { status: 'error', text: 'Request failed: ' + e.message }; }
}

/* Anthropic Messages API (browser, for Claude model previews). */
export async function runViaAnthropic(prompt, model, apiKey, opts = {}) {
  if (!apiKey) return { status: 'dryrun', text: 'No Anthropic key set — add one in Settings to preview prompts on Claude models. (Optional; not needed for scheduling.)' };
  try {
    const resp = await fetch(`${ANTHROPIC_BASE}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: model || FALLBACK_MODEL, max_tokens: opts.maxTokens || 2048, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await resp.json();
    if (!resp.ok) return { status: 'error', text: data?.error?.message || `HTTP ${resp.status}` };
    return { status: 'success', text: (data.content || []).map((b) => b.text || '').join('\n').trim() || '(empty)', model: data?.model || model };
  } catch (e) { return { status: 'error', text: 'Request failed: ' + e.message }; }
}

/* Pick the right provider for a model id and run the prompt. */
export function runModel(prompt, model, keys = {}, opts = {}) {
  return isClaudeModel(model)
    ? runViaAnthropic(prompt, model, (keys.anthropic || '').trim(), opts)
    : runViaOpenRouter(prompt, model, (keys.openrouter || '').trim(), opts);
}

/* ---------- Multi-turn chat (the Chat tab) ----------
   Same providers as the live test, but takes a whole conversation:
   messages = [{ role: 'user'|'assistant', content }]. */
export async function chatViaOpenRouter(messages, model, apiKey, opts = {}) {
  if (!apiKey) return { status: 'dryrun', text: 'No OpenRouter key set — add one in Settings → Advanced to chat with OpenRouter models.' };
  try {
    const resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(opts.referer ? { 'HTTP-Referer': opts.referer } : {}),
        ...(opts.title ? { 'X-Title': opts.title } : {}),
      },
      body: JSON.stringify({ model: model || 'openrouter/auto', max_tokens: opts.maxTokens || 2048, messages }),
    });
    const data = await resp.json();
    if (!resp.ok) return { status: 'error', text: data?.error?.message || `HTTP ${resp.status}` };
    return { status: 'success', text: (data?.choices?.[0]?.message?.content || '').trim() || '(empty)', model: data?.model || model };
  } catch (e) { return { status: 'error', text: 'Request failed: ' + e.message }; }
}

export async function chatViaAnthropic(messages, model, apiKey, opts = {}) {
  if (!apiKey) return { status: 'dryrun', text: 'No Anthropic key set — add one in Settings → Advanced to chat with Claude models.' };
  try {
    const resp = await fetch(`${ANTHROPIC_BASE}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: model || FALLBACK_MODEL, max_tokens: opts.maxTokens || 2048, messages }),
    });
    const data = await resp.json();
    if (!resp.ok) return { status: 'error', text: data?.error?.message || `HTTP ${resp.status}` };
    return { status: 'success', text: (data.content || []).map((b) => b.text || '').join('\n').trim() || '(empty)', model: data?.model || model };
  } catch (e) { return { status: 'error', text: 'Request failed: ' + e.message }; }
}

export function runChat(messages, model, keys = {}, opts = {}) {
  return isClaudeModel(model)
    ? chatViaAnthropic(messages, model, (keys.anthropic || '').trim(), opts)
    : chatViaOpenRouter(messages, model, (keys.openrouter || '').trim(), opts);
}
