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

/* ---------- The model catalog ----------
   One table, grouped by the lab that makes the models, with three tiers each
   (flagship / balanced / fast). Everything the app needs to show a model —
   its name, its slug, what a million tokens cost, and what color it wears on
   the calendar — is a property of the catalog row, so nothing has to be typed
   in by hand and nothing has to be kept in sync across three files.

   Two identities, and the difference is load-bearing:
     • `key`  — how Routiner refers to a model forever ("openai.flagship").
                Preferences (a renamed slug, a recolored block) hang off this.
     • `slug` — what actually gets sent to the provider. Labs rename and retire
                these, so a slug is EDITABLE in Settings → Models. Keying prefs
                on the slug would mean renaming a model threw away its color.

   A routine stores the *slug* it was saved with (that is what runs), so an old
   routine keeps running the model it was pinned to even after the catalog row
   it came from has been pointed somewhere new. Lookups therefore always try
   the live slug first, then the shipped default. */

export const MODEL_TIERS = [
  { id: 'flagship', label: 'Flagship', note: 'most capable' },
  { id: 'balanced', label: 'Balanced', note: 'the everyday pick' },
  { id: 'fast', label: 'Fast', note: 'cheap and quick' },
];
export const TIER_LABEL = Object.fromEntries(MODEL_TIERS.map((t) => [t.id, t.label]));

/* Prices are USD per 1M tokens {in, out}. `approx: true` marks a best-effort
   number — treat every figure this file produces as a budgeting guide, not a
   bill. Claude rows fire as Claude Code sessions on your subscription, so they
   are API-equivalent rates: useful for comparing, not billed per token.

   Colors are the DEFAULT calendar color for that model — one hue family per
   lab, brightest at the top tier — and every one of them is overridable in
   Settings → Models. */
