/* ============================================================
   Claude Routine Planner — app logic (Supabase-backed)

   Sign in with email + password; your routines and run history
   live in Supabase (row-level-secured per user), so they're there
   on every device, every login. "Run now" fires your Claude Code
   routine via the Netlify CLAUDE_TRIGGER function, passing the
   prompt as a session turn.
   ============================================================ */

/* Vendored, same-origin (js/vendor/supabase-js.js) — NOT a CDN import.
   This used to be `https://esm.sh/@supabase/supabase-js@2`, which put two
   serial third-party round trips in front of every cold load: esm.sh resolves
   the unpinned `@2` tag with a short-TTL redirect stub, then serves the build.
   A module that fails to load takes the whole app with it, and because the
   topbar starts hidden the result was a blank white page with nothing to click
   — the "refresh a few times and it finally works" bug. Regenerate the bundle
   with `node scripts/vendor-supabase.mjs`. */
import { createClient } from './vendor/supabase-js.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import {
  MODELS, TASK_TYPES, COMPLEXITIES, DEFAULT_MODEL, DEFAULT_TASK_TYPE, DEFAULT_COMPLEXITY,
  effectiveModel, displayModel, getModelForTask, modelLabel, isClaudeModel, runModel,
  ROUTING_POLICY, setActivePolicy, getActivePolicy, normalizePolicy,
  estimateRunCost, fmtUSD,
} from './model-router.js';
import { nextOccurrence, nextOccurrences } from './schedule.js';

const TRIGGER_FN = '/.netlify/functions/claude-trigger';
/* The production site. Only this host defaults the master fire switch to live;
   preview/branch/dev deploys default to paused so they don't fire by accident. */
const MAIN_HOST = 'zroutiner.netlify.app';

/* Dedicated storage key: this Supabase project is shared with other ZPARX apps
   (e.g. the admin dashboard). Two apps on the same browser origin using the
   default key share ONE session in localStorage and rotate each other's refresh
   tokens; when a stale token gets replayed, Supabase's reuse detection revokes
   the whole session, so the trigger function rejects even freshly-refreshed
   tokens (401) until a manual sign-out/in. An app-specific key gives Routiner
   its own independent session. (One-time effect: existing users are signed out
   once by this change and just sign back in.) */
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { storageKey: 'routiner-auth' } });
const RECURRENCE = { none: 'One-time', daily: 'Every day', weekdays: 'Weekdays (Mon–Fri)', weekly: 'Every week' };

/* ---------- Accounts & triggers (user-managed) ----------
   Each account holds a list of triggers (instances). A trigger is one Fire URL
   (or trig_… id) + token. Routines target an account AND a specific trigger.
   The structure lives in Supabase routiner_settings.accounts and is editable
   in Settings; `accountsCfg` is the in-memory copy (secrets stripped) used to
   render. */
const KNOWN_LABELS = { sparks9679: 'Sparks', zparxmarketing: 'Zparx', openrouter: 'OpenRouter' };
const DEFAULT_ACCOUNT = 'sparks9679';
// Built-in "OpenRouter" account: its routines execute WITHOUT a Claude session —
// they fire the lead-enrichment edge function (Perplexity) directly. The key
// itself lives server-side (edge secret); this account is its handle in the app.
const OPENROUTER_ACCOUNT = () => ({
  id: 'openrouter', label: 'OpenRouter', kind: 'openrouter',
  triggers: [{ id: 'perplexity', label: 'Perplexity', trigger: '', token: '' }],
});
const DEFAULT_ACCOUNTS = () => [
  { id: 'sparks9679', label: 'Sparks', kind: 'claude', triggers: [
    { id: 't_a', label: 'A', trigger: '', token: '' },
    { id: 't_b', label: 'B', trigger: '', token: '' },
    { id: 't_c', label: 'C', trigger: '', token: '' },
  ] },
  { id: 'zparxmarketing', label: 'Zparx', kind: 'claude', triggers: [
    { id: 't_x', label: 'X', trigger: '', token: '' },
    { id: 't_y', label: 'Y', trigger: '', token: '' },
    { id: 't_z', label: 'Z', trigger: '', token: '' },
  ] },
  OPENROUTER_ACCOUNT(),
];
// Perplexity research models an OpenRouter routine can pick (cheap → deepest).
const PERPLEXITY_MODELS = [
  { id: 'perplexity/sonar', label: 'Sonar — cheapest' },
  { id: 'perplexity/sonar-pro', label: 'Sonar Pro — default' },
  { id: 'perplexity/sonar-reasoning', label: 'Sonar Reasoning' },
  { id: 'perplexity/sonar-reasoning-pro', label: 'Sonar Reasoning Pro' },
  { id: 'perplexity/sonar-deep-research', label: 'Sonar Deep Research — deepest' },
];
const DEFAULT_PERPLEXITY_MODEL = 'perplexity/sonar-pro';

/* OpenRouter "agent" accounts (kind 'openrouter-agent') — user-addable and
   non-Claude. Each instance (trigger) runs a bounded tool-use loop on a chosen
   OpenRouter model (default Kimi) via the `openrouter-agent` edge function, and
   its full result lands in History (resumable). This is DISTINCT from the built-in
   `openrouter` (Perplexity enrichment) account above, which is left untouched. */
const DEFAULT_AGENT_MODEL = 'moonshotai/kimi-k2.7-code';
const AGENT_TOOLS = [
  { id: 'read', label: 'Read your data + run history' },
  { id: 'research', label: 'Web research' },
  { id: 'write', label: 'Write to apps' },
  { id: 'code', label: 'Fix code (GitHub)' },
];
const AGENT_TOOL_IDS = AGENT_TOOLS.map((t) => t.id);
/* Default tools for new agent instances — GitHub write is opt-in (checkbox). */
const DEFAULT_AGENT_TOOLS = AGENT_TOOL_IDS.filter((id) => id !== 'code');
/* Coerce whatever's stored (array of ids, or a {read:true,…} object) into the
   canonical ordered array of enabled tool ids. Missing tools → safe default
   (no code); explicit arrays (including ones with code) are kept as-is. */
const normalizeTools = (t) => {
  const arr = Array.isArray(t) ? t : (t && typeof t === 'object' ? Object.keys(t).filter((k) => t[k]) : null);
  return AGENT_TOOL_IDS.filter((id) => (arr || DEFAULT_AGENT_TOOLS).includes(id));
};
/* OpenRouter chat models an agent instance can run — every non-Claude,
   non-perplexity, non-auto id in the shared catalog. */
const AGENT_MODELS = () => MODELS.filter((m) => !m.auto && !isClaudeModel(m.id) && !/^perplexity\//.test(m.id));
/* A fresh OpenRouter agent account for the "Add OpenRouter account" button. */
const NEW_AGENT_ACCOUNT = () => ({ id: genId('acc'), label: 'Kimi', kind: 'openrouter-agent', key: '',
  triggers: [{ id: genId('t'), label: 'A', trigger: '', token: '', model: DEFAULT_AGENT_MODEL, tools: [...DEFAULT_AGENT_TOOLS] }] });

let accountsCfg = DEFAULT_ACCOUNTS();
let settingsPolicy = null; // the user's saved auto-routing policy (null = built-in default)

const genId = (p) => `${p}_${Math.random().toString(36).slice(2, 8)}`;

/* Normalize whatever is stored (new array shape, old { id:{trigger,token} } map,
   or empty) into the array shape. `keepSecrets:false` strips trigger/token so the
   broadly-held copy carries only ids + labels. */
// Guarantee the built-in OpenRouter (non-Claude) account is always present, so
// it appears top-right even for users whose saved settings predate it.
function ensureBuiltins(list) {
  if (!list.some((a) => (a.kind || (a.id === 'openrouter' ? 'openrouter' : 'claude')) === 'openrouter')) {
    list.push(OPENROUTER_ACCOUNT());
  }
  return list;
}
function normalizeAccounts(raw, keepSecrets) {
  // `model` + `tools` are not secrets (they drive rendering), so keep them
  // always; only trigger/token (Claude) and the account `key` (OpenRouter) are
  // stripped from the broadly-held copy.
  const trig = (t, i) => ({ id: t.id || genId('t'), label: t.label || String.fromCharCode(65 + i),
    trigger: keepSecrets ? (t.trigger || '') : '', token: keepSecrets ? (t.token || '') : '',
    model: t.model || '', tools: normalizeTools(t.tools) });
  if (Array.isArray(raw) && raw.length) {
    return ensureBuiltins(raw.map((a) => ({ id: a.id || genId('acc'), label: a.label || KNOWN_LABELS[a.id] || a.id,
      kind: a.kind || (a.id === 'openrouter' ? 'openrouter' : 'claude'),
      key: keepSecrets ? (a.key || '') : '',
      triggers: (a.triggers || []).map(trig) })));
  }
  if (raw && typeof raw === 'object' && Object.keys(raw).length) { // old map shape
    return ensureBuiltins(Object.entries(raw).map(([id, v]) => ({ id, label: KNOWN_LABELS[id] || id,
      kind: id === 'openrouter' ? 'openrouter' : 'claude', key: '',
      triggers: (v && (v.trigger || v.token)) ? [trig({ id: 't1', label: 'A', trigger: v.trigger, token: v.token }, 0)] : [] })));
  }
  return DEFAULT_ACCOUNTS();
}

const listAccounts = () => accountsCfg;
const getAccountCfg = (id) => accountsCfg.find((a) => a.id === id);
const accountIndex = (id) => accountsCfg.findIndex((a) => a.id === id);
const accountLabel = (id) => { const a = getAccountCfg(id); return a ? a.label : (KNOWN_LABELS[id] || id || ''); };
const accountKind = (id) => (getAccountCfg(id) || {}).kind || (id === 'openrouter' ? 'openrouter' : 'claude');
const accountTriggers = (id) => (getAccountCfg(id) || {}).triggers || [];
const triggerCfg = (accId, tId) => accountTriggers(accId).find((t) => t.id === tId);
const triggerLabel = (accId, tId) => { const t = triggerCfg(accId, tId); return t ? t.label : ''; };
const isAgentKind = (id) => accountKind(id) === 'openrouter-agent';
/* The OpenRouter model an agent instance runs (falls back to the first
   trigger's model, then the default) and its enabled tools. */
const triggerModel = (accId, tId) => {
  const t = triggerCfg(accId, tId) || accountTriggers(accId)[0];
  return (t && t.model) || DEFAULT_AGENT_MODEL;
};
const triggerTools = (accId, tId) => {
  const t = triggerCfg(accId, tId) || accountTriggers(accId)[0];
  return normalizeTools(t && t.tools);
};

/* Color engine: each account gets a themed set of DISTINCT hues (not just
   shades), so its triggers A/B/C are easy to tell apart at a glance while the
   set still reads as one account (warm for the first, cool for the second) and
   stays on-brand against the dark UI. */
const HUE_FAMILIES = [
  ['#BCEF2F', '#F5D33B', '#FF7A33', '#86E01E', '#E8631C'], // Sparks: green / yellow / orange / …
  ['#4D6BFF', '#22D3EE', '#B57BFF', '#4DA6FF', '#7C9CFF'], // Zparx: blue / cyan / violet / …
  ['#FF7A33', '#FF9E2C', '#F5D33B', '#FFB066', '#E8631C'], // orange / amber
  ['#B57BFF', '#9B5DE5', '#C77DFF', '#8A5CF6', '#7A3FF0'], // purple
  ['#FF4D8D', '#FF7AA8', '#F15BB5', '#FF9EC4', '#E8327C'], // pink
  ['#2EE6A6', '#3DDC97', '#6EE7B7', '#16C79A', '#0FB58E'], // teal
];
const hexToRgb = (h) => { h = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.114 * b) / 255;
const inkFor = (hex) => lum(hexToRgb(hex)) > 0.55 ? '#0C111F' : '#FFFFFF';
const darken = (hex, amt) => { const d = (v) => Math.round(v * (1 - amt)).toString(16).padStart(2, '0'); return '#' + hexToRgb(hex).map(d).join(''); };
const swatch = (hex) => ({ solid: hex, ink: inkFor(hex), edge: darken(hex, 0.3) });
const GREY = { solid: '#7C879E', ink: '#0C111F', edge: '#5A6377' };
const hashStr = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0; return h; };

function triggerColor(accId, tId) {
  const ai = accountIndex(accId);
  if (ai < 0) return GREY;
  const fam = HUE_FAMILIES[ai % HUE_FAMILIES.length];
  const trigs = accountTriggers(accId);
  let ti = trigs.findIndex((t) => t.id === tId);
  // No trigger → account's base shade. Unknown/removed trigger → a stable shade
  // derived from its key, so distinct triggers stay visually distinct on the
  // calendar (and each earns its own legend swatch) instead of collapsing.
  if (ti < 0) ti = tId ? (1 + hashStr(String(tId)) % Math.max(1, fam.length - 1)) : 0;
  return swatch(fam[ti % fam.length]);
}
const accountColor = (accId) => triggerColor(accId, null); // base shade for the account

/* How long a routine block occupies on the calendar */
const DEFAULT_DURATION_MIN = 45;
const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];
const fmtDuration = (m) => m < 60 ? `${m} min` : (m % 60 === 0 ? `${m / 60} hr` : `${(m / 60).toFixed(1)} hr`);

/* Week-calendar layout knobs — full 24h day (routines can fire overnight).
   hourPx is the vertical scale and is pinch-zoomable (see wireCalendarZoom),
   persisted per browser so the chosen zoom sticks. */
const CAL_HOURPX_MIN = 22, CAL_HOURPX_MAX = 240, CAL_HOURPX_DEFAULT = 44;
const CAL_ZOOM_LS = 'routiner.cal.hourpx.v1';
const clampHourPx = (v) => Math.max(CAL_HOURPX_MIN, Math.min(CAL_HOURPX_MAX, Math.round(v)));
const loadCalHourPx = () => { const n = parseFloat(localStorage.getItem(CAL_ZOOM_LS)); return Number.isFinite(n) ? clampHourPx(n) : CAL_HOURPX_DEFAULT; };
const CAL = { startHour: 0, endHour: 24, hourPx: loadCalHourPx(), defaultDurationMin: DEFAULT_DURATION_MIN };
/* Set the timeline zoom. Returns true if it actually changed. */
function setCalHourPx(v, persist = true) {
  const c = clampHourPx(v);
  if (c === CAL.hourPx) return false;
  CAL.hourPx = c;
  if (persist) { try { localStorage.setItem(CAL_ZOOM_LS, String(c)); } catch { /* */ } }
  return true;
}
let activeTouches = 0; // live count of fingers on the calendar (pinch vs drag guard)
let lastCalDragEnd = 0; // timestamp a block-drag ended — suppresses the synthetic click that follows
let calRef = new Date(); // any day inside the week currently shown

/* settings (default model / default account / optional trigger override /
   OpenRouter key for live tests) stay local */
const LS = 'routiner.settings.v1';
let settings = loadSettings();
function loadSettings() {
  const defaults = { model: DEFAULT_MODEL, account: DEFAULT_ACCOUNT, triggerUrl: '', anthropicKey: '', openrouterKey: '' };
  try {
    const s = Object.assign({}, defaults, JSON.parse(localStorage.getItem(LS) || '{}'));
    if (!s.anthropicKey && s.apiKey) s.anthropicKey = s.apiKey; // legacy apiKey was the Anthropic key
    delete s.apiKey;
    // Master fire switch (per browser/deployment): default live only on the
    // main site, paused on preview/dev so they don't fire by accident.
    if (typeof s.firing !== 'boolean') s.firing = (location.hostname === MAIN_HOST);
    return s;
  } catch { return { model: DEFAULT_MODEL, account: DEFAULT_ACCOUNT, triggerUrl: '', anthropicKey: '', openrouterKey: '', firing: (location.hostname === MAIN_HOST) }; }
}
function saveSettings() { localStorage.setItem(LS, JSON.stringify(settings)); }

let routines = [];
let runs = [];
let notes = [];
let currentView = 'history';   // Chat — the first tab, and where the app opens
let session = null;

/* ---------- DOM helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const view = $('#view');
const overlay = $('#overlay');
const drawerBody = $('#drawerBody');
const drawerFoot = $('#drawerFoot');
const drawerTitle = $('#drawerTitle');

/* ---------- Time helpers ---------- */
function fmt(iso) { return iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }
function relative(iso) {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - Date.now(), abs = Math.abs(diff);
  const m = Math.round(abs / 6e4), h = Math.round(abs / 36e5), d = Math.round(abs / 864e5);
  const s = m < 1 ? 'moments' : m < 60 ? `${m}m` : h < 24 ? `${h}h` : `${d}d`;
  return diff >= 0 ? `in ${s}` : `${s} ago`;
}
function toLocalInput(d) { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
function defaultWhen() { const d = new Date(Date.now() + 36e5); d.setMinutes(0, 0, 0); return toLocalInput(d); }
/* nextOccurrence / nextOccurrences now live in ./schedule.js (shared, tested). */

/* ---------- Toasts ---------- */
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ` toast--${kind}` : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 4000);
  setTimeout(() => el.remove(), 4400);
}

/* ---------- Row <-> object mapping ---------- */
const fromRow = (r) => ({
  id: r.id, title: r.title, prompt: r.prompt, model: r.model || DEFAULT_MODEL, account: r.account || DEFAULT_ACCOUNT,
  taskType: r.task_type || DEFAULT_TASK_TYPE, complexity: r.complexity || DEFAULT_COMPLEXITY,
  triggerKey: r.trigger_key || null,
  recurrence: r.recurrence, status: r.status, scheduledAt: r.scheduled_at, lastRun: r.last_run,
  durationMin: r.duration_min || DEFAULT_DURATION_MIN,
  tz: r.tz || null, retryCount: r.retry_count || 0,
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const toRow = (o) => ({
  title: o.title ?? '', prompt: o.prompt ?? '', model: o.model || DEFAULT_MODEL,
  task_type: o.taskType || DEFAULT_TASK_TYPE, complexity: o.complexity || DEFAULT_COMPLEXITY,
  account: o.account || DEFAULT_ACCOUNT, trigger_key: o.triggerKey || null,
  recurrence: o.recurrence || 'none', status: o.status || 'library',
  duration_min: o.durationMin || DEFAULT_DURATION_MIN,
  scheduled_at: o.scheduledAt || null, last_run: o.lastRun || null,
  // Only send tz when we have one, so an edit that doesn't carry it never nulls
  // the column (the scheduler owns retry_count, so it's never written here).
  ...(o.tz ? { tz: o.tz } : {}),
});
// The browser's IANA timezone, stamped onto new routines so recurrence stays
// DST-correct (see the scheduler's nextOccurrence). Falls back to null.
const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } };

/* ---------- Data layer ---------- */
/* The first load is the one that decides whether the app "works", so it does
   not get to fail on a single dropped request. One silent retry absorbs the
   ordinary blip (a sleeping iPad's first request after wake almost always
   fails); anything past that becomes a visible error with a Try again button,
   because the old behaviour — a toast over an empty page — left refreshing as
   the only way forward. */
async function loadAll() {
  try {
    await loadAllOnce();
  } catch (e) {
    try {
      await loadAllOnce();
    } catch (e2) {
      console.warn('[routiner] initial load failed:', e2);
      showLoadError(e2, () => loadAll());
    }
  }
}

