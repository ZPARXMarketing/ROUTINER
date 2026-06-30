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
  { id: 'auto', label: '✨ Auto — let Routiner choose', auto: true },
  // Claude — these actually fire your scheduled routines.
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 — most capable' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 — balanced' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 — fast & cheap' },
  // OpenRouter — selectable; used by the live test (needs an OpenRouter key).
  { id: 'openrouter/auto', label: 'OpenRouter Auto — provider routes it' },
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat — cheap (OpenRouter)' },
  { id: 'moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code (OpenRouter)' },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B (OpenRouter)' },
  { id: 'z-ai/glm-4.7', label: 'GLM 4.7 — fast, cheap coding (OpenRouter)' },
  { id: 'z-ai/glm-5', label: 'GLM 5 — most capable (OpenRouter)' },
];

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
export const FALLBACK_MODEL = 'claude-sonnet-4-6';

/* The routing table — the get_model_for_task() decision, as data. Routes to
   Claude models because that's what executes scheduled routines today. Swap a
   row to an OpenRouter id once you wire an OpenRouter execution path. */
export const ROUTING_POLICY = {
  planning: {
    low: 'claude-sonnet-4-6',
    medium: 'claude-sonnet-4-6',
    high: 'claude-opus-4-8',        // hard planning → most capable
  },
  execution: {
    low: 'claude-haiku-4-5-20251001',
    medium: 'claude-haiku-4-5-20251001', // execution → fast & cheap
    high: 'claude-sonnet-4-6',
  },
  general: {
    low: 'claude-haiku-4-5-20251001',
    medium: 'claude-sonnet-4-6',
    high: 'claude-opus-4-8',
  },
};

/* Is this an Anthropic/Claude model (vs. an OpenRouter id)? */
export const isClaudeModel = (id) => /^claude-/i.test(id || '');

/* The prototype's get_model_for_task(), data-driven. */
export function getModelForTask(taskType = DEFAULT_TASK_TYPE, complexity = DEFAULT_COMPLEXITY, policy = ROUTING_POLICY) {
  const row = policy[taskType] || policy[DEFAULT_TASK_TYPE] || {};
  return row[complexity] || row[DEFAULT_COMPLEXITY] || FALLBACK_MODEL;
}

/* A routine's *effective* model: an explicit pick wins; otherwise auto-route
   from its task type + complexity. Accepts camelCase or snake_case. */
export function effectiveModel(routine = {}, policy = ROUTING_POLICY) {
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
export function displayModel(routine = {}, policy = ROUTING_POLICY) {
  const eff = effectiveModel(routine, policy);
  const isAuto = !routine.model || routine.model === 'auto';
  return isAuto ? `✨ ${modelLabel(eff)}` : modelLabel(eff);
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