export const MODEL_LABS = [
  { id: 'anthropic', name: 'Anthropic', origin: 'US', via: 'claude', models: [
    { key: 'anthropic.flagship', slug: 'claude-opus-4-8', tier: 'flagship', name: 'Claude Opus 4.8', in: 5, out: 25, approx: true, color: '#FF7A33' },
    { key: 'anthropic.balanced', slug: 'claude-sonnet-5', tier: 'balanced', name: 'Claude Sonnet 5', in: 3, out: 15, approx: true, color: '#FF9E2C' },
    { key: 'anthropic.fast', slug: 'claude-haiku-4-5-20251001', tier: 'fast', name: 'Claude Haiku 4.5', in: 1, out: 5, approx: true, color: '#FFC08A' },
    // Kept alongside the three tiers: routines already pinned to it must not
    // lose their model just because the catalog settled on three rows.
    { key: 'anthropic.fable', slug: 'claude-fable-5', tier: 'flagship', name: 'Claude Fable 5', in: 5, out: 25, approx: true, color: '#E8631C' },
  ] },
  { id: 'openai', name: 'OpenAI', origin: 'US', models: [
    { key: 'openai.flagship', slug: 'openai/gpt-5.6-sol', tier: 'flagship', name: 'GPT-5.6 Sol', in: 5, out: 30, color: '#2EE6A6' },
    { key: 'openai.balanced', slug: 'openai/gpt-5.6-terra', tier: 'balanced', name: 'GPT-5.6 Terra', in: 2.5, out: 15, color: '#3DDC97' },
    { key: 'openai.fast', slug: 'openai/gpt-5.6-luna', tier: 'fast', name: 'GPT-5.6 Luna', in: 1, out: 6, color: '#8FE9C6' },
  ] },
  { id: 'google', name: 'Google', origin: 'US', models: [
    { key: 'google.flagship', slug: 'google/gemini-3.1-pro-preview', tier: 'flagship', name: 'Gemini 3.1 Pro', in: 2, out: 12, color: '#4D6BFF' },
    { key: 'google.balanced', slug: 'google/gemini-3.5-flash', tier: 'balanced', name: 'Gemini 3.5 Flash', in: 1.5, out: 9, color: '#4DA6FF' },
    { key: 'google.fast', slug: 'google/gemini-3-flash-preview', tier: 'fast', name: 'Gemini 3 Flash', in: 0.5, out: 3, color: '#8FB6FF' },
  ] },
  { id: 'xai', name: 'xAI', origin: 'US', models: [
    { key: 'xai.flagship', slug: 'x-ai/grok-4', tier: 'flagship', name: 'Grok 4', in: 3, out: 15, approx: true, color: '#FF4D8D' },
    { key: 'xai.balanced', slug: 'x-ai/grok-4-fast', tier: 'balanced', name: 'Grok 4 Fast', in: 0.2, out: 0.5, approx: true, color: '#FF7AA8' },
    { key: 'xai.fast', slug: 'x-ai/grok-code-fast-1', tier: 'fast', name: 'Grok Code Fast', in: 0.2, out: 1.5, approx: true, color: '#FFAFC9' },
  ] },
  { id: 'meta', name: 'Meta', origin: 'US', models: [
    { key: 'meta.flagship', slug: 'meta-llama/llama-4-maverick', tier: 'flagship', name: 'Llama 4 Maverick', in: 0.22, out: 0.85, approx: true, color: '#7C6BFF' },
    { key: 'meta.balanced', slug: 'meta-llama/llama-4-scout', tier: 'balanced', name: 'Llama 4 Scout', in: 0.08, out: 0.3, approx: true, color: '#9B8CFF' },
    { key: 'meta.fast', slug: 'meta-llama/llama-3.3-70b-instruct', tier: 'fast', name: 'Llama 3.3 70B', in: 0.1, out: 0.25, approx: true, color: '#C0B6FF' },
  ] },
  { id: 'mistral', name: 'Mistral', origin: 'EU', models: [
    { key: 'mistral.flagship', slug: 'mistralai/mistral-large-2411', tier: 'flagship', name: 'Mistral Large', in: 2, out: 6, approx: true, color: '#F5D33B' },
    { key: 'mistral.balanced', slug: 'mistralai/mistral-medium-3', tier: 'balanced', name: 'Mistral Medium 3', in: 0.4, out: 2, approx: true, color: '#FFDF6E' },
    { key: 'mistral.fast', slug: 'mistralai/mistral-small-3.2-24b-instruct', tier: 'fast', name: 'Mistral Small 3.2', in: 0.05, out: 0.1, approx: true, color: '#FFEBA3' },
  ] },
  { id: 'deepseek', name: 'DeepSeek', origin: 'China', models: [
    { key: 'deepseek.flagship', slug: 'deepseek/deepseek-r1', tier: 'flagship', name: 'DeepSeek R1', in: 0.45, out: 2.15, approx: true, color: '#B57BFF' },
    { key: 'deepseek.balanced', slug: 'deepseek/deepseek-chat', tier: 'balanced', name: 'DeepSeek Chat', in: 0.27, out: 1.1, approx: true, color: '#C9A0FF' },
    { key: 'deepseek.fast', slug: 'deepseek/deepseek-chat-v3.1', tier: 'fast', name: 'DeepSeek v3.1', in: 0.2, out: 0.8, approx: true, color: '#DEC6FF' },
  ] },
  { id: 'moonshot', name: 'Moonshot (Kimi)', origin: 'China', models: [
    { key: 'moonshot.flagship', slug: 'moonshotai/kimi-k3', tier: 'flagship', name: 'Kimi K3', in: 3, out: 15, approx: true, color: '#22D3EE' },
    { key: 'moonshot.balanced', slug: 'moonshotai/kimi-k2.7-code', tier: 'balanced', name: 'Kimi K2.7 Code', in: 0.6, out: 2.5, approx: true, color: '#67E3F5' },
    { key: 'moonshot.fast', slug: 'moonshotai/kimi-k2', tier: 'fast', name: 'Kimi K2', in: 0.3, out: 1.2, approx: true, color: '#A6EEFA' },
  ] },
  { id: 'zai', name: 'Z.ai (Zhipu)', origin: 'China', models: [
    { key: 'zai.flagship', slug: 'z-ai/glm-5.2', tier: 'flagship', name: 'GLM 5.2', in: 0.81, out: 2.56, approx: true, color: '#BCEF2F' },
    { key: 'zai.balanced', slug: 'z-ai/glm-5', tier: 'balanced', name: 'GLM 5', in: 1, out: 3.2, approx: true, color: '#D2F56E' },
    { key: 'zai.fast', slug: 'z-ai/glm-4.7', tier: 'fast', name: 'GLM 4.7', in: 0.6, out: 2.2, approx: true, color: '#E4FAA8' },
  ] },
  { id: 'qwen', name: 'Alibaba (Qwen)', origin: 'China', models: [
    { key: 'qwen.flagship', slug: 'qwen/qwen3-max', tier: 'flagship', name: 'Qwen3 Max', in: 1.2, out: 6, approx: true, color: '#FF6B5A' },
    { key: 'qwen.balanced', slug: 'qwen/qwen3-235b-a22b', tier: 'balanced', name: 'Qwen3 235B', in: 0.2, out: 0.6, approx: true, color: '#FF9385' },
    { key: 'qwen.fast', slug: 'qwen/qwen3-coder', tier: 'fast', name: 'Qwen3 Coder', in: 0.2, out: 0.8, approx: true, color: '#FFBDB4' },
  ] },
  { id: 'minimax', name: 'MiniMax', origin: 'China', models: [
    { key: 'minimax.flagship', slug: 'minimax/minimax-m2', tier: 'flagship', name: 'MiniMax M2', in: 0.3, out: 1.2, approx: true, color: '#D9A441' },
    { key: 'minimax.balanced', slug: 'minimax/minimax-m1', tier: 'balanced', name: 'MiniMax M1', in: 0.3, out: 1.65, approx: true, color: '#E8C173' },
    { key: 'minimax.fast', slug: 'minimax/minimax-01', tier: 'fast', name: 'MiniMax 01', in: 0.2, out: 1.1, approx: true, color: '#F2DCAC' },
  ] },
];

