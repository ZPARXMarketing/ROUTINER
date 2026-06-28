/* ============================================================
   Claude Routine Planner — app logic (Supabase-backed)

   Sign in with email + password; your routines and run history
   live in Supabase (row-level-secured per user), so they're there
   on every device, every login. "Run now" fires your Claude Code
   routine via the Netlify CLAUDE_TRIGGER function, passing the
   prompt as a session turn.
   ============================================================ */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://vonfdzttupyemtomsojy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_60-OPzmfueDopyogbm20pg_linElDjT';
const TRIGGER_FN = '/.netlify/functions/claude-trigger';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const MODELS = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 — most capable' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 — balanced' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 — fast & cheap' },
];
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const RECURRENCE = { none: 'One-time', daily: 'Every day', weekdays: 'Weekdays (Mon–Fri)', weekly: 'Every week' };

/* ---------- Accounts & triggers (user-managed) ----------
   Each account holds a list of triggers (instances). A trigger is one Fire URL
   (or trig_… id) + token. Routines target an account AND a specific trigger.
   The structure lives in Supabase routiner_settings.accounts and is editable
   in Settings; `accountsCfg` is the in-memory copy (secrets stripped) used to
   render. */
const KNOWN_LABELS = { sparks9679: 'Sparks9679', zparxmarketing: 'ZparxMarketing' };
const DEFAULT_ACCOUNT = 'sparks9679';
const DEFAULT_ACCOUNTS = () => [
  { id: 'sparks9679', label: 'Sparks9679', triggers: [{ id: 't_a', label: 'A', trigger: '', token: '' }] },
  { id: 'zparxmarketing', label: 'ZparxMarketing', triggers: [{ id: 't_a', label: 'A', trigger: '', token: '' }] },
];
let accountsCfg = DEFAULT_ACCOUNTS();

const genId = (p) => `${p}_${Math.random().toString(36).slice(2, 8)}`;

/* Normalize whatever is stored (new array shape, old { id:{trigger,token} } map,
   or empty) into the array shape. `keepSecrets:false` strips trigger/token so the
   broadly-held copy carries only ids + labels. */
function normalizeAccounts(raw, keepSecrets) {
  const trig = (t, i) => ({ id: t.id || genId('t'), label: t.label || String.fromCharCode(65 + i),
    trigger: keepSecrets ? (t.trigger || '') : '', token: keepSecrets ? (t.token || '') : '' });
  if (Array.isArray(raw) && raw.length) {
    return raw.map((a) => ({ id: a.id || genId('acc'), label: a.label || KNOWN_LABELS[a.id] || a.id,
      triggers: (a.triggers || []).map(trig) }));
  }
  if (raw && typeof raw === 'object' && Object.keys(raw).length) { // old map shape
    return Object.entries(raw).map(([id, v]) => ({ id, label: KNOWN_LABELS[id] || id,
      triggers: (v && (v.trigger || v.token)) ? [trig({ id: 't1', label: 'A', trigger: v.trigger, token: v.token }, 0)] : [] }));
  }
  return DEFAULT_ACCOUNTS();
}

const listAccounts = () => accountsCfg;
const getAccountCfg = (id) => accountsCfg.find((a) => a.id === id);
const accountIndex = (id) => accountsCfg.findIndex((a) => a.id === id);
const accountLabel = (id) => { const a = getAccountCfg(id); return a ? a.label : (KNOWN_LABELS[id] || id || ''); };
const accountTriggers = (id) => (getAccountCfg(id) || {}).triggers || [];
const triggerCfg = (accId, tId) => accountTriggers(accId).find((t) => t.id === tId);
const triggerLabel = (accId, tId) => { const t = triggerCfg(accId, tId); return t ? t.label : ''; };

/* Color engine: each account is a hue family; each trigger a distinct shade
   within it — so A/B/C read as the same account, told apart by shade, and the
   whole thing stays on-brand against the dark UI. */