async function loadAllOnce() {
  const [rRes, runRes, setRes] = await Promise.all([
    sb.from('routiner_routines').select('*').order('updated_at', { ascending: false }),
    sb.from('routiner_runs').select('*').order('fired_at', { ascending: false }).limit(200),
    sb.from('routiner_settings').select('*').maybeSingle(),
  ]);
  /* postgrest-js resolves rather than throws on a network error, so a failed
     fetch arrives here as `error` on the result — surface it as a throw so the
     retry path above sees it. */
  if (rRes.error) throw new Error(rRes.error.message || 'Could not read your routines');
  accountsCfg = normalizeAccounts(setRes && setRes.data && setRes.data.accounts, false);
  // Apply the user's saved auto-routing policy so previews/cards match what the
  // scheduler will fire (null/invalid → built-in default).
  settingsPolicy = normalizePolicy(setRes && setRes.data && setRes.data.model_policy);
  setActivePolicy(settingsPolicy);
  routines = (rRes.data || []).map(fromRow);
  runs = (runRes.data || []).map((x) => ({
    id: x.id, routineId: x.routine_id, title: x.title, status: x.status, output: x.output, firedAt: x.fired_at,
    // Agent runs also carry the resumable conversation + the context needed to
    // continue it (issues #51/#52). Null for Claude-trigger and legacy runs.
    messages: x.messages || null, model: x.model || null, account: x.account || null, triggerKey: x.trigger_key || null, tools: x.tools || null,
    // fired_at is the run's LAST activity (the agent bumps it at every
    // checkpoint); started_at is when it began. Null on rows written before the
    // column existed — those simply show no duration.
    startedAt: x.started_at || null,
  }));
  await dbLoadNotes();
  render();
  warnRecentFailures();
}
// Nudge (once per session) when routines failed or were missed in the last 24h,
// so scheduler problems don't stay buried in History.
let _failuresWarned = false;
function warnRecentFailures() {
  if (_failuresWarned) return;
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const bad = runs.filter((r) => (r.status === 'error' || r.status === 'missed') &&
    r.firedAt && new Date(r.firedAt).getTime() >= dayAgo);
  if (!bad.length) return;
  _failuresWarned = true;
  const n = bad.length;
  const kinds = bad.some((b) => b.status === 'missed') ? 'failed/missed' : 'failed';
  toast(`${n} routine run${n > 1 ? 's' : ''} ${kinds} in the last 24h — see Chat`, 'error');
}
const getRoutine = (id) => routines.find((r) => r.id === id);

async function dbCreate(obj) {
  if (!obj.tz) obj = { ...obj, tz: localTz() }; // stamp the creator's tz for DST-correct recurrence
  const { data, error } = await sb.from('routiner_routines').insert(toRow(obj)).select().single();
  if (error) { toast('Save failed: ' + error.message, 'error'); return null; }
  const r = fromRow(data); routines.unshift(r); return r;
}
async function dbUpdate(id, obj) {
  const { data, error } = await sb.from('routiner_routines').update(toRow(obj)).eq('id', id).select().single();
  if (error) { toast('Update failed: ' + error.message, 'error'); return null; }
  const r = fromRow(data); const i = routines.findIndex((x) => x.id === id); if (i >= 0) routines[i] = r; return r;
}
async function dbDelete(id) {
  const { error } = await sb.from('routiner_routines').delete().eq('id', id);
  if (error) { toast('Delete failed: ' + error.message, 'error'); return false; }
  routines = routines.filter((x) => x.id !== id); return true;
}
/* Per-account fire credentials (trigger + token), stored in Supabase
   (routiner_settings, RLS per user). The Netlify function reads these
   server-side using your session, so you can set everything in-app —
   no Netlify env vars required. */
async function dbLoadAccountCreds() {
  const { data, error } = await sb.from('routiner_settings').select('*').maybeSingle();
  if (error) { toast('Couldn’t load account settings: ' + error.message, 'error'); return {}; }
  settingsPolicy = normalizePolicy(data && data.model_policy); // keep the editor's copy fresh (undefined pre-migration → null)
  return (data && data.accounts) || {};
}
// Persist accounts, and — when `modelPolicy` is explicitly passed (an object to
// set, or null to clear) — the auto-routing policy too. Omitting the arg leaves
// model_policy untouched.
async function dbSaveAccountCreds(accounts, modelPolicy) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { toast('Sign in to save settings.', 'error'); return false; }
  const row = { user_id: user.id, accounts, updated_at: new Date().toISOString() };
  if (modelPolicy !== undefined) row.model_policy = modelPolicy;
  const { error } = await sb.from('routiner_settings')
    .upsert(row, { onConflict: 'user_id' });
  if (error) { toast('Save failed: ' + error.message, 'error'); return false; }
  return true;
}

/* ---------- Board notes ---------- */
/* brainstorm = inactive (Claude ignores it) · active = work this · then the
   downstream planned/done/dismissed. */
const NOTE_STATUS = { active: 'Active', brainstorm: 'Brainstorm', planned: 'Planned', done: 'Done', dismissed: 'Dismissed' };
const NOTE_ORDER = { active: 0, brainstorm: 1, planned: 2, done: 3, dismissed: 4 };
const noteFromRow = (n) => ({ id: n.id, body: n.body, status: n.status === 'open' ? 'active' : n.status, createdAt: n.created_at, updatedAt: n.updated_at });
async function dbLoadNotes() {
  const { data, error } = await sb.from('routiner_notes').select('*').order('created_at', { ascending: false }).limit(300);
  if (error) { /* table may not exist yet on older deploys */ return; }
  notes = (data || []).map(noteFromRow);
}
async function dbCreateNote(body, status) {
  const { data, error } = await sb.from('routiner_notes').insert({ body, status: status || 'brainstorm' }).select().single();
  if (error) { toast('Post failed: ' + error.message, 'error'); return null; }
  const n = noteFromRow(data); notes.unshift(n); return n;
}
async function dbUpdateNote(id, patch) {
  const { data, error } = await sb.from('routiner_notes').update(patch).eq('id', id).select().single();
  if (error) { toast('Update failed: ' + error.message, 'error'); return null; }
  const n = noteFromRow(data); const i = notes.findIndex((x) => x.id === id); if (i >= 0) notes[i] = n; return n;
}
async function dbDeleteNote(id) {
  const { error } = await sb.from('routiner_notes').delete().eq('id', id);
  if (error) { toast('Delete failed: ' + error.message, 'error'); return false; }
  notes = notes.filter((x) => x.id !== id); return true;
}

async function dbInsertRun(routine, result) {
  const { data, error } = await sb.from('routiner_runs')
    .insert({ routine_id: routine.id || null, title: routine.title || 'Untitled', status: result.status, output: result.text })
    .select().single();
  if (!error && data) runs.unshift({ id: data.id, routineId: data.routine_id, title: data.title, status: data.status, output: data.output, firedAt: data.fired_at });
}

/* ---------- Master fire switch (per browser/deployment) ----------
   Lives in Settings rather than the top bar: it is a rarely-flipped safety
   catch, not a per-session control, and the rail is better spent on the work.
   Both functions no-op when the drawer isn't open, so they're safe to call
   from anywhere. */
function paintFireSwitch() {
  const el = $('#fireSwitch'); if (!el) return;
  const on = !!settings.firing;
  el.classList.toggle('is-on', on);
  el.classList.toggle('is-off', !on);
  const lbl = $('#fireLabel'); if (lbl) lbl.textContent = on ? 'Active' : 'Paused';
  el.title = on
    ? 'This site WILL fire routines (Run now / immediate). Click to pause.'
    : 'This site will NOT fire routines from here. Click to activate.';
}
function toggleFireSwitch() {
  settings.firing = !settings.firing;
  saveSettings();
  paintFireSwitch();
  toast(settings.firing ? 'Firing enabled on this site.' : 'Firing paused — Run now won’t fire from here.', settings.firing ? '' : 'error');
}

/* ---------- Trigger (fire the Claude Code routine) ---------- */
/* refreshSession() resolves with {data,error} rather than throwing, but guard
   anyway so a thrown network error can't break the fire flow. */
async function tryRefresh() {
  try { const { data, error } = await sb.auth.refreshSession(); return error ? null : (data?.session || null); }
  catch { return null; }
}

/* Resolve a *valid* Supabase session for firing, healing the two ways it goes
   stale on an idle tab (common on iPad Safari, which suspends backgrounded
   pages and pauses the auto-refresh timer):
     1. getSession() returns an expired token (it reads storage without
        validating) → refresh it.
     2. getSession() returns nothing at all → try one refresh from the stored
        refresh token before concluding the user is signed out.
   Returns { session } on success, or { error } describing what failed so the
   caller can show it on-screen (no devtools needed to diagnose). */
async function sessionForFire() {
  let { data: { session: s } } = await sb.auth.getSession();
  if (!s) {
    s = await tryRefresh();
    if (!s) return { error: 'No active session on this device. Sign out and back in.' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (!s.expires_at || (s.expires_at - now) < 60) {   // expired or about to
    const r = await tryRefresh();
    if (r) s = r;
  }
  if (!s.access_token) return { error: 'Signed in, but no access token is available. Sign out and back in.' };
  return { session: s };
}

/* Claim a routine the same way the scheduler does after a successful fire, so a
   manual "Run now" doesn't leave status=scheduled + scheduled_at=now for pg_cron
   to pick up a minute later (that was creating two identical agent History rows).
   One-offs park in the library; recurring advance to the next future occurrence. */
async function claimManualFire(routine) {
  if (!routine?.id) return routine;
  const nowIso = new Date().toISOString();
  const rec = routine.recurrence || 'none';
  if (rec === 'none') {
    return (await dbUpdate(routine.id, Object.assign({}, routine, {
      status: 'library', scheduledAt: null, lastRun: nowIso,
    }))) || routine;
  }
  const seed = routine.scheduledAt || nowIso;
  const next = nextOccurrence(seed, rec);
  return (await dbUpdate(routine.id, Object.assign({}, routine, next
    ? { status: 'scheduled', scheduledAt: next, lastRun: nowIso }
    : { status: 'library', scheduledAt: null, lastRun: nowIso }))) || routine;
}

// Debounce double-clicks on Run now (same routine).
const fireInFlight = new Set();

async function fireTrigger(routine) {
  if (!settings.firing) { toast('Firing is paused on this site — turn it on in Settings → Firing.', 'error'); return; }
  if (routine?.id) {
    if (fireInFlight.has(routine.id)) { toast('Already firing this routine…'); return; }
    fireInFlight.add(routine.id);
  }
  try {
    return await fireTriggerInner(routine);
  } finally {
    if (routine?.id) fireInFlight.delete(routine.id);
  }
}

async function fireTriggerInner(routine) {
  // OpenRouter account → run the Perplexity enrichment engine directly (no Claude).
  if (accountKind(routine?.account) === 'openrouter') return fireEnrichment(routine);
  // OpenRouter agent account → run the model + tool loop (no Claude).
  if (accountKind(routine?.account) === 'openrouter-agent') return fireAgent(routine);
  const direct = settings.triggerUrl.trim();
  const url = direct || TRIGGER_FN;
  const payload = JSON.stringify({ text: routine?.prompt || '', account: routine?.account || DEFAULT_ACCOUNT, triggerKey: routine?.triggerKey || null, model: routine ? effectiveModel(routine) : undefined, source: 'claude-routine-planner', routineId: routine?.id, title: routine?.title, at: new Date().toISOString() });
  // Send the signed-in user's access token so the gated function authorizes us.
  // ALWAYS attach it when we have one — including with a direct URL set in
  // Settings. A direct URL is typically this app's own gated function on its
  // canonical host (used when the app is served from another domain), and
  // skipping auth there made every Run now 401 while the Settings "Test"
  // button (which does send the token, see pingTrigger) reported success.
  const post = (token) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(url, { method: 'POST', headers, body: payload });
  };
  const { session, error } = await sessionForFire();
  // Without a direct URL the gated built-in function will reject an
  // unauthenticated call anyway, so surface the session problem here. A direct
  // URL may be ungated — let it try without a token.
  if (error && !direct) { toast(error, 'error'); return; }
  let token = session?.access_token || null;
  try {
    let r = await post(token);
    // A 401 despite a token means the server rejected it as expired/invalid —
    // force one refresh and retry before giving up, so a stale token self-heals.
    if (r.status === 401 && token) {
      const s = await tryRefresh();
      if (s?.access_token && s.access_token !== token) { token = s.access_token; r = await post(token); }
    }
    if (!r.ok) {
      // Distinct wording from the client-side "no session" message above so we
      // can tell the two apart from the toast alone: this one means the browser
      // HAD a session but the server rejected it. Include the server's own
      // error text — different rejectors (our function, a foreign endpoint)
      // say different things, and that difference is the diagnosis.
      if (r.status === 401) {
        const m = (await r.text().catch(() => '')).slice(0, 160);
        toast(`Server rejected the fire (401${m ? `: ${m}` : ''}). ${token ? 'Sign out and back in if this persists.' : 'Sign in and try again.'}`, 'error');
        return;
      }
      if (r.status === 403) { toast('This account isn’t allowed to fire routines.', 'error'); return; }
      const m = (await r.text().catch(() => '')).slice(0, 180);
      toast(`Trigger responded ${r.status}. ${m}`, 'error');
      return;
    }
    toast('Trigger sent — your Claude routine is starting.');
  } catch (e) {
    if (direct) { try { await fetch(direct, { method: 'POST', mode: 'no-cors', body: payload }); toast('Trigger sent (no-cors).'); return; } catch { /* */ } }
    toast(`Trigger failed: ${e.message}. (Set CLAUDE_TRIGGER + CLAUDE_TOKEN in Netlify.)`, 'error');
  }
}

/* Fire an OpenRouter routine: POST its research config straight to the
   lead-enrichment edge function. No Claude, no routine token — the OpenRouter
   key lives server-side. We authenticate with the signed-in user's Supabase
   token (the function verifies a JWT), so this rides the same session the app
   already has. The research call is slow (live web search), so we report the
   result when it returns. */
async function fireEnrichment(routine) {
  let cfg = {}; try { cfg = JSON.parse(routine?.prompt || '{}'); } catch { /* */ }
  if (!cfg.niche) { toast('This OpenRouter routine has no niche configured.', 'error'); return; }
  const { session, error } = await sessionForFire();
  if (error) { toast(error, 'error'); return; }
  const body = JSON.stringify({ niche: cfg.niche, location: cfg.location ?? null, count: cfg.count, vertical: cfg.vertical,
    dmTitles: cfg.dmTitles, model: cfg.model, toCommand: cfg.toCommand, syncAbstrax: cfg.toAbstrax,
    routineId: routine?.id, report: true });
  const dest = [cfg.toCommand ? 'Command' : null, cfg.toAbstrax ? 'Abstrax' : null].filter(Boolean).join(' + ') || 'nowhere';
  toast(`Researching ${cfg.niche} via Perplexity → ${dest}… this can take a minute.`);
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/lead-enrichment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${session.access_token}` },
      body,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) { toast(`Enrichment failed (${r.status})${data.error ? `: ${data.error}` : ''}.`, 'error'); return; }
    const t = data.totals || {};
    const run = (data.runs || [])[0] || {};
    const bits = [`${t.inserted ?? 0} new lead(s)`];
    if (run.skipped) bits.push(`${run.skipped} dup`);
    if (run.mirrored) bits.push(`${run.mirrored}→Abstrax`);
    if (run.error) bits.push(`⚠ ${run.error}`);
    toast(`Done — ${bits.join(', ')} (~$${Number(t.cost || 0).toFixed(4)}). Check Command's Review tab.`);
  } catch (e) {
    toast(`Enrichment request failed: ${e.message}`, 'error');
  }
}

/* Fire an OpenRouter agent routine: POST the task to the openrouter-agent edge
   function, which runs the chosen model in a bounded tool-use loop (read data /
   web research / write to apps) using the resolved OpenRouter key (per-account
   override or the server key), then writes the full result to routiner_runs. We
   just kick it off, authenticate with the user's Supabase token, and surface the
   recap; the function persists the output so both Run-now and the scheduler
   store it the same way. */