/* The two routing pseudo-models. Neither is a real slug you can price: `auto`
   is Routiner's own routing table, `openrouter/auto` hands the choice to
   OpenRouter. They live outside the labs so a lab always means three tiers. */
export const AUTO_MODEL = { key: 'auto', slug: 'auto', name: 'Auto — let Routiner choose', auto: true };
export const OPENROUTER_AUTO = { key: 'openrouter.auto', slug: 'openrouter/auto', name: 'OpenRouter Auto — provider routes it', auto: true };

/* ---------- Per-user model preferences ----------
   `{ slugs: { <key>: 'new/slug' }, colors: { <key>: '#RRGGBB' } }`, stored in
   routiner_settings.model_prefs and edited in Settings → Models. Applied here
   so every caller — pickers, calendar, cost estimates — sees one resolved
   catalog and no caller has to remember the prefs exist. */
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const SLUG_RE = /^[A-Za-z0-9._:\/-]{2,120}$/;
let modelPrefs = { slugs: {}, colors: {} };

/* Keep only entries that name a real catalog row and carry a usable value — a
   stale key from an older catalog, or a half-typed slug, must not be able to
   break a picker. */
export function normalizeModelPrefs(raw) {
  const known = new Set(DEFAULT_CATALOG.map((m) => m.key));
  const out = { slugs: {}, colors: {} };
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const [k, v] of Object.entries(src.slugs || {})) {
    if (known.has(k) && typeof v === 'string' && SLUG_RE.test(v.trim())) out.slugs[k] = v.trim();
  }
  for (const [k, v] of Object.entries(src.colors || {})) {
    if (known.has(k) && typeof v === 'string' && HEX_RE.test(v.trim())) out.colors[k] = v.trim().toUpperCase();
  }
  return out;
}
export function setModelPrefs(raw) { modelPrefs = normalizeModelPrefs(raw); }
export function getModelPrefs() { return { slugs: { ...modelPrefs.slugs }, colors: { ...modelPrefs.colors } }; }
/* True when prefs change nothing (so the app stores null rather than a copy). */
export const modelPrefsAreDefault = (p) =>
  !p || (!Object.keys(p.slugs || {}).length && !Object.keys(p.colors || {}).length);