const HUE_FAMILIES = [
  ['#BCEF2F', '#86E01E', '#C8FF45', '#9FD630', '#6FBF2A'], // lime / green
  ['#4D6BFF', '#4DA6FF', '#22D3EE', '#7C9CFF', '#3D5AF1'], // blue / cyan
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

function triggerColor(accId, tId) {
  const ai = accountIndex(accId);
  if (ai < 0) return GREY;
  const fam = HUE_FAMILIES[ai % HUE_FAMILIES.length];
  const trigs = accountTriggers(accId);
  let ti = trigs.findIndex((t) => t.id === tId);
  if (ti < 0) ti = 0; // routine with no/unknown trigger → account's base shade
  return swatch(fam[ti % fam.length]);
}
const accountColor = (accId) => triggerColor(accId, null); // base shade for the account

/* How long a routine block occupies on the calendar */
const DEFAULT_DURATION_MIN = 45;
const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];
const fmtDuration = (m) => m < 60 ? `${m} min` : (m % 60 === 0 ? `${m / 60} hr` : `${(m / 60).toFixed(1)} hr`);

/* Week-calendar layout knobs — full 24h day (routines can fire overnight) */
const CAL = { startHour: 0, endHour: 24, hourPx: 44, defaultDurationMin: DEFAULT_DURATION_MIN };
let calRef = new Date(); // any day inside the week currently shown

/* settings (model / default account / optional trigger override / test key) stay local */
const LS = 'routiner.settings.v1';
let settings = loadSettings();
function loadSettings() {
  try { return Object.assign({ model: DEFAULT_MODEL, account: DEFAULT_ACCOUNT, triggerUrl: '', apiKey: '' }, JSON.parse(localStorage.getItem(LS) || '{}')); }
  catch { return { model: DEFAULT_MODEL, account: DEFAULT_ACCOUNT, triggerUrl: '', apiKey: '' }; }
}
function saveSettings() { localStorage.setItem(LS, JSON.stringify(settings)); }

let routines = [];
let runs = [];
let notes = [];
let currentView = 'calendar';
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
function nextOccurrence(iso, rec) {
  if (!iso || rec === 'none') return null;
  let d = new Date(iso); const now = Date.now();
  do { d.setDate(d.getDate() + (rec === 'weekly' ? 7 : 1)); if (rec === 'weekdays') while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); } while (d.getTime() <= now);
  return d.toISOString();
}

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
  id: r.id, title: r.title, prompt: r.prompt, model: r.model, account: r.account || DEFAULT_ACCOUNT,
  triggerKey: r.trigger_key || null,
  recurrence: r.recurrence, status: r.status, scheduledAt: r.scheduled_at, lastRun: r.last_run,
  durationMin: r.duration_min || DEFAULT_DURATION_MIN,
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const toRow = (o) => ({
  title: o.title ?? '', prompt: o.prompt ?? '', model: o.model || DEFAULT_MODEL,
  account: o.account || DEFAULT_ACCOUNT, trigger_key: o.triggerKey || null,
  recurrence: o.recurrence || 'none', status: o.status || 'library',
  duration_min: o.durationMin || DEFAULT_DURATION_MIN,
  scheduled_at: o.scheduledAt || null, last_run: o.lastRun || null,
});

/* ---------- Data layer ---------- */
async function loadAll() {
  const [rRes, runRes, setRes] = await Promise.all([
    sb.from('routiner_routines').select('*').order('updated_at', { ascending: false }),
    sb.from('routiner_runs').select('*').order('fired_at', { ascending: false }).limit(200),
    sb.from('routiner_settings').select('accounts').maybeSingle(),
  ]);
  accountsCfg = normalizeAccounts(setRes && setRes.data && setRes.data.accounts, false);
  if (rRes.error) { toast('Load failed: ' + rRes.error.message, 'error'); return; }
  routines = (rRes.data || []).map(fromRow);
  runs = (runRes.data || []).map((x) => ({ id: x.id, routineId: x.routine_id, title: x.title, status: x.status, output: x.output, firedAt: x.fired_at }));
  await dbLoadNotes();
  render();
}
const getRoutine = (id) => routines.find((r) => r.id === id);