async function fireAgent(routine) {
  const account = routine?.account;
  const triggerKey = routine?.triggerKey || null;
  const model = triggerModel(account, triggerKey);
  const tools = triggerTools(account, triggerKey);
  if (!routine?.prompt || !routine.prompt.trim()) { toast('This routine has no directions.', 'error'); return; }
  const { error } = await sessionForFire();
  if (error) { toast(error, 'error'); return; }
  const who = `${accountLabel(account)}/${triggerLabel(account, triggerKey) || 'instance'}`;
  toast(`Running ${modelLabel(model)} — ${who}… this can take a minute.`);
  try {
    const r = await agentPost({ account, triggerKey, model, tools, prompt: routine.prompt,
      routineId: routine?.id, title: routine?.title, report: true, source: 'planner' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) { toast(`Agent run failed (${r.status})${data.error ? `: ${data.error}` : ''}.`, 'error'); return; }
    const cost = Number(data.cost || 0);
    if (data.continuing) {
      toast(`${modelLabel(model)} is still working in the background — watch History for progress${cost ? ` (~$${cost.toFixed(4)} so far)` : ''}.`);
    } else {
      toast(`Done — ${modelLabel(model)} finished${data.steps ? ` in ${data.steps} step(s)` : ''}${cost ? ` (~$${cost.toFixed(4)})` : ''}. Open it in History to read the full reply or continue.`);
    }
    try { await loadAll(); } catch { /* non-fatal: the row is saved regardless */ }
    // Land in the thread it just created, with the reply box focused — the run
    // is a conversation, so put the reader where they can answer it.
    if (data.runId) openRunInChat(data.runId); else render();
  } catch (e) {
    toast(`Agent request failed: ${e.message}`, 'error');
  }
}

/* Jump to Chat with one run open and the reply box focused. */
function openRunInChat(runId) {
  selectedRunId = 'run-' + runId;
  confirmDeleteId = null;
  currentView = 'history';
  syncTabs();
  render();
  setTimeout(() => $('#run-input')?.focus(), 80);
}

/* ---------- Optional live test (runs the prompt on the chosen model, picking
   the right provider: Claude → Anthropic, OpenRouter ids → OpenRouter) ---------- */
async function callClaude(prompt, model) {
  return runModel(prompt, model, { anthropic: settings.anthropicKey, openrouter: settings.openrouterKey }, {
    referer: location.origin, title: 'Routiner',
  });
}

/* ---------- Rendering ---------- */
/* A one-off (recurrence 'none') is "past" once it has fired (a run logged for
   it) or its scheduled time has elapsed. Past one-offs drop out of *Scheduled*
   — they are no longer queued — and the run itself shows under History.
   They do NOT drop out of the Library: the Library is a permanent shelf of
   every routine you have made, so a one-off can always be re-run or
   re-scheduled. Only archiving takes a routine off the shelf. */
const isRecurringRoutine = (r) => (r.recurrence || 'none') !== 'none';
function firedRoutineIds() {
  const s = new Set();
  runs.forEach((x) => { if (x.routineId) s.add(x.routineId); });
  return s;
}
function isPastOneOff(r, fired) {
  if (isRecurringRoutine(r)) return false;          // recurring never goes "past"
  if (r.lastRun) return true;                        // recorded a run
  if (fired && fired.has(r.id)) return true;         // has an entry in routiner_runs
  if (r.scheduledAt && new Date(r.scheduledAt).getTime() <= Date.now()) return true; // scheduled time elapsed
  return false;
}
/* The History feed: every logged run, plus past one-off routines that never
   logged a run (e.g. fired by the external trigger, or simply elapsed), so a
   finished one-off always surfaces somewhere. Newest first. */
function historyItems() {
  const fired = firedRoutineIds();
  const items = runs.map((run) => ({
    id: 'run-' + run.id, runId: run.id, title: run.title, status: run.status || 'ran',
    output: run.output, time: run.firedAt, startedAt: run.startedAt, routineId: run.routineId,
    messages: run.messages, model: run.model, account: run.account, triggerKey: run.triggerKey, tools: run.tools,
  }));
  routines.forEach((r) => {
    if (r.status === 'archived') return;
    if (!isPastOneOff(r, fired)) return;
    if (fired.has(r.id)) return;                     // already shown via its run row(s)
    items.push({ id: 'rt-' + r.id, title: r.title || 'Untitled', status: 'ran',
      output: r.prompt || '', time: r.scheduledAt || r.lastRun || r.updatedAt });
  });
  items.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
  return items;
}
function counts() {
  const fired = firedRoutineIds();
  const c = { scheduled: 0, library: 0, archived: 0, history: 0, historyFail: 0, board: notes.filter((n) => n.status === 'active').length };
  routines.forEach((r) => {
    if (r.status === 'archived') { c.archived++; return; }
    // Scheduled counts only what is still queued; a fired one-off is not.
    if (r.status === 'scheduled' && !isPastOneOff(r, fired)) c.scheduled++;
    // The Library is every non-archived routine — scheduled ones stay live in
    // it, and fired one-offs stay on the shelf. Only archiving removes one.
    c.library++;
  });
  const items = historyItems();
  c.history = items.length;
  c.historyFail = items.filter((it) => it.status === 'error' || it.status === 'missed').length;
  return c;
}
function paintCounts() {
  const c = counts();
  $$('[data-count]').forEach((el) => {
    el.textContent = c[el.dataset.count] ?? 0;
    // The History tab glows only when something actually needs attention
    // (a failed or missed run), not merely because history is non-empty.
    if (el.classList.contains('tab__count--alert')) el.classList.toggle('is-hot', (c.historyFail ?? 0) > 0);
  });
}

/* ---------- Budget forecast (estimated future spend) ----------
   Predicts what the scheduled queue will cost before it runs: each routine's
   per-run estimate (prompt length → input tokens + an assumed output size,
   priced at the model's per-token rates) times how often its recurrence fires.
   Estimates, not bills — Claude routines run on your Claude subscription and
   are shown at API-equivalent rates so models stay comparable. */
const RUNS_PER_DAY = { daily: 1, weekdays: 5 / 7, weekly: 1 / 7 };
function costForecast() {
  const fired = firedRoutineIds();
  const rows = []; let perDay = 0; let oneOff = 0;
  routines.forEach((r) => {
    if (r.status !== 'scheduled') return;
    const est = estimateRunCost(r);
    if (!est) return; // unpriced model (e.g. openrouter/auto)
    const rec = r.recurrence || 'none';
    if (rec === 'none') {
      if (isPastOneOff(r, fired)) return;
      oneOff += est.usd;
      rows.push({ r, est, perDay: 0, oneOff: est.usd });
    } else {
      const rpd = RUNS_PER_DAY[rec] || 0;
      perDay += est.usd * rpd;
      rows.push({ r, est, perDay: est.usd * rpd, oneOff: 0 });
    }
  });
  rows.sort((a, b) => (b.perDay + b.oneOff) - (a.perDay + a.oneOff));
  return { rows, perDay, oneOff };
}
/* Projected spend for each of the next 7 days (today first), driven by the
   same recurrence projection the calendar uses. */
function next7DayCosts() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const day = addDays(today, i);
    let usd = 0;
    routines.forEach((r) => {
      if (r.status !== 'scheduled' || !occursOn(r, day)) return;
      if ((r.recurrence || 'none') === 'none' && new Date(r.scheduledAt).getTime() <= Date.now()) return; // already elapsed
      const est = estimateRunCost(r);
      if (est) usd += est.usd;
    });
    return { day, usd };
  });
}
function paintBudgetChip() {
  const el = $('#budgetChip'); if (!el) return;
  const { rows, perDay, oneOff } = costForecast();
  if (!rows.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = perDay > 0
    ? `est <b>${fmtUSD(perDay)}</b>/day${oneOff > 0 ? ` +${fmtUSD(oneOff)} queued` : ''}`
    : `est <b>${fmtUSD(oneOff)}</b> queued`;
}
function openForecast() {
  editingId = null;
  drawerTitle.textContent = 'Budget forecast';
  const { rows, perDay, oneOff } = costForecast();
  if (!rows.length) {
    drawerBody.innerHTML = `<div class="empty"><h3>Nothing to forecast</h3><p>Schedule a routine (on a model with known pricing) and its projected cost shows up here.</p></div>`;
    drawerFoot.innerHTML = '';
    overlay.classList.add('is-open');
    return;
  }
  const days = next7DayCosts();
  const maxUsd = Math.max(...days.map((d) => d.usd), 1e-9);
  const maxIdx = days.findIndex((d) => d.usd === Math.max(...days.map((x) => x.usd)));
  const bars = days.map((d, i) => {
    const hPct = d.usd > 0 ? Math.max(6, (d.usd / maxUsd) * 100) : 0;
    const lbl = d.day.toLocaleDateString([], { weekday: 'short' });
    const showVal = d.usd > 0 && (i === 0 || i === maxIdx); // label today + the peak; tooltips carry the rest
    return `<div class="fc__col" title="${esc(lbl)} · ${fmtUSD(d.usd)} projected">
      <div class="fc__val">${showVal ? fmtUSD(d.usd) : ''}</div>
      <div class="fc__barwrap"><div class="fc__bar" style="height:${hPct}%"></div></div>
      <div class="fc__lbl">${i === 0 ? 'Today' : esc(lbl)}</div>
    </div>`;
  }).join('');
  const tile = (label, v) => `<div class="fc__tile"><div class="fc__tile-v">${fmtUSD(v)}</div><div class="fc__tile-l">${label}</div></div>`;
  const rowHtml = ({ r, est, perDay: pd, oneOff: oo }) => `
    <div class="fc__row">
      <span class="acct-dot" style="background:${triggerColor(r.account, r.triggerKey).solid}"></span>
      <span class="fc__row-title">${esc(r.title) || 'Untitled'}</span>
      <span class="fc__row-model">${esc(modelLabel(est.model))}</span>
      <span class="fc__row-cost" title="${fmtUSD(est.usd)} per run, ${esc(RECURRENCE[r.recurrence] || 'One-time')}">${pd > 0 ? `${fmtUSD(pd)}/day` : `${fmtUSD(oo)} once`}</span>
    </div>`;
  drawerBody.innerHTML = `
    <div class="notice">Estimates from prompt length (~4 chars/token, plus session overhead and an assumed ~2k-token reply), priced at each model's per-token rates. Claude routines run on your Claude subscription — shown at API-equivalent rates so you can compare. Use this to budget, not to bill.</div>
    <div class="fc__tiles">
      ${tile('per hour', perDay / 24)}${tile('per day', perDay)}${tile('per week', perDay * 7)}${tile('per month', perDay * 30)}${oneOff > 0 ? tile('one-time queued', oneOff) : ''}
    </div>
    <div class="cfg-sep">Next 7 days</div>
    <div class="fc__chart">${bars}</div>
    <div class="cfg-sep">By routine (most expensive first)</div>
    <div class="fc__rows">${rows.map(rowHtml).join('')}</div>
    <span class="hint">Cheaper model for a heavy routine? Edit it and watch the per-run estimate in the drawer update as you switch.</span>`;
  drawerFoot.innerHTML = '';
  overlay.classList.add('is-open');
}
function paintStatus() {
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const next = routines.filter((r) => r.status === 'scheduled' && r.scheduledAt).sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))[0];
  const clk = $('#clock');
  if (clk) {
    // Two spans so a tight top rail can drop the wall clock but keep "next in …".
    clk.innerHTML = next
      ? `<span class="clock__now">${t} · </span><span class="clock__next">next <b>${relative(next.scheduledAt)}</b></span>`
      : `<span class="clock__now">${t}</span>`;
    clk.classList.toggle('clock--next', !!next);
  }
}

function render() {
  if (!session) return;
  paintCounts(); paintStatus(); paintBudgetChip();
  // History owns its whole pane (its own columns scroll); every other view rides
  // the normal page scroll.
  $('.content')?.classList.toggle('content--flush', currentView === 'history');
  document.body.dataset.view = currentView;
  if (currentView === 'board') return renderBoard();
  if (currentView === 'calendar') return renderCalendar();
  if (currentView === 'history') return renderHistory();
  const fired = firedRoutineIds();
  const items = routines.filter((r) => {
    // Library = every non-archived routine, scheduled ones included (they stay
    // live in the Library; only archiving takes a routine off the air).
    if (currentView === 'library' ? r.status === 'archived' : r.status !== currentView) return false;
    if (currentView === 'archived') return true;
    // The Library is permanent: a routine you made stays on the shelf even after
    // a one-off has fired, so you can re-run or re-schedule it. Only archiving
    // takes one off. (Scheduled still drops past one-offs — they are no longer
    // queued — and History still records the run itself.)
    if (currentView === 'library') return true;
    return !isPastOneOff(r, fired); // Scheduled: past one-offs are no longer queued
  }).sort((a, b) =>
    currentView === 'scheduled' ? new Date(a.scheduledAt || 0) - new Date(b.scheduledAt || 0) : new Date(b.updatedAt) - new Date(a.updatedAt));
  if (!items.length) return renderEmpty();
  view.innerHTML = `<div class="grid">${items.map(card).join('')}</div>`;
  bindCards();
}

function renderEmpty() {
  const copy = {
    scheduled: ['No routines queued', 'Create a routine and give it a time to line it up here.'],
    library: ['Your library is empty', 'Every routine you keep lives here — scheduled ones stay live on the calendar too. Only archiving takes one off the air.'],
    archived: ['Nothing archived', 'Archived routines rest here. Restore them to the library anytime.'],
  }[currentView];
  view.innerHTML = `<div class="grid"><div class="empty"><h3>${copy[0]}</h3><p>${copy[1]}</p>
    <button class="btn btn--primary" data-act="new">New routine</button></div></div>`;
  $('[data-act="new"]', view)?.addEventListener('click', () => openDrawer());
}

function statusChip(r) {
  if (r.status === 'scheduled') {
    const due = r.scheduledAt && new Date(r.scheduledAt).getTime() <= Date.now();
    return due ? `<span class="chip chip--due">due</span>` : `<span class="chip chip--scheduled">scheduled</span>`;
  }
  return `<span class="chip chip--${r.status}">${r.status}</span>`;
}
function card(r) {
  let recur = '';
  if (r.recurrence && r.recurrence !== 'none') {
    // Hover the recurrence chip to preview the next few fire times.
    const upcoming = nextOccurrences(r.scheduledAt, r.recurrence, 3).map((iso) => fmt(iso)).join('\n');
    const tip = upcoming ? ` title="Next runs:\n${esc(upcoming)}"` : '';
    recur = `<span class="chip chip--recurring"${tip}>${esc(RECURRENCE[r.recurrence])}</span>`;
  }
  const when = r.status === 'scheduled'
    ? `<span class="card__meta-item">fires <b>${fmt(r.scheduledAt)}</b> · ${relative(r.scheduledAt)}</span>`
    : (r.lastRun ? `<span class="card__meta-item">last run <b>${fmt(r.lastRun)}</b></span>` : '');
  const modelName = displayModel(r);
  const est = estimateRunCost(r);
  const cost = est ? `<span class="card__meta-item" title="Estimated cost per run (input + output, API rates)">est <b>${fmtUSD(est.usd)}</b>/run</span>` : '';
  const tLabel = triggerLabel(r.account, r.triggerKey);
  const acctText = accountLabel(r.account) + (tLabel ? ` · ${tLabel}` : '');
  return `<article class="card" data-id="${r.id}">
    <div class="card__head"><span class="card__title">${esc(r.title) || '<em>Untitled routine</em>'}</span>${statusChip(r)}</div>
    <div class="card__prompt">${esc(r.prompt) || '(no prompt)'}</div>
    <div class="card__meta">${recur}<span class="card__meta-item"><span class="acct-dot" style="background:${triggerColor(r.account, r.triggerKey).solid}"></span><b>${esc(acctText)}</b></span><span class="card__meta-item"><b>${esc(modelName)}</b></span><span class="card__meta-item"><b>${fmtDuration(r.durationMin || DEFAULT_DURATION_MIN)}</b></span>${cost}${when}</div>
    <div class="card__foot">${cardActions(r)}</div>
  </article>`;
}
function cardActions(r) {
  const run = `<button class="btn btn--accent btn--sm" data-act="run">Run now</button>`;
  const edit = `<button class="btn btn--secondary btn--sm" data-act="edit">Edit</button>`;
  const del = `<button class="btn btn--danger-ghost btn--sm" data-act="delete">Delete</button>`;
  if (r.status === 'archived') return `<button class="btn btn--secondary btn--sm" data-act="library">Restore</button>${del}`;
  const mid = r.status === 'scheduled'
    ? `<button class="btn btn--secondary btn--sm" data-act="library">Unschedule</button>`
    : `<button class="btn btn--primary btn--sm" data-act="schedule">Schedule</button>`;
  const dup = `<button class="btn btn--ghost btn--sm" data-act="duplicate">Copy</button>`;
  const arch = `<button class="btn btn--ghost btn--sm" data-act="archive">Archive</button>`;
  return `${run}${mid}${edit}${dup}${arch}${del}`;
}

function bindCards() {
  $$('.card', view).forEach((el) => {
    el.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]'); if (!btn) return;
      const r = getRoutine(el.dataset.id); if (!r) return;
      const act = btn.dataset.act;
      if (act === 'edit') return openDrawer(r);
      if (act === 'schedule') return openDrawer(r, { forceSchedule: true });
      if (act === 'run') {
        // Claim first (advance recurrence / park one-off) so the scheduler won't
        // also fire this due-now slot — that was creating duplicate agent runs.
        await claimManualFire(r);
        render(); await fireTrigger(r); return;
      }
      if (act === 'duplicate') {
        const made = await dbCreate({ title: (r.title || 'Untitled') + ' (copy)', prompt: r.prompt, model: r.model, taskType: r.taskType, complexity: r.complexity, recurrence: r.recurrence, status: 'library', scheduledAt: null });
        if (made) { render(); toast('Duplicated to Library.'); } return;
      }
      if (act === 'library' || act === 'archive') {
        await dbUpdate(r.id, Object.assign({}, r, { status: act === 'archive' ? 'archived' : 'library', scheduledAt: null }));
        render(); toast(act === 'archive' ? 'Archived — off the air.' : (r.status === 'archived' ? 'Restored to Library.' : 'Unscheduled — still in your Library.')); return;
      }
      if (act === 'delete') {
        if (!confirm('Delete this routine permanently?')) return;
        if (await dbDelete(r.id)) { render(); toast('Deleted.'); }
      }
    });
  });
}

/* ---------- Board (comment board / intake) ---------- */
function noteActions(n) {
  const del = `<button class="btn btn--danger-ghost btn--sm" data-nact="delete">Delete</button>`;
  const sched = `<button class="btn btn--primary btn--sm" data-nact="schedule">Schedule</button>`;
  if (n.status === 'brainstorm') return `<button class="btn btn--secondary btn--sm" data-nact="activate">Activate</button>${sched}<button class="btn btn--ghost btn--sm" data-nact="dismiss">Dismiss</button>${del}`;
  if (n.status === 'active') return `${sched}<button class="btn btn--secondary btn--sm" data-nact="brainstorm">To brainstorm</button><button class="btn btn--ghost btn--sm" data-nact="done">Done</button>${del}`;
  return `<button class="btn btn--ghost btn--sm" data-nact="activate">Reactivate</button><button class="btn btn--ghost btn--sm" data-nact="brainstorm">To brainstorm</button>${del}`;
}
function noteRow(n) {
  return `<div class="note note--${n.status}" data-id="${n.id}">
    <div class="note__body">${esc(n.body)}</div>
    <div class="note__foot">
      <span class="chip chip--note-${n.status}">${esc(NOTE_STATUS[n.status] || n.status)}</span>
      <span class="note__time">${relative(n.createdAt)}</span>
      <span class="note__actions">${noteActions(n)}</span>
    </div>
  </div>`;
}
function renderBoard() {
  const ordered = [...notes].sort((a, b) => (NOTE_ORDER[a.status] ?? 9) - (NOTE_ORDER[b.status] ?? 9) || new Date(b.createdAt) - new Date(a.createdAt));
  view.innerHTML = `<div class="board">
    <div class="board__compose">
      <textarea class="textarea board__input" id="note-input" placeholder="Drop tasks, ideas, or context here — one note or a whole brain-dump.&#10;&#10;Post as Brainstorm to park an idea (Claude leaves it alone), or Active to signal Claude should plan and work it."></textarea>
      <div class="board__compose-foot">
        <span class="hint"><b>Active</b> = Claude works it · <b>Brainstorm</b> = parked, ignored until you activate it.</span>
        <span class="board__compose-btns">
          <button class="btn btn--secondary" id="note-draft">Save as brainstorm</button>
          <button class="btn btn--primary" id="note-active">Post as active</button>
        </span>
      </div>
    </div>
    ${ordered.length
      ? `<div class="board__feed">${ordered.map(noteRow).join('')}</div>`
      : `<div class="empty"><h3>The board is empty</h3><p>Drop a note above. Park it as <b>Brainstorm</b> while you think, or post it <b>Active</b> when it's ready for Claude.</p></div>`}
  </div>`;

  const input = $('#note-input');
  const postAs = async (status, btn) => {
    const body = input.value.trim();
    if (!body) { input.focus(); return; }
    btn.disabled = true;
    const made = await dbCreateNote(body, status);
    btn.disabled = false;
    if (made) { input.value = ''; render(); toast(status === 'active' ? 'Posted — active for Claude.' : 'Saved to brainstorm.'); }
  };
  $('#note-active').addEventListener('click', (e) => postAs('active', e.currentTarget));
  $('#note-draft').addEventListener('click', (e) => postAs('brainstorm', e.currentTarget));
  input.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') postAs('active', $('#note-active')); });

  $$('.note', view).forEach((el) => el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-nact]'); if (!btn) return;
    const id = el.dataset.id, act = btn.dataset.nact;
    if (act === 'delete') { if (await dbDeleteNote(id)) render(); return; }
    if (act === 'schedule') { const n = notes.find((x) => x.id === id); if (n) scheduleFromNote(n); return; }
    const status = { activate: 'active', brainstorm: 'brainstorm', done: 'done', dismiss: 'dismissed' }[act];
    if (status && await dbUpdateNote(id, { status })) render();
  }));
}

/* ---------- History (the single record of every run) ----------
   History is both the friendly recap AND the full technical record (the old
   separate Log tab is folded in here — issue #52). Each row shows plain-English
   status + a cleaned-up summary; click it to open the full exchange, see exactly
   what the model returned (issue #51), and — for agent runs — reply to keep the
   conversation going with the same model and tools. */
const FRIENDLY_STATUS = {
  success: 'Completed', ran: 'Ran', dryrun: 'Test run', running: 'Still working',
  error: 'Had a problem', missed: 'Missed its time', cancelled: 'Stopped',
};
// Client-side mirror of SCHEDULER_REAP_RUN_MIN (10 min). A running row quieter
// than this is almost certainly a dead edge invocation; show "May have stalled"
// until the scheduler reaper flips it to error.
const RUN_STALE_MS = 10 * 60 * 1000;
const RETRY_PROMPT = '[retry] Resume the task from the transcript and finish it.';
function isRunStale(it) {
  return !!(it && it.status === 'running' && it.time && (Date.now() - new Date(it.time).getTime()) > RUN_STALE_MS);
}
function isRunBusy(it) {
  return !!(it && it.status === 'running' && !isRunStale(it));
}
// Live-refresh History while any run is working so the spinner + step text stay honest.
let historyPollTimer = null;
function ensureHistoryPoll() {
  if (historyPollTimer) return;
  historyPollTimer = setInterval(async () => {
    if (currentView !== 'history') {
      clearInterval(historyPollTimer); historyPollTimer = null; return;
    }
    const hasRunning = runs.some((r) => r.status === 'running');
    if (!hasRunning && !runBusy) return;
    try {
      await loadAll();
      refreshHistory();
    } catch { /* transient */ }
  }, 8_000);
}
function assistantThoughtText(m) {
  if (!m || typeof m !== 'object') return '';
  if (typeof m.reasoning === 'string' && m.reasoning.trim()) return m.reasoning.trim();
  if (typeof m.reasoning_content === 'string' && m.reasoning_content.trim()) return m.reasoning_content.trim();
  if (Array.isArray(m.reasoning_details)) {
    return m.reasoning_details
      .map((d) => (typeof d?.text === 'string' ? d.text : (typeof d?.summary === 'string' ? d.summary : '')))
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
  return '';
}
/* Strip an output down to readable prose: drop code blocks, URLs, markdown
   syntax and JSON noise, keep the sentences. */
function friendlyText(raw) {
  let s = String(raw || '');
  s = s.replace(/```[\s\S]*?```/g, ' ');                 // fenced code blocks
  s = s.replace(/`[^`\n]*`/g, ' ');                      // inline code
  s = s.replace(/https?:\/\/\S+/g, '');                  // links
  s = s.replace(/^#{1,6}\s+/gm, '');                     // headings
  // Markdown marks, but not `#` or `_` on their own: those carry meaning in the
  // text this app summarises — "PR #118" must not become "PR 118", and
  // gh_propose_edit must not become gh propose edit. Headings are already gone
  // (the line-anchored rule above), and `_emphasis_` only loses its underscores
  // when they actually wrap a word.
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1$2')
    .replace(/[*~>|]/g, ' ');
  s = s.replace(/^[\s]*[-•=]{3,}[\s]*$/gm, ' ');         // rules
  s = s.replace(/[{}[\]\\]/g, ' ');                      // JSON-ish brackets
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length > 420) s = s.slice(0, 420).replace(/\s+\S*$/, '') + '…';
  return s;
}
/* Any run row can be replied to. The openrouter-agent function's continue path
   seeds a system prompt and uses the row's stored `output` as the assistant turn
   when there's no transcript, and falls back to the default model when the row
   carries none — so a lead-enrichment recap or a Claude-trigger report is just
   as answerable as a full agent thread. The only rows that aren't are the ones
   synthesised from a routine that never logged a run: there is no run to
   continue. */