/* Every catalog row, flattened, as shipped (no prefs applied). */
export const DEFAULT_CATALOG = MODEL_LABS.flatMap((lab) =>
  lab.models.map((m) => ({ ...m, lab: lab.id, labName: lab.name, origin: lab.origin, via: lab.via || 'openrouter' })));

/* The live catalog: the shipped rows with the user's slug/color overrides
   applied. Recomputed per call — prefs change at runtime and a stale copy is
   how a picker ends up offering a slug the user has already renamed. */
export function catalog() {
  return DEFAULT_CATALOG.map((m) => ({
    ...m,
    slug: modelPrefs.slugs[m.key] || m.slug,
    color: modelPrefs.colors[m.key] || m.color,
    renamed: !!modelPrefs.slugs[m.key] && modelPrefs.slugs[m.key] !== m.slug,
  }));
}
/* The same rows, grouped for a picker: [{ lab, name, origin, models[] }]. */
export function catalogByLab() {
  const live = catalog();
  return MODEL_LABS.map((lab) => ({
    id: lab.id, name: lab.name, origin: lab.origin,
    models: live.filter((m) => m.lab === lab.id),
  }));
}

/* Find a catalog row by the slug a routine was saved with. Live slugs win;
   the shipped default is the fallback so a routine pinned before a rename
   still resolves to a name, a price and a color instead of reading as unknown. */
export function modelBySlug(slug) {
  const s = String(slug || '');
  if (!s) return null;
  return catalog().find((m) => m.slug === s) || DEFAULT_CATALOG.find((m) => m.slug === s) || null;
}
export const modelByKey = (key) => catalog().find((m) => m.key === key) || null;

/* Flat list for the pickers, `auto` first. `claude` / `openrouter` narrow it to
   what a given executor can actually run. */
export function allModels({ auto = true, via = 'all' } = {}) {
  const rows = catalog().filter((m) => via === 'all' || m.via === via);
  const head = [];
  if (auto) head.push(AUTO_MODEL);
  if (auto && via !== 'claude') head.push(OPENROUTER_AUTO);
  return [...head, ...rows];
}

/* Back-compat shape for callers that still want `{ id, label }` rows. */
export const MODELS = [
  { id: AUTO_MODEL.slug, label: AUTO_MODEL.name, auto: true },
  { id: OPENROUTER_AUTO.slug, label: OPENROUTER_AUTO.name, auto: true },
  ...DEFAULT_CATALOG.map((m) => ({ id: m.slug, label: `${m.name} — ${m.labName} ${TIER_LABEL[m.tier].toLowerCase()}` })),
];

/* ---------- Cost estimation ---------- */
export const MODEL_PRICING = Object.fromEntries(
  DEFAULT_CATALOG.map((m) => [m.slug, { in: m.in, out: m.out, approx: !!m.approx }]));
/* Price for whatever slug is in front of us — live catalog first, then the
   shipped table, so a renamed row keeps its price and a legacy slug keeps its. */
export function pricingFor(slug) {
  const row = modelBySlug(slug);
  return row ? { in: row.in, out: row.out, approx: !!row.approx } : (MODEL_PRICING[slug] || null);
}

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
  const p = pricingFor(model);
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

