/* ============================================================
   Claude Routine Planner — app logic
   A Notion-to-Claude style command center.
   Prompts can: fire now · schedule (one-off or recurring) ·
   sit in the Library · be archived. State persists locally;
   scheduled routines fire via the Anthropic Messages API
   while this tab is open.
   ============================================================ */

(() => {
  'use strict';

  const STORE_KEY = 'routiner.v1';
  const API_URL = 'https://api.anthropic.com/v1/messages';
  const ANTHROPIC_VERSION = '2023-06-01';

  const MODELS = [
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 — most capable' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 — balanced' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 — fast & cheap' },
  ];
  const DEFAULT_MODEL = 'claude-sonnet-4-6';

  const RECURRENCE = {
    none: 'One-time',
    daily: 'Every day',
    weekdays: 'Weekdays (Mon–Fri)',
    weekly: 'Every week',
  };

  /* ---------- State ---------- */
  const defaultState = () => ({
    routines: [],
    runs: [],
    settings: { apiKey: '', model: DEFAULT_MODEL },
  });

  let state = load();
  let currentView = 'scheduled';

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultState();
      return Object.assign(defaultState(), JSON.parse(raw));
    } catch {
      return defaultState();
    }
  }
  function save() {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /* ---------- DOM helpers ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const view = $('#view');
  const overlay = $('#overlay');
  const drawerBody = $('#drawerBody');
  const drawerFoot = $('#drawerFoot');
  const drawerTitle = $('#drawerTitle');

  /* ---------- Time helpers ---------- */
  function fmt(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString([], {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }
  function relative(iso) {
    if (!iso) return '';
    const diff = new Date(iso).getTime() - Date.now();
    const abs = Math.abs(diff);
    const mins = Math.round(abs / 60000);
    const hrs = Math.round(abs / 3600000);
    const days = Math.round(abs / 86400000);
    let str;
    if (mins < 1) str = 'moments';
    else if (mins < 60) str = `${mins}m`;
    else if (hrs < 24) str = `${hrs}h`;
    else str = `${days}d`;
    return diff >= 0 ? `in ${str}` : `${str} ago`;
  }
  // Date -> value for <input type="datetime-local">
  function toLocalInput(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function defaultWhen() {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    d.setMinutes(0, 0, 0);
    return toLocalInput(d);
  }
  // Advance an ISO timestamp to the next occurrence strictly in the future.
  function nextOccurrence(iso, recurrence) {
    if (recurrence === 'none') return null;
    let d = new Date(iso);
    const now = Date.now();
    const step = () => {
      if (recurrence === 'weekly') d.setDate(d.getDate() + 7);
      else d.setDate(d.getDate() + 1); // daily & weekdays advance a day at a time
    };
    do {
      step();
      if (recurrence === 'weekdays') {
        while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
      }
    } while (d.getTime() <= now);
    return d.toISOString();
  }

  /* ---------- Toasts ---------- */
  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ` toast--${kind}` : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3200);
    setTimeout(() => el.remove(), 3600);
  }

  /* ---------- CRUD ---------- */
  function getRoutine(id) { return state.routines.find((r) => r.id === id); }

  function upsertRoutine(data) {
    const now = new Date().toISOString();
    if (data.id && getRoutine(data.id)) {
      Object.assign(getRoutine(data.id), data, { updatedAt: now });
    } else {
      state.routines.push(Object.assign({
        id: uid(), createdAt: now, updatedAt: now, lastRun: null,
      }, data));
    }
    save();
  }
  function deleteRoutine(id) {
    state.routines = state.routines.filter((r) => r.id !== id);
    save(); render();
  }
  function setStatus(id, status, extra = {}) {
    const r = getRoutine(id);
    if (!r) return;
    Object.assign(r, { status, updatedAt: new Date().toISOString() }, extra);
    save(); render();
  }

  /* ---------- The Anthropic call ---------- */
  async function callClaude(prompt, model) {
    const key = state.settings.apiKey.trim();
    if (!key) {
      return { status: 'dryrun', text: 'No API key set — this was a dry run. Add your Anthropic API key in Settings to fire prompts for real.' };
    }
    try {
      const resp = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: model || state.settings.model || DEFAULT_MODEL,
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        return { status: 'error', text: data?.error?.message || `HTTP ${resp.status}` };
      }
      const text = (data.content || []).map((b) => b.text || '').join('\n').trim();
      return { status: 'success', text: text || '(empty response)' };
    } catch (err) {
      return { status: 'error', text: 'Request failed: ' + err.message + '. (Browser/network/CORS or invalid key.)' };
    }
  }

  function recordRun(routine, result) {
    state.runs.unshift({
      id: uid(),
      routineId: routine.id,
      title: routine.title || 'Untitled',
      prompt: routine.prompt,
      model: routine.model || state.settings.model,
      firedAt: new Date().toISOString(),
      status: result.status,
      output: result.text,
    });
    state.runs = state.runs.slice(0, 200);
    save();
  }

  // Fire a routine immediately (manual or scheduled).
  async function fire(routine, { auto = false } = {}) {
    if (!auto) toast(`Firing “${routine.title || 'routine'}” …`, 'info');
    const result = await callClaude(routine.prompt, routine.model);
    recordRun(routine, result);
    routine.lastRun = new Date().toISOString();

    // Re-schedule recurring, retire one-off schedules to the Library.
    if (routine.status === 'scheduled') {
      const next = nextOccurrence(routine.scheduledAt, routine.recurrence);
      if (next) {
        routine.scheduledAt = next;
      } else {
        routine.status = 'library';
        routine.scheduledAt = null;
      }
    }
    save(); render();

    const label = { success: 'completed', error: 'errored', dryrun: 'dry-ran' }[result.status];
    toast(`“${routine.title || 'routine'}” ${label}. See History.`, result.status === 'error' ? 'error' : '');
    return result;
  }

  /* ---------- Scheduler ---------- */
  function tick() {
    const now = Date.now();
    const due = state.routines.filter(
      (r) => r.status === 'scheduled' && r.scheduledAt && new Date(r.scheduledAt).getTime() <= now
    );
    due.forEach((r) => fire(r, { auto: true }));
    paintClock();
  }
  function paintClock() {
    const next = state.routines
      .filter((r) => r.status === 'scheduled' && r.scheduledAt)
      .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))[0];
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('#clock').innerHTML = next
      ? `${t} · next fire <b>${relative(next.scheduledAt)}</b>`
      : `${t} · <b>no routines queued</b>`;
  }

  /* ---------- Rendering ---------- */
  function counts() {
    const c = { scheduled: 0, library: 0, archived: 0, history: state.runs.length };
    state.routines.forEach((r) => { c[r.status] = (c[r.status] || 0) + 1; });
    return c;
  }
  function paintCounts() {
    const c = counts();
    $$('[data-count]').forEach((el) => { el.textContent = c[el.dataset.count] ?? 0; });
  }

  function render() {
    paintCounts();
    paintClock();
    if (currentView === 'history') return renderHistory();
    const items = state.routines
      .filter((r) => r.status === currentView)
      .sort((a, b) => {
        if (currentView === 'scheduled') return new Date(a.scheduledAt || 0) - new Date(b.scheduledAt || 0);
        return new Date(b.updatedAt) - new Date(a.updatedAt);
      });
    if (!items.length) return renderEmpty();
    view.innerHTML = `<div class="grid">${items.map(card).join('')}</div>`;
    bindCards();
  }

  function renderEmpty() {
    const copy = {
      scheduled: ['No routines queued', 'Create a routine and give it a time to see it line up here, ready to fire on its own.'],
      library: ['Your library is empty', 'Save prompts here to iterate on them and re-use or schedule them whenever you like.'],
      archived: ['Nothing archived', 'Archived routines are tucked away here. Restore them to the library anytime.'],
    }[currentView];
    view.innerHTML = `<div class="grid"><div class="empty">
      <h3>${copy[0]}</h3><p>${copy[1]}</p>
      <button class="btn btn--primary" data-act="new">＋ New routine</button>
    </div></div>`;
    $('[data-act="new"]', view)?.addEventListener('click', () => openDrawer());
  }

  function statusChip(r) {
    if (r.status === 'scheduled') {
      const due = r.scheduledAt && new Date(r.scheduledAt).getTime() <= Date.now();
      return due ? `<span class="chip chip--due">firing…</span>`
        : `<span class="chip chip--scheduled">scheduled</span>`;
    }
    return `<span class="chip chip--${r.status}">${r.status}</span>`;
  }

  function card(r) {
    const recur = r.recurrence && r.recurrence !== 'none'
      ? `<span class="chip chip--recurring">${esc(RECURRENCE[r.recurrence])}</span>` : '';
    const when = r.status === 'scheduled'
      ? `<span class="card__meta-item">⏰ <b>${fmt(r.scheduledAt)}</b> · ${relative(r.scheduledAt)}</span>`
      : (r.lastRun ? `<span class="card__meta-item">last run <b>${fmt(r.lastRun)}</b></span>` : '');
    const modelName = (MODELS.find((m) => m.id === (r.model || state.settings.model)) || {}).label?.split(' — ')[0] || r.model;

    return `<article class="card" data-id="${r.id}">
      <div class="card__head">
        <span class="card__title">${esc(r.title) || '<em>Untitled routine</em>'}</span>
        ${statusChip(r)}
      </div>
      <div class="card__prompt">${esc(r.prompt) || '(no prompt)'}</div>
      <div class="card__meta">
        ${recur}
        <span class="card__meta-item">⚡ <b>${esc(modelName)}</b></span>
        ${when}
      </div>
      <div class="card__foot">${cardActions(r)}</div>
    </article>`;
  }

  function cardActions(r) {
    const fireBtn = `<button class="btn btn--accent btn--sm" data-act="fire">▶ Fire now</button>`;
    const edit = `<button class="btn btn--secondary btn--sm" data-act="edit">Edit</button>`;
    const del = `<button class="btn btn--danger-ghost btn--sm" data-act="delete">Delete</button>`;
    if (r.status === 'archived') {
      return `<button class="btn btn--secondary btn--sm" data-act="library">↩ Restore</button>${del}`;
    }
    const lib = r.status === 'library'
      ? `<button class="btn btn--primary btn--sm" data-act="schedule">⏰ Schedule</button>`
      : `<button class="btn btn--secondary btn--sm" data-act="library">▣ To library</button>`;
    const dup = `<button class="btn btn--ghost btn--sm" data-act="duplicate">⧉ Copy</button>`;
    const arch = `<button class="btn btn--ghost btn--sm" data-act="archive">Archive</button>`;
    return `${fireBtn}${lib}${edit}${dup}${arch}${del}`;
  }

  function bindCards() {
    $$('.card', view).forEach((el) => {
      const id = el.dataset.id;
      el.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const r = getRoutine(id);
        if (!r) return;
        switch (btn.dataset.act) {
          case 'fire': fire(r); break;
          case 'edit': openDrawer(r); break;
          case 'schedule': openDrawer(r, { forceSchedule: true }); break;
          case 'library': setStatus(id, 'library', { scheduledAt: null }); toast('Moved to Library.'); break;
          case 'archive': setStatus(id, 'archived', { scheduledAt: null }); toast('Archived.'); break;
          case 'duplicate': {
            const copy = Object.assign({}, r);
            delete copy.id; delete copy.createdAt; delete copy.lastRun;
            copy.title = (r.title || 'Untitled') + ' (copy)';
            copy.status = 'library'; copy.scheduledAt = null;
            upsertRoutine(copy); render(); toast('Duplicated to Library.');
            break;
          }
          case 'delete':
            if (confirm('Delete this routine permanently?')) { deleteRoutine(id); toast('Deleted.'); }
            break;
        }
      });
    });
  }

  function renderHistory() {
    if (!state.runs.length) {
      view.innerHTML = `<div class="empty">
        <h3>No runs yet</h3><p>Every time a routine fires — manually or on schedule — the result lands here.</p>
      </div>`;
      return;
    }
    view.innerHTML = `<div class="section-head">
        <h2>Run history</h2>
        <button class="btn btn--ghost btn--sm" id="clearHistory">Clear history</button>
      </div>
      <div class="history">${state.runs.map(runRow).join('')}</div>`;
    $('#clearHistory').addEventListener('click', () => {
      if (confirm('Clear all run history?')) { state.runs = []; save(); render(); }
    });
    $$('[data-rerun]', view).forEach((b) =>
      b.addEventListener('click', () => {
        const r = getRoutine(b.dataset.rerun);
        if (r) fire(r); else toast('That routine no longer exists.', 'error');
      }));
  }

  function runRow(run) {
    const stillExists = !!getRoutine(run.routineId);
    return `<div class="run">
      <div class="run__head">
        <span class="chip chip--${run.status}">${run.status}</span>
        <span class="run__title">${esc(run.title)}</span>
        <span class="run__time">${fmt(run.firedAt)}</span>
        ${stillExists ? `<button class="btn btn--ghost btn--sm" data-rerun="${run.routineId}">↻ Run again</button>` : ''}
      </div>
      <div class="run__body">${esc(run.output)}</div>
    </div>`;
  }

  /* ---------- Drawer (create / edit) ---------- */
  let editingId = null;

  function openDrawer(routine = null, opts = {}) {
    editingId = routine ? routine.id : null;
    drawerTitle.textContent = routine ? 'Edit routine' : 'New routine';
    const r = routine || {
      title: '', prompt: '', model: state.settings.model,
      recurrence: 'none', scheduledAt: null,
    };
    const whenVal = r.scheduledAt ? toLocalInput(new Date(r.scheduledAt)) : defaultWhen();

    drawerBody.innerHTML = `
      <div class="field">
        <label class="label" for="f-title">Title</label>
        <input class="input" id="f-title" placeholder="e.g. Morning competitor scan" value="${esc(r.title)}" />
      </div>
      <div class="field">
        <label class="label" for="f-prompt">Prompt</label>
        <textarea class="textarea" id="f-prompt" placeholder="Write the prompt you want to send to Claude…">${esc(r.prompt)}</textarea>
        <span class="hint">This is sent as the user message to the Claude Messages API.</span>
      </div>
      <div class="field">
        <label class="label" for="f-model">Model</label>
        <select class="select" id="f-model">
          ${MODELS.map((m) => `<option value="${m.id}" ${ (r.model || state.settings.model) === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
        </select>
      </div>
      <div class="field__row">
        <div class="field">
          <label class="label" for="f-when">Fire at</label>
          <input class="input" type="datetime-local" id="f-when" value="${whenVal}" />
        </div>
        <div class="field">
          <label class="label" for="f-recur">Repeat</label>
          <select class="select" id="f-recur">
            ${Object.entries(RECURRENCE).map(([k, v]) => `<option value="${k}" ${r.recurrence === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="notice">
        Pick what to do with this prompt below: <b>Fire now</b> sends it immediately,
        <b>Schedule</b> queues it for the time above (and repeats it if set),
        and <b>Save to library</b> just parks it for later.
      </div>`;

    drawerFoot.innerHTML = `
      <button class="btn btn--accent" data-do="now">▶ Fire now</button>
      <button class="btn btn--brand" data-do="schedule">⏰ Schedule</button>
      <button class="btn btn--secondary" data-do="library">▣ Save to library</button>`;

    if (opts.forceSchedule) $('#f-when', drawerBody)?.focus();

    drawerFoot.querySelectorAll('[data-do]').forEach((b) =>
      b.addEventListener('click', () => submitDrawer(b.dataset.do)));

    overlay.classList.add('is-open');
    setTimeout(() => $('#f-title', drawerBody)?.focus(), 50);
  }

  function readDrawer() {
    return {
      id: editingId || undefined,
      title: $('#f-title').value.trim(),
      prompt: $('#f-prompt').value,
      model: $('#f-model').value,
      recurrence: $('#f-recur').value,
      whenRaw: $('#f-when').value,
    };
  }

  async function submitDrawer(action) {
    const d = readDrawer();
    if (!d.prompt.trim()) { toast('Add a prompt first.', 'error'); $('#f-prompt').focus(); return; }

    const base = {
      id: d.id, title: d.title, prompt: d.prompt,
      model: d.model, recurrence: d.recurrence,
    };

    if (action === 'library') {
      upsertRoutine(Object.assign(base, { status: 'library', scheduledAt: null }));
      closeDrawer(); currentView = 'library'; syncTabs(); render();
      toast('Saved to Library.');
      return;
    }

    if (action === 'schedule') {
      if (!d.whenRaw) { toast('Pick a date & time to schedule.', 'error'); return; }
      const when = new Date(d.whenRaw);
      if (when.getTime() <= Date.now() && d.recurrence === 'none') {
        toast('That time is in the past — pick a future time or set Repeat.', 'error'); return;
      }
      let scheduledAt = when.toISOString();
      if (when.getTime() <= Date.now()) scheduledAt = nextOccurrence(scheduledAt, d.recurrence);
      upsertRoutine(Object.assign(base, { status: 'scheduled', scheduledAt }));
      closeDrawer(); currentView = 'scheduled'; syncTabs(); render();
      toast(`Scheduled — fires ${relative(scheduledAt)}.`);
      return;
    }

    if (action === 'now') {
      // Persist (as library unless it was already scheduled) then fire.
      const existing = d.id ? getRoutine(d.id) : null;
      const status = existing && existing.status === 'scheduled' ? 'scheduled' : 'library';
      const scheduledAt = status === 'scheduled' ? existing.scheduledAt : null;
      upsertRoutine(Object.assign(base, { status, scheduledAt }));
      const saved = d.id ? getRoutine(d.id) : state.routines[state.routines.length - 1];
      closeDrawer();
      currentView = 'history'; syncTabs(); render();
      await fire(saved);
    }
  }

  function closeDrawer() { overlay.classList.remove('is-open'); editingId = null; }

  /* ---------- Settings drawer ---------- */
  function openSettings() {
    editingId = null;
    drawerTitle.textContent = 'Settings';
    drawerBody.innerHTML = `
      <div class="field">
        <label class="label" for="s-key">Anthropic API key</label>
        <input class="input" id="s-key" type="password" placeholder="sk-ant-…" value="${esc(state.settings.apiKey)}" />
        <span class="hint hint--warn">Stored only in this browser (localStorage). Never sent anywhere except directly to api.anthropic.com when a routine fires.</span>
      </div>
      <div class="field">
        <label class="label" for="s-model">Default model</label>
        <select class="select" id="s-model">
          ${MODELS.map((m) => `<option value="${m.id}" ${state.settings.model === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
        </select>
      </div>
      <div class="notice">
        Routines fire automatically only while this tab is open — it's a client-side
        scheduler. Keep the Planner open in a pinned tab for hands-off routines, or
        fire them manually anytime.
      </div>`;
    drawerFoot.innerHTML = `<button class="btn btn--primary" id="s-save">Save settings</button>`;
    $('#s-save').addEventListener('click', () => {
      state.settings.apiKey = $('#s-key').value.trim();
      state.settings.model = $('#s-model').value;
      save(); closeDrawer(); render();
      toast('Settings saved.');
    });
    overlay.classList.add('is-open');
  }

  /* ---------- Tabs ---------- */
  function syncTabs() {
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === currentView));
  }

  /* ---------- Wire up ---------- */
  function init() {
    $('#newBtn').addEventListener('click', () => openDrawer());
    $('#settingsBtn').addEventListener('click', openSettings);
    $('#drawerClose').addEventListener('click', closeDrawer);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDrawer(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

    $$('.tab').forEach((t) =>
      t.addEventListener('click', () => { currentView = t.dataset.view; syncTabs(); render(); }));

    // Seed a friendly example on first ever load.
    if (!state.routines.length && !state.runs.length && !localStorage.getItem(STORE_KEY)) {
      upsertRoutine({
        title: 'Daily marketing standup',
        prompt: 'You are my marketing chief of staff. Summarize what I should focus on today across content, ads, and outreach. Keep it to 5 punchy bullets.',
        model: DEFAULT_MODEL, recurrence: 'weekdays', status: 'library', scheduledAt: null,
      });
    }

    syncTabs();
    render();
    tick();
    setInterval(tick, 20000); // scheduler heartbeat
    setInterval(paintClock, 30000);
  }

  init();
})();