function isContinuable(it) { return !!(it && it.runId); }
/* Retry and Stop mean "resume this agent's own work", so they stay on rows that
   actually were an agent run — retrying a lead-enrichment row would run the
   agent loop, not the enrichment engine, which isn't what the button says. */
function isAgentRun(it) { return !!(it && it.runId && (it.model || (Array.isArray(it.messages) && it.messages.length))); }

/* ══════════════════════════════════════════════════════════════
   History — a flat two-pane workspace, Claude Code style.
   The left rail lists every run; the right pane holds the selected run's whole
   exchange flush against the UI (no modal, no overlay), with the reply box
   pinned to the bottom. On narrow screens the rail slides over the transcript.
   ══════════════════════════════════════════════════════════════ */
let historyFilter = 'all';   // 'all' | 'failures'
let historyQuery = '';       // rail search box
let selectedRunId = null;    // the historyItems id shown in the pane
let railOpen = false;        // mobile: is the run list slid over the pane?
let confirmDeleteId = null;  // the row currently asking "delete this run?"
let swipedRowId = null;      // the row swiped open to reveal Delete (touch)
let runBusy = false;         // a follow-up is in flight
const runDrafts = new Map(); // id → unsent reply text, so re-renders never eat it

/* Compact rail timestamp: clock time for today, date for anything older. */
function fmtShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/* ---------- How long a run took ----------
   A run has two stamps and they are not the same thing: `startedAt` is when it
   began, `time` (fired_at) is its LAST activity — the agent bumps that at every
   checkpoint. The gap between them is the elapsed time, which is what History
   shows so a 40-minute run reads differently from a 4-second one. Runs recorded
   before started_at existed return null and show no duration at all rather than
   an invented one. */
function runStartIso(it) { return it && (it.startedAt || null); }
function runElapsedMs(it) {
  const startIso = runStartIso(it);
  if (!startIso || !it.time) return null;
  const start = new Date(startIso).getTime();
  // A live run is still counting; a finished one stopped at its last checkpoint.
  const end = isRunBusy(it) ? Date.now() : new Date(it.time).getTime();
  const ms = end - start;
  return ms >= 0 ? ms : null;
}
/* Coarse, readable elapsed time — the unit that matters, not six digits. */
function fmtDur(ms) {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${Math.max(s, 1)}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}
/* A thread you replied to spans your thinking time too, so it gets "over", not
   "took" — the elapsed number is honest either way, the verb keeps it from
   claiming the model worked that whole time. */
function runRounds(it) {
  const msgs = Array.isArray(it && it.messages) ? it.messages : [];
  return msgs.filter((m) => m && m.role === 'user').length;
}
function runDurationLabel(it) {
  const ms = runElapsedMs(it);
  if (ms == null) return '';
  if (isRunBusy(it)) return `running ${fmtDur(ms)}`;
  return `${runRounds(it) > 1 ? 'over' : 'took'} ${fmtDur(ms)}`;
}

/* ---------- The last bit of work a run did ----------
   The stored `output` is the run's summary, which for a long agent run says
   nothing about where it actually got to. Read the transcript backwards instead
   so every row shows its most recent real move — the last thing said, or the
   last tool it reached for — and falls back to the summary when there's no
   transcript to read. */
function lastWorkText(it) {
  const msgs = Array.isArray(it && it.messages) ? it.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role === 'system' || m.role === 'user') continue;
    if (m.role === 'assistant') {
      const text = friendlyText(m.content);
      if (text) return text;
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      const last = calls[calls.length - 1];
      if (last) {
        const name = last?.function?.name || 'tool';
        let args = last?.function?.arguments || '';
        try { args = Object.values(JSON.parse(args)).filter((v) => typeof v === 'string')[0] || ''; } catch { /* raw */ }
        return `⚙ ${name}${args ? ` — ${String(args).slice(0, 80)}` : ''}`;
      }
    }
    if (m.role === 'tool') {
      const text = friendlyText(m.content);
      if (text) return `⚙ result — ${text.slice(0, 120)}`;
    }
  }
  return friendlyText(it && it.output);
}

function historyFiltered() {
  const all = historyItems();
  const failures = all.filter((it) => it.status === 'error' || it.status === 'missed');
  let items = historyFilter === 'failures' ? failures : all;
  const q = historyQuery.trim().toLowerCase();
  if (q) items = items.filter((it) => `${it.title || ''} ${it.output || ''}`.toLowerCase().includes(q));
  return { all, failures, items };
}

/* The run in the pane — falling back to the newest one that survives the active
   filter, so the pane is never blank while runs exist. */
function selectedRun(items) {
  const list = items || historyFiltered().items;
  return list.find((x) => x.id === selectedRunId) || list[0] || null;
}

function railRowHtml(it, active) {
  const ok = !(it.status === 'error' || it.status === 'missed' || it.status === 'cancelled');
  const busy = isRunBusy(it);
  const stale = isRunStale(it);
  const statusLabel = stale ? 'May have stalled' : (FRIENDLY_STATUS[it.status] || it.status);
  const statusClass = stale ? 'is-warn' : (busy ? 'is-busy' : (ok ? 'is-ok' : 'is-bad'));
  const spin = busy ? '<span class="hist__spin" aria-hidden="true"></span>' : '';
  // The last thing this run actually did, not its opening summary.
  const snip = lastWorkText(it);
  // Stamped when it began (falling back to last activity on pre-started_at rows),
  // with how long it ran beside it.
  const startIso = runStartIso(it) || it.time;
  const dur = fmtDur(runElapsedMs(it));
  const confirming = confirmDeleteId === it.id;
  const cls = ['hxrow', active ? 'is-active' : '', ok ? '' : 'hxrow--bad', busy ? 'hxrow--busy' : '', stale ? 'hxrow--stale' : '',
    confirming ? 'hxrow--confirm' : ''].filter(Boolean).join(' ');
  const tip = [it.title || 'Untitled', startIso ? `started ${fmt(startIso)}` : '', runDurationLabel(it)].filter(Boolean).join(' · ');
  // Only run-backed rows can be deleted — a row synthesised from a routine has
  // no run to remove. A live run has to be stopped first, so it doesn't get one
  // either (deleting the row mid-write just orphans the agent's checkpoints).
  const del = (it.runId && !busy)
    ? `<button type="button" class="hxrow__del" data-del="${esc(it.id)}" title="Delete this run" aria-label="Delete this run">🗑</button>`
    : '';
  const swiped = swipedRowId === it.id;
  const sub = confirming
    ? `<span class="hxrow__sub hxrow__sub--confirm">
        <span class="hxrow__ask">Delete this run?</span>
        <button type="button" class="hxrow__cbtn hxrow__cbtn--yes" data-delyes="${esc(it.id)}">Delete</button>
        <button type="button" class="hxrow__cbtn" data-delno="1">Cancel</button>
      </span>`
    : `<span class="hxrow__sub">
        <span class="hxrow__status hist__status ${statusClass}">${spin}${esc(statusLabel)}</span>
        ${snip ? `<span class="hxrow__snip">${esc(snip)}</span>` : ''}
      </span>`;
  // A div, not a button: the delete control is a real button and buttons cannot
  // nest. Keyboard activation is wired by hand below to keep it operable.
  return `<div class="${cls}${swiped ? ' is-swiped' : ''}" data-hist="${esc(it.id)}" role="button" tabindex="0"${active ? ' aria-current="true"' : ''} title="${esc(tip)}">
    <span class="hxrow__body">
      <span class="hxrow__top">
        <span class="hxrow__title">${esc(it.title || 'Untitled')}</span>
        <span class="hxrow__time">${esc(fmtShort(startIso))}${dur ? ` · ${esc(dur)}` : ''}</span>
        ${del}
      </span>
      ${sub}
    </span>
    ${del ? `<button type="button" class="hxrow__swipedel" data-swipedel="${esc(it.id)}" tabindex="-1" aria-hidden="${swiped ? 'false' : 'true'}">Delete</button>` : ''}
  </div>`;
}

function railListHtml(items) {
  if (items.length) return items.map((it) => railRowHtml(it, it.id === selectedRunId)).join('');
  return `<div class="hx__none">${historyQuery.trim()
    ? 'Nothing matches that search.'
    : (historyFilter === 'failures' ? 'Nothing has failed or missed its slot. 🎉' : 'No runs yet.')}</div>`;
}

function renderHistory() {
  const { all, failures, items } = historyFiltered();
  if (!all.length) {
    view.innerHTML = `<div class="hx"><section class="hx__main"><div class="hx__blank"><div class="empty">
      <h3>Nothing here yet</h3>
      <p>Finished runs land here — pick one from the list to read the whole exchange, and reply to keep it going.</p>
    </div></div></section></div>`;
    return;
  }
  // The workspace is already up (a live poll, a filter flip): refresh it in
  // place so the search box keeps focus and the reader keeps their place.
  if ($('#hx')) { refreshHistory(); return; }
  const current = selectedRun(items);
  selectedRunId = current ? current.id : null;
  view.innerHTML = `<div class="hx${railOpen ? ' is-rail-open' : ''}" id="hx">
    <div class="hx__scrim" id="hx-scrim"></div>
    <aside class="hx__rail" id="hx-rail">
      <div class="hx__rail-head">
        <span class="hx__rail-title">Chat · ${all.length} run${all.length === 1 ? '' : 's'}</span>
        <input class="input hx__search" id="hx-search" type="search" placeholder="Search runs…" value="${esc(historyQuery)}" />
        <div class="log__filter">
          <button class="btn btn--sm ${historyFilter === 'all' ? 'btn--secondary' : 'btn--ghost'}" data-histf="all">All <span id="hx-fall">${all.length}</span></button>
          <button class="btn btn--sm ${historyFilter === 'failures' ? 'btn--secondary' : 'btn--ghost'}" data-histf="failures">Failures <span id="hx-ffail">${failures.length}</span></button>
        </div>
      </div>
      <div class="hx__list" id="hx-list">${railListHtml(items)}</div>
    </aside>
    <section class="hx__main" id="hx-main">${runPaneHtml(current)}</section>
  </div>`;
  wireRail();
  wireRunPane(current);
  fitHistoryPane();
  const thread = $('#hx-thread', view);
  if (thread) thread.scrollTop = thread.scrollHeight;
  ensureHistoryPoll();
}

/* Re-render just the rail list — keeps the search box's value and focus. */
function refreshRail() {
  const list = $('#hx-list'); if (!list) return;
  const { all, failures, items } = historyFiltered();
  const top = list.scrollTop;
  list.innerHTML = railListHtml(items);
  const a = $('#hx-fall'); if (a) a.textContent = all.length;
  const f = $('#hx-ffail'); if (f) f.textContent = failures.length;
  list.scrollTop = top;
  wireRailRows();
}

function wireRailRows() {
  $$('#hx-list [data-hist]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-del],[data-delyes],[data-delno]')) return; // delete owns those
      selectRun(el.dataset.hist);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectRun(el.dataset.hist); }
    });
  });
  $$('#hx-list [data-del]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmDeleteId = b.dataset.del;
    refreshRail();
  }));
  $$('#hx-list [data-delno]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmDeleteId = null;
    refreshRail();
  }));
  $$('#hx-list [data-delyes]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteRun(b.dataset.delyes);
  }));
  $$('#hx-list [data-swipedel]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteRun(b.dataset.swipedel);   // the swipe was the first half of the confirmation
  }));
  $$('#hx-list [data-hist]').forEach(wireRowSwipe);
}

/* Swipe a row left to reveal Delete — the iOS list gesture, and what the Claude
   app does. This is the touch affordance: the hover trash is useless on iPadOS,
   where a tap fakes :hover and the next tap takes it away again (which is why
   deleting worked exactly once). `touch-action: pan-y` on the row keeps vertical
   scrolling native while we own the horizontal axis. */
const SWIPE_W = 88;    // how far the row slides, matching the button's width
function wireRowSwipe(row) {
  const body = row.querySelector('.hxrow__body');
  const canDelete = !!row.querySelector('[data-swipedel]');
  if (!body || !canDelete) return;
  let x0 = 0, y0 = 0, dx = 0, tracking = false, decided = false;

  const setOffset = (px, animate) => {
    body.style.transition = animate ? '' : 'none';
    body.style.transform = px ? `translateX(${px}px)` : '';
  };
  row.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    dx = 0; tracking = true; decided = false;
  }, { passive: true });

  row.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const t = e.touches[0];
    const mx = t.clientX - x0, my = t.clientY - y0;
    if (!decided) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      // A mostly-vertical drag is a scroll — let the list have it, for good.
      if (Math.abs(my) > Math.abs(mx)) { tracking = false; return; }
      decided = true;
      if (swipedRowId && swipedRowId !== row.dataset.hist) closeSwipedRow();
    }
    const open = swipedRowId === row.dataset.hist ? -SWIPE_W : 0;
    dx = Math.max(-SWIPE_W, Math.min(0, open + mx));
    setOffset(dx, false);
  }, { passive: true });

  const end = () => {
    if (!tracking) return;
    tracking = false;
    if (!decided) return;
    const open = dx < -SWIPE_W / 2;
    swipedRowId = open ? row.dataset.hist : null;
    row.classList.toggle('is-swiped', open);
    const btn = row.querySelector('[data-swipedel]');
    if (btn) btn.setAttribute('aria-hidden', open ? 'false' : 'true');
    setOffset(0, true);   // the class carries the open position from here
  };
  row.addEventListener('touchend', end, { passive: true });
  row.addEventListener('touchcancel', end, { passive: true });
}

function closeSwipedRow() {
  if (!swipedRowId) return;
  const el = $(`#hx-list [data-hist="${CSS.escape(swipedRowId)}"]`);
  if (el) {
    el.classList.remove('is-swiped');
    const body = el.querySelector('.hxrow__body');
    if (body) { body.style.transition = ''; body.style.transform = ''; }
  }
  swipedRowId = null;
}

/* Delete one run for good. Two taps (trash → Delete) because there is no undo:
   the row is the only copy of that transcript. */
async function deleteRun(id) {
  const it = historyItems().find((x) => x.id === id);
  if (!it || !it.runId) return;
  const { error } = await sb.from('routiner_runs').delete().eq('id', it.runId);
  if (error) { toast('Delete failed: ' + error.message, 'error'); return; }
  runs = runs.filter((r) => r.id !== it.runId);
  runDrafts.delete(id);
  confirmDeleteId = null;
  swipedRowId = null;
  if (selectedRunId === id) selectedRunId = null;   // fall back to the newest
  toast('Run deleted.');
  paintCounts();
  renderHistory();
}

function wireRail() {
  wireRailRows();
  $$('#hx [data-histf]').forEach((b) => b.addEventListener('click', () => {
    historyFilter = b.dataset.histf;
    confirmDeleteId = null;
    selectedRunId = null;            // fall back to the newest run in the new filter
    renderHistory();
  }));
  const search = $('#hx-search');
  if (search) search.addEventListener('input', () => { historyQuery = search.value; refreshRail(); });
  $('#hx-scrim')?.addEventListener('click', () => setRail(false));
  wireRailSwipe();
}

/* Last-resort safety net for the pane's height.
   The CSS chain is deliberately boring — fixed-height shell, absolutely
   positioned #view, flex rows with min-height:0 — but this pane has now been
   stuck twice on iPadOS, and a workspace you cannot scroll is useless. So after
   every render we measure: from .hx's top edge, how much room is there before
   the bottom of the *visual viewport*? If the laid-out height disagrees by more
   than a pixel, pin it there in px. Measured space is engine-independent truth,
   so this is correct even if some ancestor's height never resolved. When the
   CSS works — every browser tested — the numbers already agree and nothing is
   written. */
function fitHistoryPane() {
  const hx = $('#hx'); if (!hx) return;
  const box = hx.getBoundingClientRect();
  const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight || 0;
  const avail = Math.round(vh - box.top);
  if (avail < 120) return;                       // nonsense measurement — leave it alone
  hx.style.height = Math.abs(Math.round(box.height) - avail) > 1 ? `${avail}px` : '';
  // Columns follow the pane; only pinned if they somehow outgrew it.
  const h = Math.round(hx.getBoundingClientRect().height);
  ['#hx-rail', '#hx-main'].forEach((sel) => {
    const el = $(sel); if (!el) return;
    el.style.height = Math.round(el.getBoundingClientRect().height) - h > 1 ? `${h}px` : '';
  });
}

/* Mobile: the run list slides over the transcript. */
function setRail(open) {
  railOpen = open;
  $('#hx')?.classList.toggle('is-rail-open', open);
}

/* Edge-swipe to reveal the list, swipe back to hide it — the gesture Claude
   Code's mobile layout uses. Desktop keeps both panes visible, so the class the
   CSS keys off is inert there. */
function wireRailSwipe() {
  const hx = $('#hx'); if (!hx) return;
  let x0 = null, y0 = null, armed = false;
  hx.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY;
    // A gesture that starts on a run row belongs to that row (swipe-to-delete),
    // never to the rail. The rail still closes via ☰, the scrim, Escape, or a
    // swipe starting on its header.
    if (e.target.closest('.hxrow')) { armed = false; return; }
    armed = railOpen || (t.clientX - hx.getBoundingClientRect().left) < 28;
  }, { passive: true });
  hx.addEventListener('touchend', (e) => {
    if (x0 == null || !armed) { x0 = null; armed = false; return; }
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.5) setRail(dx > 0);
    x0 = null; armed = false;
  }, { passive: true });
}

function selectRun(id) {
  // A tap while a row is swiped open just puts it away — same as iOS lists.
  if (swipedRowId) { closeSwipedRow(); return; }
  const it = historyItems().find((x) => x.id === id);
  if (!it) return;
  selectedRunId = id;
  $$('#hx-list [data-hist]').forEach((el) => {
    const on = el.dataset.hist === id;
    el.classList.toggle('is-active', on);
    if (on) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current');
  });
  setRail(false);
  renderRunPane(it, { focus: true });
}

/* ---------- The run pane (full exchange + continue) ----------
   The selected run as a conversation: the original task, the model's reply, any
   tool actions it took, and (for agent runs) a compose box. Follow-ups call the
   openrouter-agent function with { runId, prompt }, which resumes the stored
   transcript with the same model + tools and saves the whole thread back. */

/* Turn a stored transcript into display turns: user + assistant bubbles, with a
   compact line for each tool the model ran. Falls back to the single output blob
   for runs with no saved transcript. */