/* A per-million-token rate, short enough to sit inside an <option> label:
   "$3/$15 per M". That is the whole point of showing it there — you pick a
   model where you pick it, not after opening a pricing page. */
export function rateLabel(slug) {
  const p = pricingFor(slug);
  if (!p) return '';
  const n = (v) => (v >= 1 ? `$${Number(v.toFixed(2))}` : `$${Number(v.toFixed(2))}`);
  return `${n(p.in)}/${n(p.out)} per M${p.approx ? '*' : ''}`;
}

/* ---------- Colors ----------
   A calendar block is colored by the MODEL that will run it: one hue family per
   lab, brightest at the top tier, overridable per model in Settings → Models.
   Anything the catalog does not know (a hand-typed slug, a retired id) falls
   back to a neutral grey rather than borrowing another model's color. */
export const UNKNOWN_MODEL_COLOR = '#7C879E';
export function modelColor(slug) {
  const row = modelBySlug(slug);
  return (row && row.color) || UNKNOWN_MODEL_COLOR;
}
/* The color a routine's block wears: its resolved model (so an `auto` routine
   is colored by whatever Auto will actually pick, not by "auto"). */
export function routineColor(routine = {}, policy) {
  return modelColor(effectiveModel(routine, policy));
}

/* ---------- Pickers ----------
   One builder for every model <select> in the app, so the drawer, Settings, the
   routing grid and the chat composer cannot drift apart. Grouped by lab with
   the tier and the rate on each row — issue #103's "organized by lab, tiers
   grouped, with a small way to know the cost". */
const escAttr = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function modelOptionsHtml(selected, { auto = true, via = 'all' } = {}) {
  const sel = String(selected || '');
  const opt = (value, label) => `<option value="${escAttr(value)}" ${sel === value ? 'selected' : ''}>${escAttr(label)}</option>`;
  const head = [];
  if (auto) head.push(opt(AUTO_MODEL.slug, AUTO_MODEL.name));
  if (auto && via !== 'claude') head.push(opt(OPENROUTER_AUTO.slug, OPENROUTER_AUTO.name));
  const groups = catalogByLab().map((lab) => {
    const rows = lab.models.filter((m) => via === 'all' || m.via === via);
    if (!rows.length) return '';
    const items = rows.map((m) => opt(m.slug, `${m.name} · ${TIER_LABEL[m.tier]} · ${rateLabel(m.slug)}`)).join('');
    return `<optgroup label="${escAttr(`${lab.name} · ${lab.origin}`)}">${items}</optgroup>`;
  }).join('');
  // A model the catalog has never heard of — a legacy pin, or a slug typed
  // straight into settings — still has to be selectable, or opening the drawer
  // on that routine would silently re-point it at whatever sits first in the list.
  const known = new Set([AUTO_MODEL.slug, OPENROUTER_AUTO.slug, ...catalog().map((m) => m.slug)]);
  const orphan = sel && !known.has(sel) ? `<optgroup label="Not in the catalog">${opt(sel, `${sel} (kept as-is)`)}</optgroup>` : '';
  return head.join('') + orphan + groups;
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

/* Short display name for a model id (handles catalog + legacy/unknown ids).
   An id nothing knows is shown verbatim: a slug the user typed is still the
   truest name we have for it. */
export function modelLabel(id) {
  if (id === AUTO_MODEL.slug) return 'Auto';
  if (id === OPENROUTER_AUTO.slug) return 'OpenRouter Auto';
  const m = modelBySlug(id);
  return m ? m.name : (id || '');
}
/* "Kimi K2.7 Code · Moonshot (Kimi) Balanced" — the long form, for a tooltip or
   a detail line where there is room to say which lab and which tier. */
export function modelFullLabel(id) {
  const m = modelBySlug(id);
  return m ? `${m.name} · ${m.labName} ${TIER_LABEL[m.tier]}` : modelLabel(id);
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
