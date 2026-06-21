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

/* settings (model / optional trigger override / test key) stay local */
const LS = 'routiner.settings.v1';
let settings = loadSettings();
function loadSettings() {
  try { return Object.assign({ model: DEFAULT_MODEL, triggerUrl: '', apiKey: '' }, JSON.parse(localStorage.getItem(LS) || '{}')); }
  catch { return { model: DEFAULT_MODEL, triggerUrl: '', apiKey: '' }; }
}
function saveSettings() { localStorage.setItem(LS, JSON.stringify(settings)); }

let routines = [];
let runs = [];
let currentView = 'scheduled';
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
  id: r.id, title: r.title, prompt: r.prompt, model: r.model, recurrence: r.recurrence,
  status: r.status, scheduledAt: r.scheduled_at, lastRun: r.last_run,
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const toRow = (o) => ({
  title: o.title ?? '', prompt: o.prompt ?? '', model: o.model || DEFAULT_MODEL,
  recurrence: o.recurrence || 'none', status: o.status || 'library',
  scheduled_at: o.scheduledAt || null, last_run: o.lastRun || null,
});

/* ---------- Data layer ---------- */
async function loadAll() {
  const [rRes, runRes] = await Promise.all([
    sb.from('routiner_routines').select('*').order('updated_at', { ascending: false }),
    sb.from('routiner_runs').select('*').order('fired_at', { ascending: false }).limit(200),
  ]);
  if (rRes.error) { toast('Load failed: ' + rRes.error.message, 'error'); return; }
  routines = (rRes.data || []).map(fromRow);
  runs = (runRes.data || []).map((x) => ({ id: x.id, routineId: x.routine_id, title: x.title, status: x.status, output: x.output, firedAt: x.fired_at }));
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
  const payload = JSON.stringify({ text: routine?.prompt || '', source: 'claude-routine-planner', routineId: routine?.id, title: routine?.title, at: new Date().toISOString() });
  // Send the signed-in user's access token so the gated function authorizes us.
  const headers = { 'content-type': 'application/json' };
  const { data: { session: s } } = await sb.auth.getSession();
  if (s?.access_token && !direct) headers.Authorization = `Bearer ${s.access_token}`;
  try {
    const r = await fetch(url, { method: 'POST', headers, body: payload });
    if (!r.ok) { const m = (await r.text().catch(() => '')).slice(0, 180); toast(`Trigger responded ${r.status}. ${m}`, 'error'); return; }
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
  const c = { scheduled: 0, library: 0, archived: 0, history: runs.length };
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
  return `<article class="card" data-id="${r.id}">
    <div class="card__head"><span class="card__title">${esc(r.title) || '<em>Untitled routine</em>'}</span>${statusChip(r)}</div>
    <div class="card__prompt">${esc(r.prompt) || '(no prompt)'}</div>
    <div class="card__meta">${recur}<span class="card__meta-item">⚡ <b>${esc(modelName)}</b></span>${when}</div>
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

/* ---------- Drawer (create / edit) ---------- */
let editingId = null;
function openDrawer(routine = null, opts = {}) {
  editingId = routine ? routine.id : null;
  drawerTitle.textContent = routine ? 'Edit routine' : 'New routine';
  const r = routine || { title: '', prompt: '', model: settings.model, recurrence: 'none', scheduledAt: null };
  const whenVal = r.scheduledAt ? toLocalInput(new Date(r.scheduledAt)) : defaultWhen();
  drawerBody.innerHTML = `
    <div class="field"><label class="label" for="f-title">Title</label>
      <input class="input" id="f-title" placeholder="e.g. Morning competitor scan" value="${esc(r.title)}" /></div>
    <div class="field"><label class="label" for="f-prompt">Directions for Claude</label>
      <textarea class="textarea" id="f-prompt" placeholder="Describe the task. It runs in your Claude Code routine session with full tools.">${esc(r.prompt)}</textarea>
      <span class="hint">Sent to your routine as a session turn. Use {{date}} / {{datetime}} for the run time.</span></div>
    <div class="field"><label class="label" for="f-model">Model hint</label>
      <select class="select" id="f-model">${MODELS.map((m) => `<option value="${m.id}" ${(r.model || settings.model) === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}</select></div>
    <div class="field__row">
      <div class="field"><label class="label" for="f-when">Fire at</label>
        <input class="input" type="datetime-local" id="f-when" value="${whenVal}" /></div>
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
  return { title: $('#f-title').value.trim(), prompt: $('#f-prompt').value, model: $('#f-model').value, recurrence: $('#f-recur').value, whenRaw: $('#f-when').value };
}
async function persist(base) { return editingId ? dbUpdate(editingId, Object.assign(getRoutine(editingId) || {}, base)) : dbCreate(base); }

async function submitDrawer(action) {
  const d = readDrawer();
  if (!d.prompt.trim()) { toast('Add directions first.', 'error'); $('#f-prompt').focus(); return; }
  const base = { title: d.title, prompt: d.prompt, model: d.model, recurrence: d.recurrence };

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
    closeDrawer(); currentView = 'scheduled'; syncTabs(); render(); toast(`Scheduled — fires ${relative(scheduledAt)}.`); return;
  }
  if (action === 'now') {
    const r = await persist(Object.assign(base, { status: 'scheduled', scheduledAt: new Date().toISOString() }));
    closeDrawer(); currentView = 'scheduled'; syncTabs(); render();
    if (r) await fireTrigger(r);
  }
}
function closeDrawer() { overlay.classList.remove('is-open'); editingId = null; }

/* ---------- Settings ---------- */
function openSettings() {
  editingId = null;
  drawerTitle.textContent = 'Settings';
  drawerBody.innerHTML = `
    <div class="notice">Your routines are saved to your account and sync across devices. <b>Run now</b> fires your Claude routine via the Netlify <code>CLAUDE_TRIGGER</code> function.</div>
    <div class="field"><label class="label" for="s-model">Default model</label>
      <select class="select" id="s-model">${MODELS.map((m) => `<option value="${m.id}" ${settings.model === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}</select></div>
    <div class="field"><label class="label" for="s-trigger">Trigger URL override (optional)</label>
      <input class="input" id="s-trigger" placeholder="leave blank to use the Netlify CLAUDE_TRIGGER function" value="${esc(settings.triggerUrl)}" />
      <span class="hint">Leave blank to use <code>/.netlify/functions/claude-trigger</code>. Set a URL only to POST a different webhook directly.</span></div>
    <div class="field"><label class="label" for="s-key">Anthropic API key (optional — “Test live” only)</label>
      <input class="input" id="s-key" type="password" placeholder="sk-ant-…" value="${esc(settings.apiKey)}" />
      <span class="hint">Stored only in this browser; used only by the in-drawer Test button.</span></div>`;
  drawerFoot.innerHTML = `<button class="btn btn--primary" id="s-save">Save settings</button>`;
  $('#s-save').addEventListener('click', () => {
    settings.model = $('#s-model').value; settings.triggerUrl = $('#s-trigger').value.trim(); settings.apiKey = $('#s-key').value.trim();
    saveSettings(); closeDrawer(); render(); toast('Settings saved.');
  });
  overlay.classList.add('is-open');
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
    else if (!s && was) { routines = []; runs = []; showAuth('signin'); }
    else if (s && was) { /* token refresh — ignore */ }
  });
}

init();