async function dbCreate(obj) {
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
  const { data, error } = await sb.from('routiner_settings').select('accounts').maybeSingle();
  if (error) { toast('Couldn’t load account settings: ' + error.message, 'error'); return {}; }
  return (data && data.accounts) || {};
}
async function dbSaveAccountCreds(accounts) {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { toast('Sign in to save settings.', 'error'); return false; }
  const { error } = await sb.from('routiner_settings')
    .upsert({ user_id: user.id, accounts, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
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

/* ---------- Trigger (fire the Claude Code routine) ---------- */
async function fireTrigger(routine) {
  const direct = settings.triggerUrl.trim();
  const url = direct || TRIGGER_FN;
  const payload = JSON.stringify({ text: routine?.prompt || '', account: routine?.account || DEFAULT_ACCOUNT, triggerKey: routine?.triggerKey || null, source: 'claude-routine-planner', routineId: routine?.id, title: routine?.title, at: new Date().toISOString() });
  // Send the signed-in user's access token so the gated function authorizes us.
  const headers = { 'content-type': 'application/json' };
  const { data: { session: s } } = await sb.auth.getSession();
  if (s?.access_token && !direct) headers.Authorization = `Bearer ${s.access_token}`;
  if (!s && !direct) { toast('You must be signed in to fire routines. Please sign in and try again.', 'error'); return; }
  try {
    const r = await fetch(url, { method: 'POST', headers, body: payload });
    if (!r.ok) {
      if (r.status === 401) { toast('You must be signed in to fire routines. Try signing out and back in.', 'error'); return; }
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

/* ---------- Optional live test ---------- */
async function callClaude(prompt, model) {
  const key = settings.apiKey.trim();
  if (!key) return { status: 'dryrun', text: 'No API key set — add one in Settings to preview prompts live. (Optional; not needed for real runs.)' };
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: model || settings.model, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await resp.json();
    if (!resp.ok) return { status: 'error', text: data?.error?.message || `HTTP ${resp.status}` };
    return { status: 'success', text: (data.content || []).map((b) => b.text || '').join('\n').trim() || '(empty)' };
  } catch (e) { return { status: 'error', text: 'Request failed: ' + e.message }; }
}

/* ---------- Rendering ---------- */
function counts() {
  const c = { scheduled: 0, library: 0, archived: 0, history: runs.length, board: notes.filter((n) => n.status === 'active').length };
  routines.forEach((r) => { c[r.status] = (c[r.status] || 0) + 1; });
  return c;
}
function paintCounts() { const c = counts(); $$('[data-count]').forEach((el) => { el.textContent = c[el.dataset.count] ?? 0; }); }
function paintStatus() {
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const next = routines.filter((r) => r.status === 'scheduled' && r.scheduledAt).sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))[0];
  const clk = $('#clock'); if (clk) clk.innerHTML = next ? `${t} · next <b>${relative(next.scheduledAt)}</b>` : `${t}`;
}

function render() {
  if (!session) return;
  paintCounts(); paintStatus();
  if (currentView === 'board') return renderBoard();
  if (currentView === 'calendar') return renderCalendar();
  if (currentView === 'history') return renderHistory();
  const items = routines.filter((r) => r.status === currentView).sort((a, b) =>
    currentView === 'scheduled' ? new Date(a.scheduledAt || 0) - new Date(b.scheduledAt || 0) : new Date(b.updatedAt) - new Date(a.updatedAt));
  if (!items.length) return renderEmpty();
  view.innerHTML = `<div class="grid">${items.map(card).join('')}</div>`;
  bindCards();
}

function renderEmpty() {
  const copy = {
    scheduled: ['No routines queued', 'Create a routine and give it a time to line it up here.'],
    library: ['Your library is empty', 'Save prompts here to iterate on, then run or schedule them anytime.'],
    archived: ['Nothing archived', 'Archived routines rest here. Restore them to the library anytime.'],
  }[currentView];
  view.innerHTML = `<div class="grid"><div class="empty"><h3>${copy[0]}</h3><p>${copy[1]}</p>
    <button class="btn btn--primary" data-act="new">＋ New routine</button></div></div>`;
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
  const recur = r.recurrence && r.recurrence !== 'none' ? `<span class="chip chip--recurring">${esc(RECURRENCE[r.recurrence])}</span>` : '';
  const when = r.status === 'scheduled'
    ? `<span class="card__meta-item">⏰ <b>${fmt(r.scheduledAt)}</b> · ${relative(r.scheduledAt)}</span>`
    : (r.lastRun ? `<span class="card__meta-item">last run <b>${fmt(r.lastRun)}</b></span>` : '');
  const modelName = ((MODELS.find((m) => m.id === (r.model || settings.model)) || {}).label || '').split(' — ')[0] || r.model;
  const tLabel = triggerLabel(r.account, r.triggerKey);
  const acctText = accountLabel(r.account) + (tLabel ? ` · ${tLabel}` : '');
  return `<article class="card" data-id="${r.id}">
    <div class="card__head"><span class="card__title">${esc(r.title) || '<em>Untitled routine</em>'}</span>${statusChip(r)}</div>
    <div class="card__prompt">${esc(r.prompt) || '(no prompt)'}</div>
    <div class="card__meta">${recur}<span class="card__meta-item"><span class="acct-dot" style="background:${triggerColor(r.account, r.triggerKey).solid}"></span><b>${esc(acctText)}</b></span><span class="card__meta-item">⚡ <b>${esc(modelName)}</b></span><span class="card__meta-item">⏱ <b>${fmtDuration(r.durationMin || DEFAULT_DURATION_MIN)}</b></span>${when}</div>
    <div class="card__foot">${cardActions(r)}</div>
  </article>`;
}
function cardActions(r) {
  const run = `<button class="btn btn--accent btn--sm" data-act="run">▶ Run now</button>`;
  const edit = `<button class="btn btn--secondary btn--sm" data-act="edit">Edit</button>`;
  const del = `<button class="btn btn--danger-ghost btn--sm" data-act="delete">Delete</button>`;
  if (r.status === 'archived') return `<button class="btn btn--secondary btn--sm" data-act="library">↩ Restore</button>${del}`;
  const mid = r.status === 'library'
    ? `<button class="btn btn--primary btn--sm" data-act="schedule">⏰ Schedule</button>`
    : `<button class="btn btn--secondary btn--sm" data-act="library">▣ To library</button>`;
  const dup = `<button class="btn btn--ghost btn--sm" data-act="duplicate">⧉ Copy</button>`;
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
        await dbUpdate(r.id, Object.assign({}, r, { status: 'scheduled', scheduledAt: new Date().toISOString() }));
        render(); await fireTrigger(r); return;
      }
      if (act === 'duplicate') {
        const made = await dbCreate({ title: (r.title || 'Untitled') + ' (copy)', prompt: r.prompt, model: r.model, recurrence: r.recurrence, status: 'library', scheduledAt: null });
        if (made) { render(); toast('Duplicated to Library.'); } return;
      }
      if (act === 'library' || act === 'archive') {
        await dbUpdate(r.id, Object.assign({}, r, { status: act === 'archive' ? 'archived' : 'library', scheduledAt: null }));
        render(); toast(act === 'archive' ? 'Archived.' : 'Moved to Library.'); return;
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
  if (n.status === 'brainstorm') return `<button class="btn btn--primary btn--sm" data-nact="activate">▶ Activate</button><button class="btn btn--ghost btn--sm" data-nact="dismiss">Dismiss</button>${del}`;
  if (n.status === 'active') return `<button class="btn btn--secondary btn--sm" data-nact="brainstorm">⏸ Brainstorm</button><button class="btn btn--ghost btn--sm" data-nact="done">✓ Done</button>${del}`;
  return `<button class="btn btn--ghost btn--sm" data-nact="activate">↩ Reactivate</button><button class="btn btn--ghost btn--sm" data-nact="brainstorm">To brainstorm</button>${del}`;
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
          <button class="btn btn--primary" id="note-active">▶ Post as active</button>
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
    const status = { activate: 'active', brainstorm: 'brainstorm', done: 'done', dismiss: 'dismissed' }[act];
    if (status && await dbUpdateNote(id, { status })) render();
  }));
}

