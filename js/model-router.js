/* ============================================================
   Dynamic model selection (OpenRouter-backed) for Routiner.

   This is the "let my software choose the best model" brain. It's a
   straight, data-driven version of the get_model_for_task() prototype:
   a routine can pin a specific OpenRouter model, or set model = "auto"
   and let ROUTING_POLICY pick one from its task type + complexity.

   Pure logic + a thin OpenAI-compatible client (OpenRouter speaks the
   OpenAI API). No DOM / app coupling — app.js imports what it needs.
   ============================================================ */

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/* Models offered in the picker (OpenRouter ids). `auto` = let Routiner
   choose per task; `openrouter/auto` = hand the choice to OpenRouter. */
export const MODELS = [
  { id: 'auto', label: '✨ Auto — let Routiner choose', auto: true },
  { id: 'openrouter/auto', label: 'OpenRouter Auto — provider routes it' },
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat — cheap planning' },
  { id: 'moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code — deep planning' },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B — execution' },
  { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5 — balanced' },
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
export const FALLBACK_MODEL = 'openrouter/auto';

/* The routing table — the get_model_for_task() decision, as data so it's
   trivial to tweak without touching logic. taskType → complexity → model. */
export const ROUTING_POLICY = {
  planning: {
    low: 'deepseek/deepseek-chat',
    medium: 'moonshotai/kimi-k2.7-code',
    high: 'moonshotai/kimi-k2.7-code',
  },
  execution: {
    low: 'meta-llama/llama-3.3-70b-instruct',
    medium: 'meta-llama/llama-3.3-70b-instruct',
    high: 'meta-llama/llama-3.3-70b-instruct',
  },
  general: {
    low: 'openrouter/auto',
    medium: 'openrouter/auto',
    high: 'openrouter/auto',
  },
};

/* The prototype's get_model_for_task(), data-driven. */
export function getModelForTask(taskType = DEFAULT_TASK_TYPE, complexity = DEFAULT_COMPLEXITY, policy = ROUTING_POLICY) {
  const row = policy[taskType] || policy[DEFAULT_TASK_TYPE] || {};
  return row[complexity] || row[DEFAULT_COMPLEXITY] || FALLBACK_MODEL;
}

/* A routine's *effective* model: an explicit pick wins; otherwise auto-route
   from its task type + complexity. Accepts either camelCase (app objects) or
   snake_case (raw DB rows). */
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

/* What the card/preview shows for a routine: the resolved model, and when it
   was auto-chosen, surface that it came from Auto. */
export function displayModel(routine = {}, policy = ROUTING_POLICY) {
  const eff = effectiveModel(routine, policy);
  const isAuto = !routine.model || routine.model === 'auto';
  return isAuto ? `✨ ${modelLabel(eff)}` : modelLabel(eff);
}

/* Thin OpenAI-compatible call to OpenRouter — used for the in-app live test
   and prompt preview on whichever model was selected/auto-routed. */
export async function runViaOpenRouter(prompt, model, apiKey, opts = {}) {
  if (!apiKey) return { status: 'dryrun', text: 'No OpenRouter key set — add one in Settings to run/preview prompts live. (Optional; not needed for scheduling.)' };
  try {
    const resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(opts.referer ? { 'HTTP-Referer': opts.referer } : {}),
        ...(opts.title ? { 'X-Title': opts.title } : {}),
      },
      body: JSON.stringify({
        model: model || FALLBACK_MODEL,
        max_tokens: opts.maxTokens || 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) return { status: 'error', text: data?.error?.message || `HTTP ${resp.status}` };
    const text = (data?.choices?.[0]?.message?.content || '').trim() || '(empty)';
    return { status: 'success', text, model: data?.model || model };
  } catch (e) {
    return { status: 'error', text: 'Request failed: ' + e.message };
  }
}