function transcriptTurns(it) {
  const msgs = Array.isArray(it.messages) ? it.messages : null;
  if (!msgs || !msgs.length) {
    return it.output ? [{ kind: 'assistant', content: it.output }] : [];
  }
  const turns = [];
  for (const m of msgs) {
    if (!m || m.role === 'system') continue;
    if (m.role === 'user') { turns.push({ kind: 'user', content: String(m.content || '') }); continue; }
    if (m.role === 'tool') { turns.push({ kind: 'toolresult', content: String(m.content || '') }); continue; }
    if (m.role === 'assistant') {
      // Thoughts stay collapsible and separate from the visible answer.
      const thought = assistantThoughtText(m);
      if (thought) turns.push({ kind: 'thought', content: thought });
      if (m.content && String(m.content).trim()) turns.push({ kind: 'assistant', content: String(m.content) });
      (Array.isArray(m.tool_calls) ? m.tool_calls : []).forEach((tc) => {
        const name = tc?.function?.name || 'tool';
        let args = tc?.function?.arguments || '';
        try { args = JSON.stringify(JSON.parse(args)); } catch { /* leave as-is */ }
        turns.push({ kind: 'tool', content: `${name}(${String(args).slice(0, 160)})` });
      });
    }
  }
  return turns;
}

/* Header stamp: when the run started and how long it ran — "09:12 · took 4m".
   The tooltip spells out both ends for anyone who wants the exact times. */
function runTimingChip(it) {
  const startIso = runStartIso(it);
  const label = runDurationLabel(it);
  if (!startIso) return { text: it.time ? fmt(it.time) : '', tip: it.time ? `Last activity ${fmt(it.time)}` : '' };
  return {
    text: `${fmt(startIso)}${label ? ` · ${label}` : ''}`,
    tip: `Started ${fmt(startIso)}\nLast activity ${fmt(it.time)}${label ? `\n${label}` : ''}`,
  };
}

function runPaneHtml(it) {
  if (!it) {
    return `<div class="hx__blank"><div class="empty">
      <h3>Pick a run</h3><p>Choose a run from the list to read its full exchange here.</p>
    </div></div>`;
  }
  const turns = transcriptTurns(it);
  const bubbles = turns.map((t) => {
    if (t.kind === 'user') return `<div class="chatmsg chatmsg--user">${esc(t.content)}</div>`;
    if (t.kind === 'tool') return `<div class="transcript__tool">⚙ ${esc(t.content)}</div>`;
    if (t.kind === 'toolresult') return `<details class="transcript__res"><summary>tool result</summary><pre>${esc(t.content.slice(0, 4000))}</pre></details>`;
    if (t.kind === 'thought') {
      return `<details class="transcript__thought"><summary><span class="transcript__thought-icon" aria-hidden="true">💭</span> Thoughts</summary><pre class="transcript__thought-body">${esc(t.content.slice(0, 12_000))}</pre></details>`;
    }
    return `<div class="chatmsg chatmsg--bot">${renderRunBody(t.content)}</div>`;
  }).join('') || `<div class="empty"><h3>Nothing was recorded</h3><p>This run has no saved output.</p></div>`;
  const can = isContinuable(it);
  const busy = isRunBusy(it);
  const stale = isRunStale(it);
  // Retry: error/cancelled + stale "running" rows — same continue path, fixed prompt.
  const agent = isAgentRun(it);
  const showRetry = agent && !runBusy && (it.status === 'error' || it.status === 'cancelled' || stale);
  const showStop = agent && !runBusy && (busy || stale || it.status === 'running');
  const statusLabel = stale ? 'May have stalled' : (FRIENDLY_STATUS[it.status] || it.status || 'ran');
  const chipStatus = stale ? 'missed' : (it.status === 'cancelled' ? 'archived' : (it.status || 'ran')); // archived chip = muted "stopped"
  const spin = (busy || runBusy) ? '<span class="hist__spin" aria-hidden="true"></span>' : '';
  const timing = runTimingChip(it);
  const draft = runDrafts.get(it.id) || '';
  const compose = can
    ? `<div class="hx__compose">
        <div class="hx__compose-inner">
          <textarea class="textarea chat__input" id="run-input" placeholder="Reply to continue this run… (Enter to send)" ${runBusy ? 'disabled' : ''}>${esc(draft)}</textarea>
          <button class="btn btn--primary" id="run-send" ${runBusy ? 'disabled' : ''}>Send</button>
        </div>
      </div>`
    : `<div class="hx__compose"><div class="hx__note">This entry is a routine whose run was never logged, so there's no conversation to continue.</div></div>`;
  return `<div class="hx__head">
      <button type="button" class="hx__railbtn" id="hx-railbtn" aria-label="Show the run list">☰ Runs</button>
      <span class="chip chip--${esc(chipStatus)}">${spin}${esc(statusLabel)}</span>
      <h2 class="hx__title">${esc(it.title || 'Untitled')}</h2>
      ${timing.text ? `<span class="hx__time" title="${esc(timing.tip)}">${esc(timing.text)}</span>` : ''}
      <span class="hx__head-actions">
        ${showStop ? `<button class="btn btn--danger-ghost btn--sm" id="run-stop" type="button" title="Stop this agent">Stop</button>` : ''}
        ${showRetry ? `<button class="btn btn--secondary btn--sm" id="run-retry" type="button">Retry</button>` : ''}
      </span>
    </div>
    <div class="hx__thread" id="hx-thread">
      <div class="hx__thread-inner">
        ${bubbles}
        ${runBusy || busy ? '<div class="chatmsg chatmsg--bot chatmsg--busy"><span class="hist__spin" aria-hidden="true"></span> Working…</div>' : ''}
      </div>
    </div>
    ${compose}`;
}

function wireRunPane(it) {
  const main = $('#hx-main'); if (!main || !it) return;
  $('#hx-railbtn', main)?.addEventListener('click', () => setRail(!railOpen));
  const input = $('#run-input', main);
  if (input) {
    const send = () => continueRun(it, input.value);
    // Keep the draft across live refreshes (the pane re-renders every poll).
    input.addEventListener('input', () => runDrafts.set(it.id, input.value));
    $('#run-send', main)?.addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  }
  // One-click resume: same agentPost path as a normal reply (simple-CORS text/plain).
  $('#run-retry', main)?.addEventListener('click', () => continueRun(it, RETRY_PROMPT));
  $('#run-stop', main)?.addEventListener('click', () => stopRun(it));
}

/* Re-render the pane in place. Keeps the reader where they were unless they
   were already pinned to the bottom (then it follows the new output). */
function renderRunPane(it, { focus = false } = {}) {
  const main = $('#hx-main'); if (!main) return;
  const prev = $('#hx-thread', main);
  const prevTop = prev ? prev.scrollTop : 0;
  const wasBottom = prev ? (prev.scrollHeight - prev.scrollTop - prev.clientHeight < 48) : true;
  main.innerHTML = runPaneHtml(it);
  wireRunPane(it);
  const thread = $('#hx-thread', main);
  if (thread) thread.scrollTop = wasBottom ? thread.scrollHeight : prevTop;
  if (focus && !runBusy) setTimeout(() => $('#run-input', main)?.focus(), 30);
}

/* Repaint the whole workspace from fresh data (a live poll, a filter flip, a
   follow-up round-trip) without rebuilding it — focus, scroll and the unsent
   draft all survive. */
function refreshHistory() {
  if (currentView !== 'history' || !$('#hx')) return;
  const { items } = historyFiltered();
  const current = selectedRun(items);
  selectedRunId = current ? current.id : null;
  $$('#hx [data-histf]').forEach((b) => {
    const on = b.dataset.histf === historyFilter;
    b.classList.toggle('btn--secondary', on);
    b.classList.toggle('btn--ghost', !on);
  });
  refreshRail();
  renderRunPane(current);
  fitHistoryPane();
}

async function stopRun(it) {
  if (!it?.runId || runBusy) return;
  const { error } = await sessionForFire();
  if (error) { toast(error, 'error'); return; }
  toast('Stopping…');
  try {
    const r = await agentPost({ runId: it.runId, action: 'stop' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) {
      toast(`Stop failed (${r.status})${data.error ? `: ${data.error}` : ''}.`, 'error');
      return;
    }
    toast('Stopped — hit Retry to resume from the transcript.');
    try { await loadAll(); } catch { /* */ }
    refreshHistory();
  } catch (e) {
    toast(`Stop request failed: ${e.message}`, 'error');
  }
}

// POST to the openrouter-agent edge function as a *simple* CORS request:
// text/plain content-type and no Authorization header, so the browser sends it
// WITHOUT a CORS preflight (the Supabase edge gateway currently 500s OPTIONS on
// this project — History replies used to fail with "Load failed").
// Auth still happens: we embed the signed-in user's access token in the JSON
// body as `accessToken`. The edge function verifies it via GoTrue and rejects
// unauthenticated callers (so random internet can't drive GITHUB_TOKEN). The
// scheduler instead sends the service-role Bearer, which the function also accepts.
async function agentPost(body) {
  const payload = { ...(body || {}) };
  // Prefer a token the caller already resolved; else pull the current session.
  if (!payload.accessToken && !payload.access_token) {
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (session?.access_token) payload.accessToken = session.access_token;
    } catch { /* edge function will 401 */ }
  }
  return fetch(`${SUPABASE_URL}/functions/v1/openrouter-agent`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify(payload),
  });
}

async function continueRun(it, raw) {
  const text = (raw || '').trim();
  if (!text || runBusy || !isContinuable(it)) return;
  const { error } = await sessionForFire();
  if (error) { toast(error, 'error'); return; }
  runBusy = true;
  runDrafts.delete(it.id);   // it's on its way — don't restore it into the box
  // Optimistically show the user's message + a thinking bubble.
  const optimistic = { ...it, messages: [...(Array.isArray(it.messages) ? it.messages : []), { role: 'user', content: text }] };
  renderRunPane(optimistic);
  try {
    const r = await agentPost({ runId: it.runId, prompt: text });
    const data = await r.json().catch(() => ({}));
    runBusy = false;
    if (!r.ok || data.ok === false) {
      toast(`Reply failed (${r.status})${data.error ? `: ${data.error}` : ''}.`, 'error');
      runDrafts.set(it.id, text);   // hand the message back so it isn't lost
      refreshHistory(); return;
    }
    const cost = Number(data.cost || 0);
    toast(`Replied — ${modelLabel(data.model || it.model)}${cost ? ` (~$${cost.toFixed(4)})` : ''}.`);
    try { await loadAll(); } catch { /* the row is saved regardless */ }
    refreshHistory();
  } catch (e) {
    // A long agent reply can outlast the platform's request timeout: the browser
    // fetch throws ("Load failed" / "Failed to fetch") even though the function
    // finished and persisted the reply onto the run row. Don't cry failure yet —
    // poll the row; if it advanced, the reply actually landed.
    const landed = await pollReplyLanded(it.runId, it.time);
    runBusy = false;
    if (landed) {
      toast('Reply completed.');
      try { await loadAll(); } catch { /* the row is saved regardless */ }
    } else {
      toast(`Reply request failed: ${e.message}`, 'error');
      runDrafts.set(it.id, text);   // hand the message back so it isn't lost
    }
    refreshHistory();
  }
}

// After a reply request drops at the network layer, check whether the server
// actually finished: the openrouter-agent function persists the continued run
// (and bumps fired_at) whether or not the HTTP response made it back. Returns
// true once the row's fired_at advances past when the reply started.
async function pollReplyLanded(runId, sinceTime) {
  if (!runId) return false;
  const since = sinceTime ? new Date(sinceTime).getTime() : 0;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const { data } = await sb.from('routiner_runs').select('fired_at').eq('id', runId).maybeSingle();
      if (data && data.fired_at && new Date(data.fired_at).getTime() > since) return true;
    } catch { /* transient — keep polling */ }
  }
  return false;
}

/* Render a run summary as light, safe Markdown: escape everything first, then
   linkify http(s) URLs and bold **text**. The .run__body container uses
   white-space:pre-wrap, so newlines and bullet/number prefixes from
   composeReport render as authored — no <ul> building needed. */
function renderRunBody(text) {
  let s = esc(text);                                          // escape first (handles & < > " ')
  s = s.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g,         // linkify, excluding trailing punctuation
    (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>'); // bold, single-line
  return s;
}

/* ---------- Calendar (week plan) ---------- */
function startOfWeek(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); const dow = (x.getDay() + 6) % 7; x.setDate(x.getDate() - dow); return x; } // Monday
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function sameDate(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
const DOW = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

/* Does a routine fire on `day`? Handles recurrence projection. */
function occursOn(routine, day) {
  if (!routine.scheduledAt) return false;
  const anchor = new Date(routine.scheduledAt);
  const a0 = new Date(anchor); a0.setHours(0, 0, 0, 0);
  const d0 = new Date(day); d0.setHours(0, 0, 0, 0);
  const rec = routine.recurrence || 'none';
  if (rec === 'none') return sameDate(anchor, day);
  if (d0 < a0) return false;
  const dow = day.getDay();
  if (rec === 'daily') return true;
  if (rec === 'weekdays') return dow >= 1 && dow <= 5;
  if (rec === 'weekly') return dow === anchor.getDay();
  return false;
}

/* Build the {days, perDay[]} event model for the visible week. */
function weekEvents(weekStart) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const perDay = days.map(() => []);
  routines.forEach((r) => {
    if (r.status !== 'scheduled') return;
    days.forEach((day, i) => {
      if (!occursOn(r, day)) return;
      const anchor = new Date(r.scheduledAt);
      const start = new Date(day); start.setHours(anchor.getHours(), anchor.getMinutes(), 0, 0);
      const durMin = r.durationMin || CAL.defaultDurationMin;
      perDay[i].push({ routine: r, start, end: new Date(start.getTime() + durMin * 60000) });
    });
  });
  return { days, perDay };
}

/* Interval-graph column packing: side-by-side columns for overlaps. */
function layoutDay(events) {
  const toMin = (d) => d.getHours() * 60 + d.getMinutes();
  const evs = events.map((e) => ({ ...e, s: toMin(e.start), e2: Math.max(toMin(e.end), toMin(e.start) + 15) }))
    .sort((a, b) => a.s - b.s || a.e2 - b.e2);
  const colEnds = [];
  evs.forEach((ev) => {
    let placed = -1;
    for (let c = 0; c < colEnds.length; c++) { if (colEnds[c] <= ev.s) { placed = c; colEnds[c] = ev.e2; break; } }
    if (placed < 0) { placed = colEnds.length; colEnds.push(ev.e2); }
    ev.col = placed;
  });
  // group consecutive overlapping events to know how many columns to divide by
  let group = [], maxEnd = -1;
  const flush = (g) => { if (!g.length) return; const n = Math.max(...g.map((x) => x.col)) + 1; g.forEach((x) => { x.ncols = n; }); };
  evs.forEach((ev) => { if (group.length && ev.s >= maxEnd) { flush(group); group = []; maxEnd = -1; } group.push(ev); maxEnd = Math.max(maxEnd, ev.e2); });
  flush(group);
  return evs;
}

function calEventHtml(ev) {
  const winStart = CAL.startHour * 60, winEnd = CAL.endHour * 60;
  const s = Math.max(ev.s, winStart), e = Math.min(ev.e2, winEnd);
  if (e <= winStart || s >= winEnd) return ''; // fully outside the visible window
  const top = ((s - winStart) / 60) * CAL.hourPx;
  const height = Math.max(((e - s) / 60) * CAL.hourPx, 20);
  const widthPct = 100 / ev.ncols, leftPct = ev.col * widthPct;
  const c = triggerColor(ev.routine.account, ev.routine.triggerKey);
  const past = ev.start.getTime() < Date.now();
  const hm = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const timeStr = `${hm(ev.start)}–${hm(ev.end)}`;
  const showTime = height >= 34;
  const tLabel = triggerLabel(ev.routine.account, ev.routine.triggerKey);
  const acctText = accountLabel(ev.routine.account) + (tLabel ? ` · ${tLabel}` : '');
  // A block that has already run is a record of something that happened, so it
  // can be renamed in place — no drawer, no round trip. Future blocks still open
  // the drawer on tap, where the title is one of several things to set.
  const renameTip = isRecurringRoutine(ev.routine)
    ? 'Rename — this routine repeats, so every block of it takes the new name'
    : 'Rename this block';
  const rename = past
    ? `<button type="button" class="cal__ev-edit" data-rename="${ev.routine.id}" title="${esc(renameTip)}" aria-label="Rename">✎</button>`
    : '';
  return `<div class="cal__ev${past ? ' cal__ev--past' : ''}" data-id="${ev.routine.id}" title="${esc(ev.routine.title)} · ${esc(acctText)} · ${timeStr}"
    style="top:${top}px; height:${height}px; left:calc(${leftPct}% + 3px); width:calc(${widthPct}% - 5px); background:${c.solid}; color:${c.ink}; border-left-color:${c.edge};">
    <div class="cal__ev-title">${esc(ev.routine.title) || 'Untitled'}</div>
    ${showTime ? `<div class="cal__ev-time">${timeStr}</div>` : ''}
    ${rename}
  </div>`;
}

/* Legend groups: each account with the union of its configured triggers AND any
   trigger keys that actually appear on scheduled routines (so a routine pointing
   at a removed/legacy trigger still gets a labeled swatch — the key shows a color
   per trigger in use, not just the ones currently in Settings). */
function legendGroups() {
  const groups = new Map(); // accId → { label, triggers: Map(tId → label) }
  const ensure = (accId) => {
    if (!groups.has(accId)) groups.set(accId, { label: accountLabel(accId), triggers: new Map() });
    return groups.get(accId);
  };
  listAccounts().forEach((a) => {
    const g = ensure(a.id);
    (a.triggers || []).forEach((t) => g.triggers.set(t.id, t.label || '(unnamed)'));
  });
  routines.forEach((r) => {
    const accId = r.account || DEFAULT_ACCOUNT;
    const g = ensure(accId);
    const key = r.triggerKey || '';
    if (!g.triggers.has(key)) g.triggers.set(key, triggerLabel(accId, r.triggerKey) || '(other)');
  });
  return groups;
}

/* Rename a past block in place: the title becomes an input right on the
   calendar. Enter or clicking away saves, Escape reverts. Recurring routines are
   one row behind every one of their blocks, so renaming any of them renames the
   series — the toast says so rather than letting it be a surprise. */
function startBlockRename(el) {
  if (!el || el.querySelector('.cal__ev-input')) return;
  const id = el.dataset.id;
  const r = getRoutine(id);
  const titleEl = el.querySelector('.cal__ev-title');
  if (!r || !titleEl) return;
  const prev = r.title || '';
  const input = document.createElement('input');
  input.className = 'cal__ev-input';
  input.value = prev;
  input.setAttribute('aria-label', 'Block title');
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const finish = async (save) => {
    if (settled) return;
    settled = true;
    const next = input.value.trim();
    if (!save || !next || next === prev) { renderCalendar(); return; }
    await dbUpdate(id, Object.assign({}, r, { title: next }));
    toast(isRecurringRoutine(r)
      ? `Renamed to “${next}” — this routine repeats, so every one of its blocks now reads that.`
      : `Renamed to “${next}”.`);
    renderCalendar();
  };
  // Keep these off the document: Escape here reverts the rename, it doesn't
  // close a drawer, and a click inside the editor isn't a click on the block.
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());
}