function renderHistory() {
  if (!runs.length) {
    view.innerHTML = `<div class="empty"><h3>No runs yet</h3><p>Every time a routine fires — via Run now or a live test — it lands here.</p></div>`;
    return;
  }
  view.innerHTML = `<div class="section-head"><h2>Run history</h2></div>
    <div class="history">${runs.map(runRow).join('')}</div>`;
}
function runRow(run) {
  return `<div class="run"><div class="run__head">
      <span class="chip chip--${run.status}">${run.status}</span>
      <span class="run__title">${esc(run.title)}</span>
      <span class="run__time">${fmt(run.firedAt)}</span>
    </div><div class="run__body">${esc(run.output)}</div></div>`;
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
  return `<div class="cal__ev${past ? ' cal__ev--past' : ''}" data-id="${ev.routine.id}" title="${esc(ev.routine.title)} · ${esc(acctText)} · ${timeStr}"
    style="top:${top}px; height:${height}px; left:calc(${leftPct}% + 3px); width:calc(${widthPct}% - 5px); background:${c.solid}; color:${c.ink}; border-left-color:${c.edge};">
    <div class="cal__ev-title">${esc(ev.routine.title) || 'Untitled'}</div>
    ${showTime ? `<div class="cal__ev-time">${timeStr}</div>` : ''}
  </div>`;
}

function renderCalendar() {
  const weekStart = startOfWeek(calRef), weekEnd = addDays(weekStart, 6);
  const { days, perDay } = weekEvents(weekStart);
  const total = perDay.reduce((n, d) => n + d.length, 0);
  const today = new Date();
  const colH = (CAL.endHour - CAL.startHour) * CAL.hourPx;

  const rangeLabel = `${weekStart.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${weekEnd.toLocaleDateString([], { month: weekStart.getMonth() === weekEnd.getMonth() ? undefined : 'short', day: 'numeric' })}`;

  const legend = listAccounts().map((a) => {
    const swatches = (a.triggers && a.triggers.length)
      ? a.triggers.map((t) => `<span class="cal__sw" title="${esc(t.label)}" style="background:${triggerColor(a.id, t.id).solid}"></span>`).join('')
      : `<span class="cal__sw" style="background:${accountColor(a.id).solid}"></span>`;
    return `<span class="cal__leg">${swatches}<span>${esc(a.label)}</span></span>`;
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
    else calRef = addDays(calRef, a === 'next' ? 7 : -7);
    renderCalendar();
  }));
  view.querySelectorAll('.cal__ev').forEach((el) => el.addEventListener('click', () => {
    const r = getRoutine(el.dataset.id); if (r) openDrawer(r);
  }));
  // Open scrolled to ~an hour before now so the day's in view (but night is a scroll up).
  const scrollEl = $('.cal__scroll', view);
  if (scrollEl) scrollEl.scrollTop = Math.max(0, (new Date().getHours() - 1 - CAL.startHour) * CAL.hourPx);
}

function nowLineHtml() {
  const now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
  if (mins < CAL.startHour * 60 || mins > CAL.endHour * 60) return '';
  const top = ((mins - CAL.startHour * 60) / 60) * CAL.hourPx;
  return `<div class="cal__now" style="top:${top}px"></div><div class="cal__now-dot" style="top:${top - 4}px"></div>`;
}