function renderCalendar() {
  const weekStart = startOfWeek(calRef), weekEnd = addDays(weekStart, 6);
  const { days, perDay } = weekEvents(weekStart);
  const total = perDay.reduce((n, d) => n + d.length, 0);
  const today = new Date();
  const colH = (CAL.endHour - CAL.startHour) * CAL.hourPx;

  const rangeLabel = `${weekStart.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${weekEnd.toLocaleDateString([], { month: weekStart.getMonth() === weekEnd.getMonth() ? undefined : 'short', day: 'numeric' })}`;

  const legend = Array.from(legendGroups().entries()).map(([accId, g]) => {
    const trigs = Array.from(g.triggers.entries());
    const items = trigs.length
      ? trigs.map(([tId, tLabel]) => `<span class="cal__legtrig" title="${esc(g.label)} · ${esc(tLabel)}"><span class="cal__sw" style="background:${triggerColor(accId, tId || null).solid}"></span>${esc(tLabel)}</span>`).join('')
      : `<span class="cal__legtrig"><span class="cal__sw" style="background:${accountColor(accId).solid}"></span></span>`;
    return `<span class="cal__leg"><span class="cal__leg-name">${esc(g.label)}</span>${items}</span>`;
  }).join('');

  const dayHeaders = days.map((d) => {
    const isToday = sameDate(d, today);
    return `<div class="cal__dh${isToday ? ' cal__dh--today' : ''}"><div class="cal__dow">${DOW[(d.getDay() + 6) % 7]}</div><div class="cal__dnum">${d.getDate()}</div></div>`;
  }).join('');

  const gutter = `<div class="cal__gutter" style="height:${colH}px">${Array.from({ length: CAL.endHour - CAL.startHour + 1 }, (_, i) => {
    const h = (CAL.startHour + i) % 24, ampm = h < 12 ? 'AM' : 'PM', h12 = ((h + 11) % 12) + 1;
    return `<div class="cal__hr" style="top:${i * CAL.hourPx}px">${h12}${h % 12 === 0 ? ' ' + ampm : ''}</div>`;
  }).join('')}</div>`;

  const dayCols = days.map((d, i) => {
    const laid = layoutDay(perDay[i]);
    const now = sameDate(d, today) ? nowLineHtml() : '';
    return `<div class="cal__day" style="height:${colH}px">${laid.map(calEventHtml).join('')}${now}</div>`;
  }).join('');

  view.innerHTML = `<div class="cal">
    <div class="cal__bar">
      <span class="cal__range">${rangeLabel}</span>
      <div class="cal__nav"><button class="cal__navbtn" data-cal="prev">‹</button><button class="cal__navbtn" data-cal="next">›</button></div>
      <button class="cal__today" data-cal="today">Today</button>
      <div class="cal__nav cal__zoom" title="Zoom the timeline — or pinch on a touch screen"><button class="cal__navbtn" data-cal="zoomout" aria-label="Zoom out" ${CAL.hourPx <= CAL_HOURPX_MIN ? 'disabled' : ''}>−</button><button class="cal__navbtn" data-cal="zoomin" aria-label="Zoom in" ${CAL.hourPx >= CAL_HOURPX_MAX ? 'disabled' : ''}>＋</button></div>
      <span class="cal__count">${total} event${total === 1 ? '' : 's'} this week</span>
      <div class="cal__legend">${legend}</div>
    </div>
    <div class="cal__head"><div></div>${dayHeaders}</div>
    <div class="cal__scroll"><div class="cal__body">${gutter}${dayCols}</div></div>
    ${total === 0 ? '<div class="cal__hint">No routines scheduled this week. Schedule a routine — pick its account, trigger, and a time — and it lands here as a colored block.</div>' : ''}
  </div>`;

  view.querySelectorAll('[data-cal]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.cal;
    if (a === 'today') calRef = new Date();
    else if (a === 'zoomin') setCalHourPx(CAL.hourPx * 1.4);
    else if (a === 'zoomout') setCalHourPx(CAL.hourPx / 1.4);
    else calRef = addDays(calRef, a === 'next' ? 7 : -7);
    renderCalendar();
  }));
  // Tap a block to open it; drag it (mouse / touch / pencil) to reschedule —
  // slide to another time and/or day, snapping to 15 min, like Apple/Google Calendar.
  const cols = Array.from(view.querySelectorAll('.cal__day'));
  const colHpx = (CAL.endHour - CAL.startHour) * CAL.hourPx;
  const step = CAL.hourPx / 4; // 15-minute grid
  const colIndexAt = (clientX) => {
    for (let i = 0; i < cols.length; i++) { const r = cols[i].getBoundingClientRect(); if (clientX >= r.left && clientX <= r.right) return i; }
    return clientX < cols[0].getBoundingClientRect().left ? 0 : cols.length - 1; // clamp
  };
  view.querySelectorAll('.cal__ev').forEach((el) => {
    el.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary) return;
      if (e.target.closest('.cal__ev-edit, .cal__ev-input')) return; // renaming, not dragging
      const id = el.dataset.id;
      const startX = e.clientX, startY = e.clientY;
      const blockTop = parseFloat(el.style.top) || 0;
      const grabOffsetY = startY - (el.parentElement.getBoundingClientRect().top + blockTop);
      const height = el.offsetHeight;
      let dragging = false, ti = 0, topPx = blockTop;
      el.setPointerCapture(e.pointerId);

      const onMove = (ev) => {
        // A second finger means a pinch-zoom, not a drag; and a re-render (e.g.
        // from a zoom) detaches this element — bail either way, don't move.
        if (activeTouches > 1 || !el.isConnected) return;
        if (!dragging) { if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return; dragging = true; el.classList.add('cal__ev--dragging'); }
        ev.preventDefault();
        ti = colIndexAt(ev.clientX);
        const colRect = cols[ti].getBoundingClientRect();
        topPx = Math.round((ev.clientY - grabOffsetY - colRect.top) / step) * step;
        topPx = Math.max(0, Math.min(topPx, colHpx - height));
        if (el.parentElement !== cols[ti]) cols[ti].appendChild(el);
        el.style.top = `${topPx}px`; el.style.left = '3px'; el.style.width = 'calc(100% - 6px)';
      };
      const onUp = async (ev) => {
        try { el.releasePointerCapture(e.pointerId); } catch { /* */ }
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        if (!el.isConnected) return; // element was replaced by a re-render (zoom) — ignore
        const r = getRoutine(id);
        if (!dragging) { if (r) openDrawer(r); return; } // it was a tap
        // A real move just happened — mark it so the synthetic click the browser
        // fires next on the day column doesn't open a blank "new routine" drawer.
        lastCalDragEnd = Date.now();
        el.classList.remove('cal__ev--dragging');
        const minutes = Math.round(CAL.startHour * 60 + (topPx / CAL.hourPx) * 60);
        const day = days[ti];
        const when = new Date(day); when.setHours(0, 0, 0, 0); when.setMinutes(minutes);
        const iso = when.toISOString();
        if (r && iso !== r.scheduledAt) { await dbUpdate(id, Object.assign({}, r, { scheduledAt: iso })); toast(`Moved to ${fmt(iso)}.`); }
        renderCalendar();
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });
  });
  view.querySelectorAll('[data-rename]').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); startBlockRename(btn.closest('.cal__ev')); });
  });
  // Click empty space in a day column to create a routine at that exact day + time.
  view.querySelectorAll('.cal__day').forEach((col, i) => col.addEventListener('click', (e) => {
    if (Date.now() - lastCalDragEnd < 400) return; // just dropped a dragged block — ignore the trailing click
    if (e.target.closest('.cal__ev')) return; // landed on an event — its own handler opens it
    const day = days[i]; if (!day) return;
    const rect = col.getBoundingClientRect();
    const offsetY = e.clientY - rect.top;
    let mins = CAL.startHour * 60 + (offsetY / CAL.hourPx) * 60;
    mins = Math.round(mins / 15) * 15; // snap to nearest 15 minutes
    mins = Math.max(CAL.startHour * 60, Math.min(mins, CAL.endHour * 60 - 15));
    const when = new Date(day); when.setHours(0, 0, 0, 0); when.setMinutes(mins);
    openDrawer({ title: '', prompt: '', model: settings.model, taskType: DEFAULT_TASK_TYPE, complexity: DEFAULT_COMPLEXITY, account: settings.account || DEFAULT_ACCOUNT, triggerKey: null, recurrence: 'none', scheduledAt: when.toISOString() }, { forceSchedule: true });
  }));
  // Open scrolled to ~an hour before now so the day's in view (but night is a scroll up).
  const scrollEl = $('.cal__scroll', view);
  if (scrollEl) scrollEl.scrollTop = Math.max(0, (new Date().getHours() - 1 - CAL.startHour) * CAL.hourPx);
}

/* Pinch-to-zoom the daily timeline (two fingers, like Apple/Google Calendar),
   plus ctrl/⌘ + wheel on desktop. Attached once to the persistent #view element
   so it survives the calendar's re-renders.

   On iPadOS/Safari a two-finger pinch is delivered as native gesture events
   (which otherwise page-zoom the whole tab), so we handle those directly — they
   give an absolute `scale` — and only fall back to raw touch math on engines
   without GestureEvent. PINCH_GAIN amplifies the response so a modest spread
   produces a satisfying zoom rather than a barely-perceptible nudge. */
function wireCalendarZoom() {
  const HAS_GESTURE = typeof window !== 'undefined' && 'GestureEvent' in window;
  const PINCH_GAIN = 1.8; // exponent on the pinch scale — >1 makes zoom feel stronger
  const scrollEl = () => $('.cal__scroll', view);
  const distOf = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  let startPx = CAL.hourPx, anchor = 0, raf = 0;

  const captureAnchor = () => { const sc = scrollEl(); anchor = sc && sc.scrollHeight ? (sc.scrollTop + sc.clientHeight / 2) / sc.scrollHeight : 0; };
  const applyZoom = (px) => {
    if (!setCalHourPx(px, false)) return;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      renderCalendar();
      const sc = scrollEl(); // keep the pinch roughly centered on where it started
      if (sc) sc.scrollTop = Math.max(0, anchor * sc.scrollHeight - sc.clientHeight / 2);
    });
  };
  const persist = () => { try { localStorage.setItem(CAL_ZOOM_LS, String(CAL.hourPx)); } catch { /* */ } };

  // ── Safari / iPadOS: native pinch gesture (scale is relative to gesturestart) ──
  let gesturing = false;
  view.addEventListener('gesturestart', (e) => {
    if (currentView !== 'calendar') return;
    e.preventDefault(); gesturing = true; startPx = CAL.hourPx; captureAnchor();
  });
  view.addEventListener('gesturechange', (e) => {
    if (!gesturing) return;
    e.preventDefault();
    applyZoom(startPx * Math.pow(e.scale || 1, PINCH_GAIN));
  });
  const endGesture = () => { if (gesturing) { gesturing = false; persist(); } };
  view.addEventListener('gestureend', endGesture);

  // ── Other engines: two-finger touch math (skipped where GestureEvent exists) ──
  let pinching = false, startDist = 1;
  view.addEventListener('touchstart', (e) => {
    activeTouches = e.touches.length;
    if (HAS_GESTURE || currentView !== 'calendar' || e.touches.length !== 2) return;
    pinching = true; startDist = distOf(e.touches) || 1; startPx = CAL.hourPx; captureAnchor();
  }, { passive: true });
  view.addEventListener('touchmove', (e) => {
    if (!pinching || e.touches.length !== 2) return;
    e.preventDefault(); // stop the page/timeline from scrolling mid-pinch
    applyZoom(startPx * Math.pow(distOf(e.touches) / startDist, PINCH_GAIN));
  }, { passive: false });
  const endTouch = (e) => {
    activeTouches = e.touches.length;
    if (pinching && e.touches.length < 2) { pinching = false; persist(); }
  };
  view.addEventListener('touchend', endTouch);
  view.addEventListener('touchcancel', endTouch);

  // ── Desktop: ctrl/⌘ + wheel ──
  view.addEventListener('wheel', (e) => {
    if (currentView !== 'calendar' || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    captureAnchor();
    if (setCalHourPx(CAL.hourPx * (e.deltaY < 0 ? 1.12 : 1 / 1.12))) { renderCalendar(); const sc = scrollEl(); if (sc) sc.scrollTop = Math.max(0, anchor * sc.scrollHeight - sc.clientHeight / 2); }
    persist();
  }, { passive: false });
}

function nowLineHtml() {
  const now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
  if (mins < CAL.startHour * 60 || mins > CAL.endHour * 60) return '';
  const top = ((mins - CAL.startHour * 60) / 60) * CAL.hourPx;
  return `<div class="cal__now" style="top:${top}px"></div><div class="cal__now-dot" style="top:${top - 4}px"></div>`;
}

/* ---------- Drawer (create / edit) ---------- */
let editingId = null;
let schedulingNoteId = null; // set when the drawer was opened from a Board note

/* Turn a Board note into a routine: open the create drawer prefilled with the
   note's text, and remember the note so it's marked planned once it's scheduled. */