/* ---------- Drawer (create / edit) ---------- */
let editingId = null;
function triggerOptions(accId, selectedKey) {
  const trigs = accountTriggers(accId);
  if (!trigs.length) return `<option value="">— none yet — add in Settings —</option>`;
  return trigs.map((t) => `<option value="${t.id}" ${selectedKey === t.id ? 'selected' : ''}>${esc(t.label || '(unnamed)')}</option>`).join('');
}
function openDrawer(routine = null, opts = {}) {
  editingId = routine ? routine.id : null;
  drawerTitle.textContent = routine ? 'Edit routine' : 'New routine';
  const r = routine || { title: '', prompt: '', model: settings.model, account: settings.account || DEFAULT_ACCOUNT, triggerKey: null, recurrence: 'none', scheduledAt: null };
  const whenVal = r.scheduledAt ? toLocalInput(new Date(r.scheduledAt)) : defaultWhen();
  const curAccount = getAccountCfg(r.account) ? r.account : (listAccounts()[0] || {}).id;
  drawerBody.innerHTML = `
    <div class="field"><label class="label" for="f-title">Title</label>
      <input class="input" id="f-title" placeholder="e.g. Morning competitor scan" value="${esc(r.title)}" /></div>
    <div class="field"><label class="label" for="f-prompt">Directions for Claude</label>
      <textarea class="textarea" id="f-prompt" placeholder="Describe the task. It runs in your Claude Code routine session with full tools.">${esc(r.prompt)}</textarea>
      <span class="hint">Sent to your routine as a session turn. Use {{date}} / {{datetime}} for the run time.</span></div>
    <div class="field__row">
      <div class="field"><label class="label" for="f-account">Claude account</label>
        <select class="select" id="f-account">${listAccounts().map((a) => `<option value="${a.id}" ${curAccount === a.id ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}</select></div>
      <div class="field"><label class="label" for="f-trigger">Trigger</label>
        <select class="select" id="f-trigger">${triggerOptions(curAccount, r.triggerKey)}</select>
        <span class="hint">Which instance fires it. Manage these in ⚙ Settings.</span></div>
    </div>
    <div class="field"><label class="label" for="f-model">Model hint</label>
      <select class="select" id="f-model">${MODELS.map((m) => `<option value="${m.id}" ${(r.model || settings.model) === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}</select></div>
    <div class="field__row">
      <div class="field"><label class="label" for="f-when">Fire at</label>
        <input class="input" type="datetime-local" id="f-when" value="${whenVal}" /></div>
      <div class="field"><label class="label" for="f-dur">Duration</label>
        <select class="select" id="f-dur">${DURATIONS.map((d) => `<option value="${d}" ${(r.durationMin || DEFAULT_DURATION_MIN) === d ? 'selected' : ''}>${fmtDuration(d)}</option>`).join('')}</select></div>
      <div class="field"><label class="label" for="f-recur">Repeat</label>
        <select class="select" id="f-recur">${Object.entries(RECURRENCE).map(([k, v]) => `<option value="${k}" ${r.recurrence === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    </div>
    <div class="field"><button class="btn btn--ghost btn--sm" id="f-test" type="button">⚡ Test live (optional, uses API)</button>
      <div class="run__body" id="f-test-out" style="display:none"></div></div>
    <div class="notice"><b>Run now</b> fires your routine immediately with this prompt. <b>Schedule</b> queues it for the time above (repeating if set). <b>Save to library</b> parks it.</div>`;
  drawerFoot.innerHTML = `
    <button class="btn btn--accent" data-do="now">▶ Run now</button>
    <button class="btn btn--brand" data-do="schedule">⏰ Schedule</button>
    <button class="btn btn--secondary" data-do="library">▣ Save to library</button>`;
  $('#f-test', drawerBody).addEventListener('click', testLive);
  $('#f-account', drawerBody).addEventListener('change', (e) => { $('#f-trigger', drawerBody).innerHTML = triggerOptions(e.target.value, null); });
  drawerFoot.querySelectorAll('[data-do]').forEach((b) => b.addEventListener('click', () => submitDrawer(b.dataset.do)));
  setTimeout(() => $(opts.forceSchedule ? '#f-when' : '#f-title', drawerBody)?.focus(), 50);
  overlay.classList.add('is-open');
}
async function testLive() {
  const prompt = $('#f-prompt').value;
  if (!prompt.trim()) return toast('Add directions first.', 'error');
  const out = $('#f-test-out'), btn = $('#f-test');
  btn.disabled = true; btn.textContent = '⚡ Testing…'; out.style.display = 'block'; out.textContent = 'Calling the Messages API…';
  const res = await callClaude(prompt, $('#f-model').value);
  out.textContent = res.text; btn.disabled = false; btn.textContent = '⚡ Test live (optional, uses API)';
  await dbInsertRun({ id: editingId, title: $('#f-title').value || 'Live test' }, res);
}
function readDrawer() {
  return { title: $('#f-title').value.trim(), prompt: $('#f-prompt').value, model: $('#f-model').value, account: $('#f-account').value, triggerKey: $('#f-trigger').value || null, durationMin: parseInt($('#f-dur').value, 10) || DEFAULT_DURATION_MIN, recurrence: $('#f-recur').value, whenRaw: $('#f-when').value };
}
async function persist(base) { return editingId ? dbUpdate(editingId, Object.assign(getRoutine(editingId) || {}, base)) : dbCreate(base); }

async function submitDrawer(action) {
  const d = readDrawer();
  if (!d.prompt.trim()) { toast('Add directions first.', 'error'); $('#f-prompt').focus(); return; }
  const base = { title: d.title, prompt: d.prompt, model: d.model, account: d.account, triggerKey: d.triggerKey, durationMin: d.durationMin, recurrence: d.recurrence };

  if (action === 'library') {
    await persist(Object.assign(base, { status: 'library', scheduledAt: null }));
    closeDrawer(); currentView = 'library'; syncTabs(); render(); toast('Saved to Library.'); return;
  }
  if (action === 'schedule') {
    if (!d.whenRaw) return toast('Pick a date & time to schedule.', 'error');
    const when = new Date(d.whenRaw);
    if (when.getTime() <= Date.now() && d.recurrence === 'none') return toast('That time is in the past — pick a future time or set Repeat.', 'error');
    let scheduledAt = when.toISOString();
    if (when.getTime() <= Date.now()) scheduledAt = nextOccurrence(scheduledAt, d.recurrence);
    await persist(Object.assign(base, { status: 'scheduled', scheduledAt }));
    // Land on the calendar, on the week the routine was scheduled into, so it's visibly there.
    closeDrawer(); calRef = new Date(scheduledAt); currentView = 'calendar'; syncTabs(); render(); toast(`Scheduled — fires ${relative(scheduledAt)}. Added to the calendar.`); return;
  }
  if (action === 'now') {
    const r = await persist(Object.assign(base, { status: 'scheduled', scheduledAt: new Date().toISOString() }));
    closeDrawer(); calRef = new Date(); currentView = 'calendar'; syncTabs(); render();
    if (r) await fireTrigger(r);
  }
}
function closeDrawer() { overlay.classList.remove('is-open'); editingId = null; }

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
  $$('.cfg-tlabel').forEach((el) => { const t = (cfgModel[+el.dataset.ai] || {}).triggers?.[+el.dataset.ti]; if (t) t.label = el.value.trim(); });
  $$('.cfg-turl').forEach((el) => { const t = (cfgModel[+el.dataset.ai] || {}).triggers?.[+el.dataset.ti]; if (t) t.trigger = el.value.trim(); });
  $$('.cfg-ttoken').forEach((el) => { const t = (cfgModel[+el.dataset.ai] || {}).triggers?.[+el.dataset.ti]; if (t) { const v = el.value.trim(); if (v) t.token = v; } });
}
function renderCfgAccounts() {
  const host = $('#cfg-accounts'); if (!host) return;
  host.innerHTML = cfgModel.map((a, ai) => `
    <div class="acct-cfg">
      <div class="acct-cfg__head">
        <span class="acct-dot" style="background:${cfgColor(ai, -1)}"></span>
        <input class="input cfg-aname" data-ai="${ai}" value="${esc(a.label)}" placeholder="Account name" />
        <button class="iconbtn" title="Remove account" data-act="del-acct" data-ai="${ai}">🗑</button>
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
          <div class="trig-test"><button class="btn btn--ghost btn--sm" data-act="test-trig" data-ai="${ai}" data-ti="${ti}">▶ Save &amp; test fire</button><span class="trig-status" data-ai="${ai}" data-ti="${ti}"></span></div>
        </div>`).join('')}</div>
      <button class="btn btn--ghost btn--sm" data-act="add-trig" data-ai="${ai}">＋ Add trigger</button>
    </div>`).join('') + `<button class="btn btn--secondary btn--sm cfg-addacct" data-act="add-acct">＋ Add account</button>`;

  host.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    syncCfgFromDom();
    const ai = +b.dataset.ai, ti = +b.dataset.ti, act = b.dataset.act;
    if (act === 'test-trig') return testTrigger(ai, ti); // no re-render — keep typed values + show status
    if (act === 'add-acct') cfgModel.push({ id: genId('acc'), label: 'New account', triggers: [{ id: genId('t'), label: 'A', trigger: '', token: '' }] });
    else if (act === 'del-acct') cfgModel.splice(ai, 1);
    else if (act === 'add-trig') cfgModel[ai].triggers.push({ id: genId('t'), label: nextTrigLabel(cfgModel[ai]), trigger: '', token: '' });
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
async function openSettings() {
  editingId = null;
  drawerTitle.textContent = 'Settings';
  drawerBody.innerHTML = `<div class="notice">Loading your settings…</div>`;
  drawerFoot.innerHTML = '';
  overlay.classList.add('is-open');

  cfgModel = normalizeAccounts(await dbLoadAccountCreds(), true);

  drawerBody.innerHTML = `
    <div class="notice">Add a Claude <b>account</b>, then give it one or more <b>triggers</b> — each is a Fire URL (or <code>trig_…</code>) + token. Routines pick which trigger fires them. Saved to your account and used server-side; no Netlify setup needed.</div>
    <div class="field__row">
      <div class="field"><label class="label" for="s-account">Default account</label>
        <select class="select" id="s-account">${cfgModel.map((a) => `<option value="${a.id}" ${(settings.account || DEFAULT_ACCOUNT) === a.id ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}</select></div>
      <div class="field"><label class="label" for="s-model">Default model</label>
        <select class="select" id="s-model">${MODELS.map((m) => `<option value="${m.id}" ${settings.model === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}</select></div>
    </div>
    <div class="cfg-sep">Accounts &amp; triggers</div>
    <div id="cfg-accounts"></div>
    <details class="cfg-adv"><summary>Advanced (optional)</summary>
      <div class="field"><label class="label" for="s-trigger">Trigger URL override</label>
        <input class="input" id="s-trigger" placeholder="leave blank to use the built-in function" value="${esc(settings.triggerUrl)}" />
        <span class="hint">Leave blank to use <code>/.netlify/functions/claude-trigger</code>. Set a URL only to POST a different webhook directly (bypasses the accounts above).</span></div>
      <div class="field"><label class="label" for="s-key">Anthropic API key (“Test live” only)</label>
        <input class="input" id="s-key" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(settings.apiKey)}" />
        <span class="hint">Stored only in this browser; used only by the in-drawer Test button.</span></div>
    </details>`;
  drawerFoot.innerHTML = `<button class="btn btn--primary" id="s-save">Save settings</button>`;
  renderCfgAccounts();

  $('#s-save').addEventListener('click', async () => {
    syncCfgFromDom();
    const btn = $('#s-save'); btn.disabled = true; btn.textContent = 'Saving…';
    const ok = await dbSaveAccountCreds(cfgModel);
    accountsCfg = normalizeAccounts(cfgModel, false);
    settings.account = $('#s-account').value;
    if (!getAccountCfg(settings.account)) settings.account = (accountsCfg[0] || {}).id || DEFAULT_ACCOUNT;
    settings.model = $('#s-model').value; settings.triggerUrl = $('#s-trigger').value.trim(); settings.apiKey = $('#s-key').value.trim();
    saveSettings();
    btn.disabled = false; btn.textContent = 'Save settings';
    if (ok) { closeDrawer(); render(); toast('Settings saved.'); }
  });
}

/* ---------- Tabs ---------- */
function syncTabs() { $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === currentView)); }

/* ---------- Auth UI ---------- */
function showAuth(mode = 'signin') {
  ['#tabs'].forEach((s) => { const e = $(s); if (e) e.style.display = 'none'; });
  ['#settingsBtn', '#signOutBtn', '#newBtn', '#userChip'].forEach((s) => { const e = $(s); if (e) e.style.display = 'none'; });
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
  $('#tabs').style.display = '';
  ['#settingsBtn', '#signOutBtn', '#newBtn'].forEach((s) => { const e = $(s); if (e) e.style.display = ''; });
  const chip = $('#userChip');
  if (chip) { chip.style.display = ''; chip.innerHTML = `☁ <b>${esc(session.user.email)}</b>`; }
  syncTabs();
  loadAll();
}

/* ---------- Init ---------- */
function wireOnce() {
  $('#newBtn').addEventListener('click', () => openDrawer());
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#signOutBtn').addEventListener('click', async () => { await sb.auth.signOut(); });
  $('#drawerClose').addEventListener('click', closeDrawer);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDrawer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  $$('.tab').forEach((t) => t.addEventListener('click', () => { currentView = t.dataset.view; syncTabs(); render(); }));
  setInterval(paintStatus, 30000);
}

async function init() {
  wireOnce();
  const { data } = await sb.auth.getSession();
  session = data.session;
  session ? showApp() : showAuth('signin');
  sb.auth.onAuthStateChange((_event, s) => {
    const was = !!session; session = s;
    if (s && !was) { showApp(); toast('Signed in.'); }
    else if (!s && was) { routines = []; runs = []; notes = []; showAuth('signin'); }
    else if (s && was) { /* token refresh — ignore */ }
  });
}

init();