function scheduleFromNote(n) {
  schedulingNoteId = n.id;
  const title = (n.body.split('\n').find((l) => l.trim()) || 'Untitled').trim().slice(0, 60);
  openDrawer({ title, prompt: n.body, model: settings.model, account: settings.account || DEFAULT_ACCOUNT, triggerKey: null, recurrence: 'none', durationMin: DEFAULT_DURATION_MIN, scheduledAt: null }, { forceSchedule: true });
  drawerTitle.textContent = 'Schedule from board';
}
function triggerOptions(accId, selectedKey) {
  const trigs = accountTriggers(accId);
  if (!trigs.length) return `<option value="">— none yet — add in Settings —</option>`;
  return trigs.map((t) => `<option value="${t.id}" ${selectedKey === t.id ? 'selected' : ''}>${esc(t.label || '(unnamed)')}</option>`).join('');
}
function openDrawer(routine = null, opts = {}) {
  editingId = routine && routine.id ? routine.id : null;
  drawerTitle.textContent = editingId ? 'Edit routine' : 'New routine';
  const defaults = { title: '', prompt: '', model: settings.model, taskType: DEFAULT_TASK_TYPE, complexity: DEFAULT_COMPLEXITY, account: settings.account || DEFAULT_ACCOUNT, triggerKey: null, recurrence: 'none', scheduledAt: null };
  const r = Object.assign(defaults, routine || {});
  const whenVal = r.scheduledAt ? toLocalInput(new Date(r.scheduledAt)) : defaultWhen();
  const curAccount = getAccountCfg(r.account) ? r.account : (listAccounts()[0] || {}).id;
  // OpenRouter routines store their research config as JSON in `prompt`; parse it
  // to prefill the enrichment panel (defaults for a brand-new one).
  let enr = { niche: '', location: '', count: 10, vertical: '', dmTitles: '', model: DEFAULT_PERPLEXITY_MODEL, toCommand: true, toAbstrax: false };
  if (accountKind(curAccount) === 'openrouter') {
    try {
      const c = JSON.parse(r.prompt || '{}');
      if (c && typeof c === 'object') enr = { niche: c.niche || '', location: c.location || '', count: c.count || 10,
        vertical: c.vertical || '', dmTitles: (c.dmTitles || []).join(', '), model: c.model || DEFAULT_PERPLEXITY_MODEL,
        toCommand: c.toCommand !== false, toAbstrax: !!c.toAbstrax };
    } catch { /* not JSON yet */ }
  }
  drawerBody.innerHTML = `
    <div class="field"><label class="label" for="f-title">Title</label>
      <input class="input" id="f-title" placeholder="e.g. Morning competitor scan" value="${esc(r.title)}" /></div>
    <div class="field"><label class="label" for="f-prompt">Directions for Claude</label>
      <textarea class="textarea" id="f-prompt" placeholder="Describe the task. It runs in your Claude Code routine session with full tools.">${esc(r.prompt)}</textarea>
      <span class="hint">Sent to your routine as a session turn. Use {{date}} / {{datetime}} for the run time.</span></div>
    <div class="field__row">
      <div class="field"><label class="label" for="f-account">Account</label>
        <select class="select" id="f-account">${listAccounts().map((a) => `<option value="${a.id}" ${curAccount === a.id ? 'selected' : ''}>${esc(a.label)}${(a.kind === 'openrouter' || a.kind === 'openrouter-agent') ? ' ⚡' : ''}</option>`).join('')}</select></div>
      <div class="field"><label class="label" for="f-trigger">Trigger</label>
        <select class="select" id="f-trigger">${triggerOptions(curAccount, r.triggerKey)}</select>
        <span class="hint">Which instance fires it. Manage these in Settings.</span></div>
    </div>
    <div class="notice" id="f-agent-hint" style="display:none"></div>
    <div id="f-enrich" style="display:none">
      <div class="field__row">
        <div class="field"><label class="label" for="f-e-niche">Niche</label>
          <input class="input" id="f-e-niche" placeholder="e.g. established medical spas" value="${esc(enr.niche)}" /></div>
        <div class="field"><label class="label" for="f-e-location">Location</label>
          <input class="input" id="f-e-location" placeholder="e.g. Huntsville, AL" value="${esc(enr.location)}" /></div>
      </div>
      <div class="field__row">
        <div class="field"><label class="label" for="f-e-count">How many</label>
          <input class="input" type="number" id="f-e-count" min="1" max="25" value="${esc(String(enr.count))}" /></div>
        <div class="field"><label class="label" for="f-e-vertical">Vertical tag</label>
          <input class="input" id="f-e-vertical" placeholder="auto from niche" value="${esc(enr.vertical)}" /></div>
      </div>
      <div class="field"><label class="label" for="f-e-model">Perplexity model</label>
        <select class="select" id="f-e-model">${PERPLEXITY_MODELS.map((m) => `<option value="${m.id}" ${enr.model === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></div>
      <div class="field"><label class="label" for="f-e-dm">Decision-maker titles</label>
        <input class="input" id="f-e-dm" placeholder="Owner, Medical Director, Practice Manager" value="${esc(enr.dmTitles)}" />
        <span class="hint">Comma-separated. Blank = let the research infer.</span></div>
      <div class="field__row">
        <label class="label" style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="f-e-command" ${enr.toCommand ? 'checked' : ''} /> Send to Command (Review tab)</label>
        <label class="label" style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="f-e-abstrax" ${enr.toAbstrax ? 'checked' : ''} /> Send to Abstrax (prospects)</label>
      </div>
      <span class="hint">Runs Perplexity deep research via OpenRouter — no Claude session, no token. Abstrax needs its service key set server-side to actually write.</span>
    </div>
    <div class="field"><label class="label" for="f-model">Model</label>
      <select class="select" id="f-model">${MODELS.map((m) => `<option value="${m.id}" ${(r.model || settings.model) === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}</select></div>
    <div class="field__row" id="f-auto-row">
      <div class="field"><label class="label" for="f-tasktype">Task type</label>
        <select class="select" id="f-tasktype">${TASK_TYPES.map((t) => `<option value="${t.id}" ${(r.taskType || DEFAULT_TASK_TYPE) === t.id ? 'selected' : ''}>${t.label}</option>`).join('')}</select></div>
      <div class="field"><label class="label" for="f-complexity">Complexity</label>
        <select class="select" id="f-complexity">${COMPLEXITIES.map((c) => `<option value="${c.id}" ${(r.complexity || DEFAULT_COMPLEXITY) === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}</select></div>
    </div>
    <span class="hint" id="f-model-hint"></span>
    <div class="field__row">
      <div class="field"><label class="label" for="f-when">Fire at</label>
        <input class="input" type="datetime-local" id="f-when" value="${whenVal}" /></div>
      <div class="field"><label class="label" for="f-dur">Duration</label>
        <select class="select" id="f-dur">${DURATIONS.map((d) => `<option value="${d}" ${(r.durationMin || DEFAULT_DURATION_MIN) === d ? 'selected' : ''}>${fmtDuration(d)}</option>`).join('')}</select></div>
      <div class="field"><label class="label" for="f-recur">Repeat</label>
        <select class="select" id="f-recur">${Object.entries(RECURRENCE).map(([k, v]) => `<option value="${k}" ${r.recurrence === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    </div>
    <div class="field"><button class="btn btn--ghost btn--sm" id="f-test" type="button">Test live (optional, uses API)</button>
      <div class="run__body" id="f-test-out" style="display:none"></div></div>
    <div class="notice"><b>Run now</b> fires your routine immediately with this prompt. <b>Schedule</b> queues it for the time above (repeating if set). <b>Save to library</b> parks it.</div>`;
  drawerFoot.innerHTML = `
    <button class="btn btn--accent" data-do="now">Run now</button>
    <button class="btn btn--brand" data-do="schedule">Schedule</button>
    <button class="btn btn--secondary" data-do="library">Save to library</button>
    ${editingId ? '<button class="btn btn--danger-ghost drawer__del" data-do="delete" type="button">Delete routine</button>' : ''}`;
  $('#f-test', drawerBody).addEventListener('click', testLive);
  $('#f-account', drawerBody).addEventListener('change', (e) => { $('#f-trigger', drawerBody).innerHTML = triggerOptions(e.target.value, null); refreshDrawerKind(); });
  $('#f-trigger', drawerBody).addEventListener('change', refreshDrawerKind); // agent hint tracks the chosen instance
  ['#f-model', '#f-tasktype', '#f-complexity'].forEach((s) => $(s, drawerBody).addEventListener('change', refreshModelHint));
  $('#f-prompt', drawerBody).addEventListener('input', refreshModelHint); // live cost estimate tracks the prompt
  refreshDrawerKind();
  drawerFoot.querySelectorAll('[data-do]').forEach((b) => b.addEventListener('click', () => submitDrawer(b.dataset.do)));
  setTimeout(() => $(opts.forceSchedule ? '#f-when' : '#f-title', drawerBody)?.focus(), 50);
  overlay.classList.add('is-open');
}
/* Swap the drawer between a Claude routine (directions + model), a Perplexity
   enrichment routine (the niche panel), and an OpenRouter agent routine
   (directions + a per-instance model/tool hint). Called on open and whenever the
   account or trigger changes. */
function refreshDrawerKind() {
  const acc = $('#f-account', drawerBody)?.value;
  const kind = accountKind(acc);
  const isEnrich = kind === 'openrouter';      // Perplexity enrichment panel
  const isAgent = kind === 'openrouter-agent'; // OpenRouter model + tools
  const nonClaude = isEnrich || isAgent;
  const enrich = $('#f-enrich', drawerBody);
  if (enrich) enrich.style.display = isEnrich ? '' : 'none';
  // Toggle fields by kind. Prompt is hidden only for enrichment (agent uses it).
  const hide = (sel, cond) => { const el = $(sel, drawerBody)?.closest('.field'); if (el) el.style.display = cond ? 'none' : ''; };
  hide('#f-prompt', isEnrich);
  hide('#f-model', nonClaude);
  hide('#f-test', nonClaude);
  const autoRow = $('#f-auto-row', drawerBody); if (autoRow && nonClaude) autoRow.style.display = 'none';
  const hint = $('#f-model-hint', drawerBody); if (hint) hint.style.display = nonClaude ? 'none' : '';
  // Agent instance hint: which model + tools this instance runs.
  const ah = $('#f-agent-hint', drawerBody);
  if (ah) {
    ah.style.display = isAgent ? '' : 'none';
    if (isAgent) {
      const tId = $('#f-trigger', drawerBody)?.value || null;
      const m = triggerModel(acc, tId);
      const tools = triggerTools(acc, tId);
      const toolNames = tools.length ? tools.map((id) => (AGENT_TOOLS.find((x) => x.id === id) || {}).label || id).join(', ') : 'no tools';
      ah.innerHTML = `Runs <b>${esc(modelLabel(m))}</b> <code>${esc(m)}</code> with ${esc(toolNames)}. Its output lands in History, where you can reply to continue it. Change the model &amp; tools in Settings.`;
    }
  }
  const promptLabel = $('label[for="f-prompt"]', drawerBody);
  if (promptLabel) promptLabel.textContent = isAgent ? 'Directions for the agent' : 'Directions for Claude';
  if (!nonClaude) refreshModelHint();
}

/* Reflect the model choice: when Auto, show the task-type/complexity inputs and
   the model they resolve to; otherwise hide them and name the pinned model. */
function refreshModelHint() {
  const model = $('#f-model', drawerBody)?.value;
  const isAuto = model === 'auto';
  const row = $('#f-auto-row', drawerBody);
  const hint = $('#f-model-hint', drawerBody);
  if (row) row.style.display = isAuto ? '' : 'none';
  if (!hint) return;
  const resolved = isAuto
    ? getModelForTask($('#f-tasktype', drawerBody).value, $('#f-complexity', drawerBody).value)
    : model;
  const est = estimateRunCost({ prompt: $('#f-prompt', drawerBody)?.value || '', model: resolved });
  const costLine = est
    ? ` Estimated <b>${fmtUSD(est.usd)}</b> per run (~${est.inTok.toLocaleString()} tokens in, ~${est.outTok.toLocaleString()} out${est.approx ? ', rates approximate' : ''}).`
    : '';
  hint.innerHTML = (isAuto
    ? `Routiner will use <b>${esc(modelLabel(resolved))}</b> <code>${esc(resolved)}</code> for this task.`
    : `Pinned to <b>${esc(modelLabel(model))}</b> <code>${esc(model)}</code>.`) + costLine;
}

async function testLive() {
  const prompt = $('#f-prompt').value;
  if (!prompt.trim()) return toast('Add directions first.', 'error');
  const d = readDrawer();
  const model = effectiveModel(d);
  const out = $('#f-test-out'), btn = $('#f-test');
  const via = isClaudeModel(model) ? 'Anthropic' : 'OpenRouter';
  btn.disabled = true; btn.textContent = 'Testing…'; out.style.display = 'block'; out.textContent = `Running on ${modelLabel(model)} via ${via}…`;
  const res = await callClaude(prompt, model);
  out.textContent = res.text; btn.disabled = false; btn.textContent = 'Test live (optional, uses API)';
  await dbInsertRun({ id: editingId, title: $('#f-title').value || 'Live test' }, res);
}
function readDrawer() {
  const account = $('#f-account').value;
  const common = { account, triggerKey: $('#f-trigger').value || null, durationMin: parseInt($('#f-dur').value, 10) || DEFAULT_DURATION_MIN, recurrence: $('#f-recur').value, whenRaw: $('#f-when').value };
  if (accountKind(account) === 'openrouter') {
    const niche = $('#f-e-niche').value.trim();
    const location = $('#f-e-location').value.trim();
    const count = Math.max(1, Math.min(parseInt($('#f-e-count').value, 10) || 10, 25));
    const vertical = ($('#f-e-vertical').value.trim() || niche.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')).slice(0, 32);
    const dmTitles = $('#f-e-dm').value.split(',').map((s) => s.trim()).filter(Boolean);
    const model = $('#f-e-model').value;
    const cfg = { action: 'lead-enrichment', niche, location: location || null, count, vertical, dmTitles, model,
      toCommand: $('#f-e-command').checked, toAbstrax: $('#f-e-abstrax').checked };
    const title = $('#f-title').value.trim() || `${niche}${location ? ` — ${location}` : ''}`;
    // Store the config as the prompt (the scheduler/edge read it); model column
    // carries the Perplexity id so the card/forecast show what will run.
    return Object.assign(common, { title, prompt: JSON.stringify(cfg), model, taskType: DEFAULT_TASK_TYPE, complexity: DEFAULT_COMPLEXITY, openrouter: true });
  }
  if (isAgentKind(account)) {
    // Agent routine: plain-text task. The model comes from the chosen instance
    // (stored on the routine's `model` column so cards/forecasts show it).
    return Object.assign(common, { title: $('#f-title').value.trim(), prompt: $('#f-prompt').value,
      model: triggerModel(account, common.triggerKey), taskType: DEFAULT_TASK_TYPE, complexity: DEFAULT_COMPLEXITY });
  }
  return Object.assign(common, { title: $('#f-title').value.trim(), prompt: $('#f-prompt').value, model: $('#f-model').value, taskType: $('#f-tasktype').value, complexity: $('#f-complexity').value });
}
async function persist(base) { return editingId ? dbUpdate(editingId, Object.assign(getRoutine(editingId) || {}, base)) : dbCreate(base); }

async function submitDrawer(action) {
  // Delete works on the existing routine regardless of the form contents, so it
  // runs before the read/validate below (no prompt required to remove a block).
  if (action === 'delete') {
    if (!editingId) return;
    if (!confirm('Delete this routine permanently?')) return;
    if (await dbDelete(editingId)) { closeDrawer(); render(); toast('Deleted.'); }
    return;
  }
  const d = readDrawer();
  if (d.openrouter) {
    let cfg = {}; try { cfg = JSON.parse(d.prompt); } catch { /* */ }
    if (!cfg.niche) { toast('Add a niche to research.', 'error'); $('#f-e-niche')?.focus(); return; }
    if (!cfg.toCommand && !cfg.toAbstrax) { toast('Pick at least one destination (Command or Abstrax).', 'error'); return; }
  } else if (!d.prompt.trim()) { toast('Add directions first.', 'error'); $('#f-prompt').focus(); return; }
  const base = { title: d.title, prompt: d.prompt, model: d.model, taskType: d.taskType, complexity: d.complexity, account: d.account, triggerKey: d.triggerKey, durationMin: d.durationMin, recurrence: d.recurrence };
  const fromNote = schedulingNoteId; // if opened from a Board note, mark it planned once handled

  if (action === 'library') {
    // Editing an already-scheduled routine? Saving to the library keeps it
    // scheduled — library membership never takes a routine off the air.
    const existing = editingId ? getRoutine(editingId) : null;
    const keepSched = !!(existing && existing.status === 'scheduled' && existing.scheduledAt);
    await persist(Object.assign(base, keepSched ? { status: 'scheduled' } : { status: 'library', scheduledAt: null }));
    if (fromNote) await dbUpdateNote(fromNote, { status: 'planned' });
    closeDrawer(); currentView = 'library'; syncTabs(); render();
    toast(keepSched ? 'Saved — still scheduled. Use Unschedule on the card to take it off the calendar.' : 'Saved to Library.'); return;
  }
  if (action === 'schedule') {
    if (!d.whenRaw) return toast('Pick a date & time to schedule.', 'error');
    const when = new Date(d.whenRaw);
    if (when.getTime() <= Date.now() && d.recurrence === 'none') return toast('That time is in the past — pick a future time or set Repeat.', 'error');
    let scheduledAt = when.toISOString();
    if (when.getTime() <= Date.now()) scheduledAt = nextOccurrence(scheduledAt, d.recurrence);
    await persist(Object.assign(base, { status: 'scheduled', scheduledAt }));
    if (fromNote) await dbUpdateNote(fromNote, { status: 'planned' });
    // Land on the calendar, on the week the routine was scheduled into, so it's visibly there.
    closeDrawer(); calRef = new Date(scheduledAt); currentView = 'calendar'; syncTabs(); render(); toast(`Scheduled — fires ${relative(scheduledAt)}. Added to the calendar.`); return;
  }
  if (action === 'now') {
    // Don't leave a due-now scheduled row — fire immediately and claim like the
    // scheduler would (next recurrence, or library for one-offs).
    const nowIso = new Date().toISOString();
    const rec = d.recurrence || 'none';
    const next = rec === 'none' ? null : nextOccurrence(nowIso, rec);
    const r = await persist(Object.assign(base, next
      ? { status: 'scheduled', scheduledAt: next, lastRun: nowIso }
      : { status: 'library', scheduledAt: null, lastRun: nowIso }));
    if (fromNote) await dbUpdateNote(fromNote, { status: 'planned' });
    closeDrawer(); calRef = new Date(); currentView = next ? 'calendar' : 'history'; syncTabs(); render();
    if (r) await fireTrigger(r);
  }
}
function closeDrawer() { overlay.classList.remove('is-open'); editingId = null; schedulingNoteId = null; }

/* ---------- Settings (accounts & triggers manager) ---------- */
let cfgModel = null; // editable deep copy of accounts (with secrets)
const cfgColor = (ai, ti) => { const fam = HUE_FAMILIES[ai % HUE_FAMILIES.length]; return fam[(ti < 0 ? 0 : ti) % fam.length]; };

function nextTrigLabel(a) {
  const used = new Set((a.triggers || []).map((t) => t.label));
  for (let i = 0; i < 26; i++) { const c = String.fromCharCode(65 + i); if (!used.has(c)) return c; }
  return '';
}
function syncCfgFromDom() {
  $$('.cfg-aname').forEach((el) => { const a = cfgModel[+el.dataset.ai]; if (a) a.label = el.value.trim() || a.label; });
  // Account-level OpenRouter key override (agent accounts). Blank keeps the saved one.
  $$('.cfg-akey').forEach((el) => { const a = cfgModel[+el.dataset.ai]; if (a) { const v = el.value.trim(); if (v) a.key = v; } });
  $$('.cfg-tlabel').forEach((el) => { const t = (cfgModel[+el.dataset.ai] || {}).triggers?.[+el.dataset.ti]; if (t) t.label = el.value.trim(); });
  $$('.cfg-turl').forEach((el) => { const t = (cfgModel[+el.dataset.ai] || {}).triggers?.[+el.dataset.ti]; if (t) t.trigger = el.value.trim(); });
  $$('.cfg-ttoken').forEach((el) => { const t = (cfgModel[+el.dataset.ai] || {}).triggers?.[+el.dataset.ti]; if (t) { const v = el.value.trim(); if (v) t.token = v; } });
  // Agent instance model select.
  $$('.cfg-tmodel').forEach((el) => { const t = (cfgModel[+el.dataset.ai] || {}).triggers?.[+el.dataset.ti]; if (t) t.model = el.value; });
  // Agent instance tool checkboxes — reset each instance's list on first box seen, then collect the checked ones.
  const toolSeen = new Set();
  $$('.cfg-ttool').forEach((el) => {
    const ai = +el.dataset.ai, ti = +el.dataset.ti;
    const t = (cfgModel[ai] || {}).triggers?.[ti]; if (!t) return;
    const k = `${ai}:${ti}`; if (!toolSeen.has(k)) { t.tools = []; toolSeen.add(k); }
    if (el.checked) t.tools.push(el.dataset.tool);
  });
}
function renderCfgAccounts() {
  const host = $('#cfg-accounts'); if (!host) return;
  const kindOf = (a) => a.kind || (a.id === 'openrouter' ? 'openrouter' : 'claude');
  host.innerHTML = cfgModel.map((a, ai) => {
    const kind = kindOf(a);
    // Built-in Perplexity enrichment account — left exactly as-is (read-only).
    if (kind === 'openrouter') return `
    <div class="acct-cfg">
      <div class="acct-cfg__head">
        <span class="acct-dot" style="background:${cfgColor(ai, -1)}"></span>
        <input class="input cfg-aname" data-ai="${ai}" value="${esc(a.label)}" placeholder="Account name" />
        <span class="pill" title="Non-Claude executor">⚡ OpenRouter</span>
      </div>
      <div class="hint" style="padding:6px 2px">Executes <b>without a Claude session</b> — routines under this account run Perplexity research through the server-side OpenRouter key and write straight to Command / Abstrax. No Fire URL or token to set here; the key lives in Supabase edge secrets. Create a routine and pick this account to schedule lead enrichment.</div>
    </div>`;
    // OpenRouter agent account — user-addable; multiple named instances, each a
    // model + tool set. Runs the openrouter-agent edge function.
    if (kind === 'openrouter-agent') return `
    <div class="acct-cfg">
      <div class="acct-cfg__head">
        <span class="acct-dot" style="background:${cfgColor(ai, -1)}"></span>
        <input class="input cfg-aname" data-ai="${ai}" value="${esc(a.label)}" placeholder="Account name" />
        <span class="pill" title="Runs an OpenRouter model with tools">⚡ Agent</span>
        <button class="iconbtn" title="Remove account" data-act="del-acct" data-ai="${ai}">✕</button>
      </div>
      <input class="input cfg-akey" data-ai="${ai}" type="password" autocomplete="off" placeholder="${a.key ? '•••• key saved — blank to keep' : 'OpenRouter API key (sk-or-…) — blank = use server key'}" />
      <div class="hint" style="padding:4px 2px"><b>Fix code (GitHub)</b> lets this non-Claude model read the repo and open/merge pull requests — no Claude session. It needs a <code>GITHUB_TOKEN</code> edge secret (and <code>GITHUB_REPO</code>); merging also needs <code>AGENT_ALLOW_MERGE=true</code>. Without them the checkbox is inert.</div>
      <div class="trig-list">${a.triggers.map((t, ti) => `
        <div class="trig-cfg">
          <div class="trig-cfg__top">
            <span class="acct-dot" style="background:${cfgColor(ai, ti)}"></span>
            <input class="input cfg-tlabel" data-ai="${ai}" data-ti="${ti}" value="${esc(t.label)}" placeholder="Instance name" />
            <button class="iconbtn" title="Remove instance" data-act="del-trig" data-ai="${ai}" data-ti="${ti}">✕</button>
          </div>
          <select class="select cfg-tmodel" data-ai="${ai}" data-ti="${ti}">${AGENT_MODELS().map((m) => `<option value="${m.id}" ${(t.model || DEFAULT_AGENT_MODEL) === m.id ? 'selected' : ''}>${esc(m.label.split(' — ')[0])}</option>`).join('')}</select>
          <div class="trig-tools">${AGENT_TOOLS.map((tool) => `<label class="tool-chk"><input type="checkbox" class="cfg-ttool" data-ai="${ai}" data-ti="${ti}" data-tool="${tool.id}" ${normalizeTools(t.tools).includes(tool.id) ? 'checked' : ''} /> ${esc(tool.label)}</label>`).join('')}</div>
          <div class="trig-test"><button class="btn btn--ghost btn--sm" data-act="test-trig" data-ai="${ai}" data-ti="${ti}">Save &amp; test run</button><span class="trig-status" data-ai="${ai}" data-ti="${ti}"></span></div>
        </div>`).join('')}</div>
      <button class="btn btn--ghost btn--sm" data-act="add-trig" data-ai="${ai}">Add instance</button>
    </div>`;
    // Claude account (default).
    return `
    <div class="acct-cfg">
      <div class="acct-cfg__head">
        <span class="acct-dot" style="background:${cfgColor(ai, -1)}"></span>
        <input class="input cfg-aname" data-ai="${ai}" value="${esc(a.label)}" placeholder="Account name" />
        <button class="iconbtn" title="Remove account" data-act="del-acct" data-ai="${ai}">✕</button>
      </div>
      <div class="trig-list">${a.triggers.map((t, ti) => `
        <div class="trig-cfg">
          <div class="trig-cfg__top">
            <span class="acct-dot" style="background:${cfgColor(ai, ti)}"></span>
            <input class="input cfg-tlabel" data-ai="${ai}" data-ti="${ti}" value="${esc(t.label)}" placeholder="Label" />
            <button class="iconbtn" title="Remove trigger" data-act="del-trig" data-ai="${ai}" data-ti="${ti}">✕</button>
          </div>
          <input class="input cfg-turl" data-ai="${ai}" data-ti="${ti}" value="${esc(t.trigger)}" placeholder="Fire URL or trig_…" />
          <input class="input cfg-ttoken" data-ai="${ai}" data-ti="${ti}" type="password" autocomplete="off" placeholder="${t.token ? '•••• saved — blank to keep' : 'Token (sk-ant-…)'}" />
          <div class="trig-test"><button class="btn btn--ghost btn--sm" data-act="test-trig" data-ai="${ai}" data-ti="${ti}">Save &amp; test fire</button><span class="trig-status" data-ai="${ai}" data-ti="${ti}"></span></div>
        </div>`).join('')}</div>
      <button class="btn btn--ghost btn--sm" data-act="add-trig" data-ai="${ai}">Add trigger</button>
    </div>`;
  }).join('') + `<div class="cfg-addacct-row"><button class="btn btn--secondary btn--sm cfg-addacct" data-act="add-acct">Add Claude account</button><button class="btn btn--secondary btn--sm cfg-addacct" data-act="add-acct-or">Add OpenRouter account</button></div>`;

  host.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    syncCfgFromDom();
    const ai = +b.dataset.ai, ti = +b.dataset.ti, act = b.dataset.act;
    if (act === 'test-trig') return (kindOf(cfgModel[ai] || {}) === 'openrouter-agent' ? testAgentRun(ai, ti) : testTrigger(ai, ti)); // no re-render — keep typed values + show status
    if (act === 'add-acct') cfgModel.push({ id: genId('acc'), label: 'New account', kind: 'claude', triggers: [{ id: genId('t'), label: 'A', trigger: '', token: '' }] });
    else if (act === 'add-acct-or') cfgModel.push(NEW_AGENT_ACCOUNT());
    else if (act === 'del-acct') cfgModel.splice(ai, 1);
    else if (act === 'add-trig') {
      const a = cfgModel[ai];
      const base = { id: genId('t'), label: nextTrigLabel(a), trigger: '', token: '' };
      if (kindOf(a) === 'openrouter-agent') { base.model = DEFAULT_AGENT_MODEL; base.tools = [...DEFAULT_AGENT_TOOLS]; }
      a.triggers.push(base);
    }
    else if (act === 'del-trig') cfgModel[ai].triggers.splice(ti, 1);
    renderCfgAccounts();
  }));
}

/* Save current settings, then fire a harmless ping at one trigger so the user
   gets immediate confirmation their Fire URL + token actually reach Claude. */
async function pingTrigger(account, triggerKey) {
  const url = settings.triggerUrl.trim() || TRIGGER_FN;
  const headers = { 'content-type': 'application/json' };
  const { data: { session: s } } = await sb.auth.getSession();
  if (s && s.access_token) headers.Authorization = `Bearer ${s.access_token}`;
  const body = JSON.stringify({ text: 'Connection test from the Routine Planner — no action needed.', account, triggerKey, source: 'planner-test', at: new Date().toISOString() });
  try {
    const r = await fetch(url, { method: 'POST', headers, body });
    if (r.ok) return { ok: true };
    const m = (await r.text().catch(() => '')).slice(0, 160);
    return { ok: false, msg: `HTTP ${r.status}. ${m || 'Check the Fire URL + token.'}` };
  } catch (e) { return { ok: false, msg: e.message }; }
}
async function testTrigger(ai, ti) {
  syncCfgFromDom();
  const acc = cfgModel[ai], t = acc && acc.triggers[ti];
  const statusEl = $(`.trig-status[data-ai="${ai}"][data-ti="${ti}"]`);
  if (!t) return;
  if (!t.trigger) { statusEl.textContent = 'Add a Fire URL first.'; statusEl.className = 'trig-status is-err'; return; }
  statusEl.textContent = 'Saving + testing…'; statusEl.className = 'trig-status';
  const saved = await dbSaveAccountCreds(cfgModel);
  accountsCfg = normalizeAccounts(cfgModel, false);
  if (!saved) { statusEl.textContent = 'Couldn’t save settings.'; statusEl.className = 'trig-status is-err'; return; }
  const res = await pingTrigger(acc.id, t.id);
  statusEl.textContent = res.ok ? '✓ Reached your Claude routine — it’s live.' : `✕ ${res.msg}`;
  statusEl.className = 'trig-status ' + (res.ok ? 'is-ok' : 'is-err');
}
/* Save settings, then ping the openrouter-agent function so the user confirms
   the chosen model is reachable with the resolved key (per-account override or
   the server key). A `ping` does a 1-token completion, no tools. */
async function testAgentRun(ai, ti) {
  syncCfgFromDom();
  const acc = cfgModel[ai], t = acc && acc.triggers[ti];
  const statusEl = $(`.trig-status[data-ai="${ai}"][data-ti="${ti}"]`);
  if (!t) return;
  statusEl.textContent = 'Saving + testing…'; statusEl.className = 'trig-status';
  const saved = await dbSaveAccountCreds(cfgModel);
  accountsCfg = normalizeAccounts(cfgModel, false);
  if (!saved) { statusEl.textContent = 'Couldn’t save settings.'; statusEl.className = 'trig-status is-err'; return; }
  const { error } = await sessionForFire();
  if (error) { statusEl.textContent = `✕ ${error}`; statusEl.className = 'trig-status is-err'; return; }
  try {
    const r = await agentPost({ ping: true, account: acc.id, triggerKey: t.id, model: t.model || DEFAULT_AGENT_MODEL });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) { statusEl.textContent = `✕ ${data.error || `HTTP ${r.status}`}`; statusEl.className = 'trig-status is-err'; return; }
    statusEl.textContent = `✓ ${modelLabel(t.model || DEFAULT_AGENT_MODEL)} reachable${data.keySource ? ` (${data.keySource} key)` : ''}.`;
    statusEl.className = 'trig-status is-ok';
  } catch (e) { statusEl.textContent = `✕ ${e.message}`; statusEl.className = 'trig-status is-err'; }
}
/* Auto-routing policy editor — a task_type × complexity grid of model pickers.
   Prefilled from the live policy (the user's saved one, else the built-in
   default). Routing targets are concrete models, so 'auto' is excluded. */
const POLICY_MODELS = MODELS.filter((m) => m.id !== 'auto');
function policyEditorHtml() {
  const pol = getActivePolicy();
  const opts = (sel) => POLICY_MODELS.map((m) => `<option value="${m.id}" ${sel === m.id ? 'selected' : ''}>${esc(m.label.split(' — ')[0])}</option>`).join('');
  const rows = TASK_TYPES.map((tt) => `
    <tr><th class="pol-th">${esc(tt.label)}</th>${COMPLEXITIES.map((cx) => {
      const cur = (pol[tt.id] && pol[tt.id][cx.id]) || '';
      return `<td><select class="select select--sm pol-cell" data-tt="${tt.id}" data-cx="${cx.id}">${opts(cur)}</select></td>`;
    }).join('')}</tr>`).join('');
  return `<table class="pol-grid"><thead><tr><th></th>${COMPLEXITIES.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
}
function readPolicyFromDom() {
  const pol = {};
  $$('.pol-cell').forEach((el) => {
    const tt = el.dataset.tt, cx = el.dataset.cx;
    (pol[tt] ||= {})[cx] = el.value;
  });
  return normalizePolicy(pol); // null if somehow empty → clears back to default
}
/* True when a policy matches the built-in default cell-for-cell (so we store
   null instead of a redundant copy). */
function policyIsDefault(pol) {
  return TASK_TYPES.every((tt) => COMPLEXITIES.every((cx) =>
    (pol[tt.id] || {})[cx.id] === ROUTING_POLICY[tt.id][cx.id]));
}

async function openSettings() {
  editingId = null;
  drawerTitle.textContent = 'Settings';
  drawerBody.innerHTML = `<div class="notice">Loading your settings…</div>`;
  drawerFoot.innerHTML = '';
  overlay.classList.add('is-open');

  cfgModel = normalizeAccounts(await dbLoadAccountCreds(), true);

  drawerBody.innerHTML = `
    <div class="notice">Add a Claude <b>account</b>, then give it one or more <b>triggers</b> — each is a Fire URL (or <code>trig_…</code>) + token. Or add an <b>OpenRouter account</b> whose named <b>instances</b> each run a model (e.g. Kimi) with tools to read your data, research the web, and write into your apps — their output lands in <b>Chat</b>, where you can reply to continue the conversation. Routines pick which trigger/instance fires them. Saved to your account and used server-side; no Netlify setup needed.</div>
    <div class="field__row">
      <div class="field"><label class="label" for="s-account">Default account</label>
        <select class="select" id="s-account">${cfgModel.map((a) => `<option value="${a.id}" ${(settings.account || DEFAULT_ACCOUNT) === a.id ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}</select></div>
      <div class="field"><label class="label" for="s-model">Default model</label>
        <select class="select" id="s-model">${MODELS.map((m) => `<option value="${m.id}" ${settings.model === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}</select>
        <span class="hint">New routines start here. <b>Auto</b> lets Routiner pick per task.</span></div>
    </div>
    <div class="cfg-sep">Firing</div>
    <div class="fire-row">
      <div class="fire-row__text">
        <b>Fire routines from this site</b>
        <span class="hint">The master catch. Paused means nothing fires from this browser — scheduled runs and <b>Run now</b> both stay put. Saved per browser.</span>
      </div>
      <label class="fire-toggle" id="fireSwitch">
        <span class="fire-toggle__label" id="fireLabel">Paused</span>
        <span class="fire-toggle__track"><span class="fire-toggle__knob"></span></span>
      </label>
    </div>
    <div class="cfg-sep">Accounts &amp; triggers</div>
    <div id="cfg-accounts"></div>
    <details class="cfg-adv"><summary>Auto-routing policy</summary>
      <div class="notice">Which model <b>Auto</b> picks per task type &amp; complexity. Both the app and the scheduler read this — leave it to use Routiner's defaults.</div>
      ${policyEditorHtml()}
      <div class="pol-actions"><button class="btn btn--ghost btn--sm" id="pol-reset" type="button">Reset to defaults</button></div>
    </details>
    <details class="cfg-adv"><summary>Advanced (optional)</summary>
      <div class="field"><label class="label" for="s-trigger">Trigger URL override</label>
        <input class="input" id="s-trigger" placeholder="leave blank to use the built-in function" value="${esc(settings.triggerUrl)}" />
        <span class="hint">Leave blank to use <code>/.netlify/functions/claude-trigger</code>. Set a URL only to POST a different webhook directly (bypasses the accounts above).</span></div>
      <div class="field"><label class="label" for="s-key">Anthropic API key (“Test live” on Claude models)</label>
        <input class="input" id="s-key" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(settings.anthropicKey)}" />
        <span class="hint">Stored only in this browser; used only by the in-drawer Test button.</span></div>
      <div class="field"><label class="label" for="s-or-key">OpenRouter API key (“Test live” on OpenRouter models)</label>
        <input class="input" id="s-or-key" type="password" autocomplete="off" placeholder="sk-or-…" value="${esc(settings.openrouterKey)}" />
        <span class="hint">Optional. Only needed to preview OpenRouter models. Get one at openrouter.ai/keys.</span></div>
    </details>`;
  drawerFoot.innerHTML = `<button class="btn btn--primary" id="s-save">Save settings</button>`;
  renderCfgAccounts();

  // The fire switch saves on flip (it's a safety catch, not a form field).
  paintFireSwitch();
  $('#fireSwitch')?.addEventListener('click', toggleFireSwitch);

  // Reset the policy grid's selects to the built-in defaults (saved on Save).
  const resetBtn = $('#pol-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    $$('.pol-cell').forEach((el) => { el.value = ROUTING_POLICY[el.dataset.tt][el.dataset.cx]; });
  });

  $('#s-save').addEventListener('click', async () => {
    syncCfgFromDom();
    const btn = $('#s-save'); btn.disabled = true; btn.textContent = 'Saving…';
    // A policy identical to the built-in default is stored as null (use defaults).
    const pol = readPolicyFromDom();
    const toStore = (!pol || policyIsDefault(pol)) ? null : pol;
    const ok = await dbSaveAccountCreds(cfgModel, toStore);
    accountsCfg = normalizeAccounts(cfgModel, false);
    if (ok) { settingsPolicy = toStore; setActivePolicy(toStore); }
    settings.account = $('#s-account').value;
    if (!getAccountCfg(settings.account)) settings.account = (accountsCfg[0] || {}).id || DEFAULT_ACCOUNT;
    settings.model = $('#s-model').value; settings.triggerUrl = $('#s-trigger').value.trim();
    settings.anthropicKey = $('#s-key').value.trim(); settings.openrouterKey = $('#s-or-key').value.trim();
    saveSettings();
    btn.disabled = false; btn.textContent = 'Save settings';
    if (ok) { closeDrawer(); render(); toast('Settings saved.'); }
  });
}

/* ---------- Tabs ---------- */
function syncTabs() { $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === currentView)); }

/* ---------- Account menu (top-right) ---------- */
function closeAcctMenu() {
  const m = $('#acctMenu'); if (!m) return;
  m.classList.remove('is-open');
  $('#userChip')?.setAttribute('aria-expanded', 'false');
}
function wireAcctMenu() {
  const menu = $('#acctMenu'), btn = $('#userChip');
  if (!menu || !btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !menu.classList.contains('is-open');
    menu.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) closeAcctMenu(); });
}

/* ---------- Auth UI ---------- */
function showAuth(mode = 'signin') {
  const bar = $('#topbar'); if (bar) bar.style.display = 'none';
  $('.app')?.classList.add('is-auth');
  $('.content')?.classList.remove('content--flush'); // the auth card wants the normal page scroll

  const signup = mode === 'signup';
  view.innerHTML = `<div class="auth">
    <h2>${signup ? 'Create your account' : 'Sign in'}</h2>
    <p class="sub">${signup ? 'Set an email and password — your routines save to your account.' : 'Welcome back to your routines.'}</p>
    <div class="auth__msg" id="auth-msg"></div>
    <div class="field"><label class="label" for="au-email">Email</label><input class="input" id="au-email" type="email" autocomplete="email" placeholder="you@example.com" /></div>
    <div class="field"><label class="label" for="au-pass">Password</label><input class="input" id="au-pass" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" placeholder="••••••••" /></div>
    <button class="btn btn--primary" id="au-go">${signup ? 'Create account' : 'Sign in'}</button>
    <div class="auth__alt">${signup ? 'Already have an account? <a id="au-switch">Sign in</a>' : 'New here? <a id="au-switch">Create an account</a>'}</div>
  </div>`;
  const msg = (t, ok = false) => { const m = $('#auth-msg'); m.textContent = t; m.className = 'auth__msg ' + (ok ? 'is-ok' : 'is-err'); };
  $('#au-switch').addEventListener('click', () => showAuth(signup ? 'signin' : 'signup'));
  const submit = async () => {
    const email = $('#au-email').value.trim(), password = $('#au-pass').value;
    if (!email || !password) return msg('Enter your email and password.');
    $('#au-go').disabled = true;
    if (signup) {
      const { data, error } = await sb.auth.signUp({ email, password });
      $('#au-go').disabled = false;
      if (error) return msg(error.message);
      if (!data.session) return msg('Account created. If email confirmation is on, confirm via email, then sign in.', true);
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      $('#au-go').disabled = false;
      if (error) return msg(error.message);
    }
  };
  $('#au-go').addEventListener('click', submit);
  $('#au-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function showApp() {
  const bar = $('#topbar'); if (bar) bar.style.display = '';
  $('.app')?.classList.remove('is-auth');
  $('.content')?.classList.remove('content--flush');

  const email = session.user.email || '';
  const chip = $('#userChip');
  if (chip) { chip.textContent = (email[0] || '?').toUpperCase(); chip.title = `Signed in as ${email}`; }
  const who = $('#acctWho');
  if (who) who.textContent = email;
  syncTabs();
  /* Paint a loading state *now*. loadAll() is a network round trip and it is
     render() at the end of it that finally replaces the view — so until this
     existed, a signed-in user stared at the sign-in card they had just used
     while their data loaded, and at a stalled load they stared at it forever.
     That reads as "it didn't load" and gets refreshed. */
  showLoading('Loading your routines…');
  loadAll();
}

/* ---------- Load / boot failure surfaces ----------
   Every one of these exists because the alternative was a screen with nothing
   on it. A blank page is indistinguishable from a hung one, so the only move it
   leaves the reader is a refresh — which is the bug being reported. */
function showLoading(msg) {
  view.innerHTML = `<div class="loadstate"><span class="loadstate__spin" aria-hidden="true"></span>
    <p>${esc(msg)}</p></div>`;
}

/* A dead end the reader can act on: what failed, and a button that retries the
   fetch in place (no full reload, so an unsaved drawer or scroll isn't lost). */
function showLoadError(err, retry) {
  const why = (err && err.message) || String(err || 'Unknown error');
  view.innerHTML = `<div class="grid"><div class="empty">
    <h3>Couldn’t load your routines</h3>
    <p>${esc(why)}</p>
    <p class="loadstate__hint">This is usually a dropped connection. Retrying is safe — nothing was changed.</p>
    <button class="btn btn--primary" data-act="retry">Try again</button>
  </div></div>`;
  $('[data-act="retry"]', view)?.addEventListener('click', () => { showLoading('Retrying…'); retry(); });
}

/* Reject after `ms` instead of waiting forever.
   supabase-js serializes auth-storage access behind a Web Lock. A lock held by
   a tab the OS killed — or a token refresh stuck on a connection that went away
   without closing, which is routine on iPadOS when Safari suspends a
   backgrounded tab — leaves getSession() pending with no timeout of its own.
   Every caller here awaits it, so one wedged lock froze the whole boot. */
function withTimeout(p, ms, what) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms); }),
  ]);
}

/* Read the persisted session straight out of storage, bypassing the lock.
   Only used when getSession() times out: it lets a boot that would otherwise
   dead-end still come up signed in. Returns null unless the token is present
   and not already expired — a stale token would just fail on first use. */
function sessionFromStorage() {
  try {
    const raw = localStorage.getItem('routiner-auth');
    if (!raw) return null;
    const s = JSON.parse(raw);
    const sess = s && (s.currentSession || s.session || s);
    if (!sess || !sess.access_token || !sess.user) return null;
    if (sess.expires_at && sess.expires_at * 1000 <= Date.now()) return null;
    return sess;
  } catch { return null; }
}

/* ---------- Viewport height ----------
   The shell is exactly one viewport tall and its columns scroll inside that, so
   the height has to be right or content ends up clipped and unreachable. `dvh`
   is the CSS answer but iPadOS Safari disagrees with itself about it in a
   Stage Manager window, so measure the visual viewport and hand it to CSS as
   --app-h; the dvh value stays as the fallback. Measuring also means the pane
   shrinks when the on-screen keyboard opens, keeping the reply box in view
   instead of behind the keyboard. */
function trackAppHeight() {
  const vv = window.visualViewport;
  const apply = () => {
    // Ignore a pinch-zoomed visual viewport — that's a smaller window onto the
    // same page, not a smaller page.
    const zoomed = vv && Math.abs((vv.scale || 1) - 1) > 0.02;
    const h = (!zoomed && vv && vv.height) || window.innerHeight || 0;
    if (h > 240) document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
    fitHistoryPane();   // the pane is sized from the viewport too
  };
  apply();
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', () => setTimeout(apply, 150));
  vv?.addEventListener('resize', apply);
}

/* ---------- Init ---------- */
function wireOnce() {
  trackAppHeight();
  $('#newBtn').addEventListener('click', () => openDrawer());
  $('#budgetChip').addEventListener('click', openForecast);
  $('#settingsBtn').addEventListener('click', () => { closeAcctMenu(); openSettings(); });
  $('#signOutBtn').addEventListener('click', async () => { closeAcctMenu(); await sb.auth.signOut(); });
  wireAcctMenu();
  $('#drawerClose').addEventListener('click', closeDrawer);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDrawer(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeDrawer(); closeAcctMenu();
    if (railOpen) setRail(false);
  });
  $$('.tab').forEach((t) => t.addEventListener('click', () => { currentView = t.dataset.view; syncTabs(); render(); }));
  wireCalendarZoom();
  setInterval(paintStatus, 30000);
}

async function init() {
  wireOnce();

  let s = null;
  try {
    ({ data: { session: s } } = await withTimeout(sb.auth.getSession(), 8000, 'Reading your session'));
  } catch (e) {
    // The auth lock is wedged (see withTimeout). Don't strand the reader on an
    // empty page: fall back to the stored session so the app still comes up,
    // and let it fall through to sign-in if there isn't a usable one.
    console.warn('[routiner] getSession stalled, falling back to stored session:', e);
    s = sessionFromStorage();
  }
  session = s;
  session ? showApp() : showAuth('signin');

  sb.auth.onAuthStateChange((_event, s2) => {
    const was = !!session; session = s2;
    if (s2 && !was) { showApp(); toast('Signed in.'); }
    else if (!s2 && was) { routines = []; runs = []; notes = []; showAuth('signin'); }
    else if (s2 && was) { /* token refresh — ignore */ }
  });
}

/* Tell index.html's boot watchdog we got this far, so it stops counting and
   takes its placeholder down. Anything that throws before this point leaves the
   page blank, so it has to be reported rather than swallowed. */
init().then(
  () => window.__routinerBooted?.(),
  (e) => {
    console.error('[routiner] boot failed:', e);
    window.__routinerBootFailed?.((e && e.message) || String(e));
  },
);
