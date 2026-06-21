/* ============================================================
   Claude Routine Planner — app logic
   A Notion-to-Claude command center.

   Model: write a prompt → it becomes a routine "note" committed
   to this repo (routines/<status>/<id>.md) via the GitHub API.
   A scheduled or webhook-triggered Claude Code session reads the
   due notes and carries out the directions (see routines/README.md).

   - "Run now"  → commit (schedule = now) + POST the trigger webhook
   - "Schedule" → commit to routines/scheduled/ with a time + repeat
   - "Save"     → commit to routines/library/ (parked, not executed)
   - "Test live"→ optional instant preview via the Messages API

   State persists in localStorage; the repo is the source of truth
   for execution.
   ============================================================ */

(() => {
  'use strict';

  const STORE_KEY = 'routiner.v2';
  const API_URL = 'https://api.anthropic.com/v1/messages';
  const ANTHROPIC_VERSION = '2023-06-01';
  const GH_API = 'https://api.github.com';

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
    settings: {
      apiKey: '',
      model: DEFAULT_MODEL,
      github: { token: '', owner: 'ZPARXMarketing', repo: 'ROUTINER', branch: 'main' },
      triggerUrl: '',
    },
  });

  let state = load();
  let currentView = 'scheduled';

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const s = Object.assign(defaultState(), parsed);
      s.settings = Object.assign(defaultState().settings, parsed.settings || {});
      s.settings.github = Object.assign(defaultState().settings.github, (parsed.settings || {}).github || {});
      return s;
    } catch {
      return defaultState();
    }
  }
  function save() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
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
    return new Date(iso).toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }
  function relative(iso) {
    if (!iso) return '';
    const diff = new Date(iso).getTime() - Date.now();
    const abs = Math.abs(diff);
    const mins = Math.round(abs / 60000), hrs = Math.round(abs / 3600000), days = Math.round(abs / 86400000);
    let str;
    if (mins < 1) str = 'moments';
    else if (mins < 60) str = `${mins}m`;
    else if (hrs < 24) str = `${hrs}h`;
    else str = `${days}d`;
    return diff >= 0 ? `in ${str}` : `${str} ago`;
  }
  function toLocalInput(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function defaultWhen() {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    d.setMinutes(0, 0, 0);
    return toLocalInput(d);
  }
  function nextOccurrence(iso, recurrence) {
    if (!iso || recurrence === 'none') return null;
    let d = new Date(iso);
    const now = Date.now();
    do {
      d.setDate(d.getDate() + (recurrence === 'weekly' ? 7 : 1));
      if (recurrence === 'weekdays') while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    } while (d.getTime() <= now);
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

  /* ---------- Routine markdown <-> object ---------- */
  function yamlVal(s) {
    s = String(s ?? '');
    return /[:#"'\n]/.test(s) ? JSON.stringify(s) : (s === '' ? '""' : s);
  }
  function toMarkdown(r) {
    return [
      '---',
      `id: ${r.id}`,
      `title: ${yamlVal(r.title)}`,
      `status: ${r.status}`,
      `schedule: ${r.scheduledAt || 'null'}`,
      `repeat: ${r.recurrence || 'none'}`,
      `model: ${r.model || state.settings.model}`,
      `created: ${r.createdAt}`,
      `updated: ${r.updatedAt}`,
      `lastRun: ${r.lastRun || 'null'}`,
      '---',
      '',
      r.prompt || '',
      '',
    ].join('\n');
  }

  /* ---------- GitHub API ---------- */
  function ghCfg() { return state.settings.github; }
  function ghReady() { const g = ghCfg(); return !!(g.token && g.owner && g.repo && g.branch); }
  function ghHeaders() {
    return {
      Authorization: `Bearer ${ghCfg().token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }
  const b64 = (str) => btoa(unescape(encodeURIComponent(str)));

  async function ghGet(path) {
    const g = ghCfg();
    const r = await fetch(`${GH_API}/repos/${g.owner}/${g.repo}/contents/${path}?ref=${encodeURIComponent(g.branch)}`,
      { headers: ghHeaders() });
    if (r.status === 404) return { exists: false };
    if (!r.ok) throw new Error(`GitHub GET ${r.status}`);
    const d = await r.json();
    return { exists: true, sha: d.sha };
  }
  async function ghPut(path, content, message, sha) {
    const g = ghCfg();
    const body = { message, content: b64(content), branch: g.branch };
    if (sha) body.sha = sha;
    const r = await fetch(`${GH_API}/repos/${g.owner}/${g.repo}/contents/${path}`,
      { method: 'PUT', headers: { ...ghHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `GitHub PUT ${r.status}`);
  }
  async function ghDelete(path, sha, message) {
    const g = ghCfg();
    const r = await fetch(`${GH_API}/repos/${g.owner}/${g.repo}/contents/${path}`,
      { method: 'DELETE', headers: { ...ghHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ message, sha, branch: g.branch }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `GitHub DELETE ${r.status}`);
  }

  const folderFor = (r) => ({ scheduled: 'scheduled', library: 'library', archived: 'archived' }[r.status] || 'library');
  const pathFor = (r) => `routines/${folderFor(r)}/${r.id}.md`;

  // Commit a routine to the repo, moving it between folders if its status changed.
  async function syncToRepo(r) {
    if (!ghReady()) return false;
    const path = pathFor(r);
    const cur = await ghGet(path);
    await ghPut(path, toMarkdown(r), `routine: ${r.title || r.id} (${r.status})`, cur.sha);
    if (r.repoPath && r.repoPath !== path) {
      const old = await ghGet(r.repoPath);
      if (old.exists) await ghDelete(r.repoPath, old.sha, `routine: move ${r.title || r.id}`);
    }
    r.repoPath = path;
    save();
    return true;
  }
  async function removeFromRepo(r) {
    if (!ghReady() || !r.repoPath) return;
    const cur = await ghGet(r.repoPath);
    if (cur.exists) await ghDelete(r.repoPath, cur.sha, `routine: delete ${r.title || r.id}`);
  }

  // Commit + toast, best-effort.
  async function commitRoutine(r, okMsg) {
    if (!ghReady()) {
      toast(`${okMsg} (saved locally — add a GitHub token in Settings to commit it to the repo).`, 'info');
      return false;
    }
    try {
      await syncToRepo(r);
      toast(`${okMsg} · committed to ${ghCfg().owner}/${ghCfg().repo}.`);
      return true;
    } catch (e) {
      toast(`Saved locally, but repo commit failed: ${e.message}`, 'error');
      return false;
    }
  }

  /* ---------- Trigger webhook ---------- */
  // Default: a same-origin Netlify function that reads CLAUDE_TRIGGER
  // server-side. Override with an explicit URL in Settings to POST a
  // webhook directly from the browser instead.
  const TRIGGER_FN = '/.netlify/functions/claude-trigger';

  async function fireTrigger(routine) {
    const direct = state.settings.triggerUrl.trim();
    const url = direct || TRIGGER_FN;
    const payload = JSON.stringify({
      source: 'claude-routine-planner',
      action: 'process-routines',
      routineId: routine?.id,
      routinePath: routine?.repoPath,
      title: routine?.title,
      prompt: 'Process due routines per routines/README.md.',
      at: new Date().toISOString(),
    });
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
      if (!r.ok) {
        const msg = (await r.text().catch(() => '')).slice(0, 180);
        toast(`Committed, but the trigger responded ${r.status}. ${msg}`, 'error');
        return;
      }
      toast('Trigger sent — a Claude session is starting to run it.');
    } catch (e) {
      if (direct) {
        // no-cors fallback for direct external webhooks
        try { await fetch(direct, { method: 'POST', mode: 'no-cors', body: payload }); toast('Trigger sent (no-cors).'); return; } catch { /* fall through */ }
      }
      toast(`Committed, but the trigger failed: ${e.message}. (Deploy on Netlify with CLAUDE_TRIGGER set, or add a direct URL in Settings.)`, 'error');
    }
  }

  /* ---------- CRUD ---------- */
  const getRoutine = (id) => state.routines.find((r) => r.id === id);

  function upsertRoutine(data) {
    const now = new Date().toISOString();
    let r = data.id && getRoutine(data.id);
    if (r) {
      Object.assign(r, data, { updatedAt: now });
    } else {
      r = Object.assign({ id: uid(), createdAt: now, updatedAt: now, lastRun: null, repoPath: null }, data);
      state.routines.push(r);
    }
    save();
    return r;
  }

  /* ---------- The Anthropic call (Test live) ---------- */
  async function callClaude(prompt, model) {
    const key = state.settings.apiKey.trim();
    if (!key) return { status: 'dryrun', text: 'No API key set — add one in Settings to test prompts live. (Live tests are optional; scheduled runs happen in a Claude Code session against the repo.)' };
    try {
      const resp = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model: model || state.settings.model, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = await resp.json();
      if (!resp.ok) return { status: 'error', text: data?.error?.message || `HTTP ${resp.status}` };
      const text = (data.content || []).map((b) => b.text || '').join('\n').trim();
      return { status: 'success', text: text || '(empty response)' };
    } catch (err) {
      return { status: 'error', text: 'Request failed: ' + err.message };
    }
  }
  function recordRun(routine, result) {
    state.runs.unshift({
      id: uid(), routineId: routine.id, title: routine.title || 'Untitled',
      firedAt: new Date().toISOString(), status: result.status, output: result.text,
    });
    state.runs = state.runs.slice(0, 200);
    save();
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
  function paintStatus() {
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const next = state.routines
      .filter((r) => r.status === 'scheduled' && r.scheduledAt)
      .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))[0];
    $('#clock').innerHTML = next ? `${t} · next <b>${relative(next.scheduledAt)}</b>` : `${t}`;
    const repo = $('#repoState');
    if (ghReady()) repo.innerHTML = `● <b>${esc(ghCfg().owner)}/${esc(ghCfg().repo)}</b>@${esc(ghCfg().branch)}`;
    else repo.innerHTML = `○ <b>local only</b>`;
    repo.title = ghReady() ? 'Routines commit to this repo' : 'Add a GitHub token in Settings to commit routines';
  }

  function render() {
    paintCounts();
    paintStatus();
    if (currentView === 'history') return renderHistory();
    const items = state.routines
      .filter((r) => r.status === currentView)
      .sort((a, b) => currentView === 'scheduled'
        ? new Date(a.scheduledAt || 0) - new Date(b.scheduledAt || 0)
        : new Date(b.updatedAt) - new Date(a.updatedAt));
    if (!items.length) return renderEmpty();
    view.innerHTML = `<div class="grid">${items.map(card).join('')}</div>`;
    bindCards();
  }

  function renderEmpty() {
    const copy = {
      scheduled: ['No routines queued', 'Create a routine, give it a time, and Schedule it — it commits to the repo and fires in a Claude session.'],
      library: ['Your library is empty', 'Save prompts here to iterate on, then schedule or run them whenever you like.'],
      archived: ['Nothing archived', 'Archived routines rest here. Restore them to the library anytime.'],
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
      return due ? `<span class="chip chip--due">due</span>` : `<span class="chip chip--scheduled">scheduled</span>`;
    }
    return `<span class="chip chip--${r.status}">${r.status}</span>`;
  }

  function card(r) {
    const recur = r.recurrence && r.recurrence !== 'none'
      ? `<span class="chip chip--recurring">${esc(RECURRENCE[r.recurrence])}</span>` : '';
    const when = r.status === 'scheduled'
      ? `<span class="card__meta-item">⏰ <b>${fmt(r.scheduledAt)}</b> · ${relative(r.scheduledAt)}</span>`
      : (r.lastRun ? `<span class="card__meta-item">last run <b>${fmt(r.lastRun)}</b></span>` : '');
    const modelName = ((MODELS.find((m) => m.id === (r.model || state.settings.model)) || {}).label || '').split(' — ')[0] || r.model;
    const repo = r.repoPath ? `<span class="card__meta-item" title="${esc(r.repoPath)}">📄 committed</span>` : '';

    return `<article class="card" data-id="${r.id}">
      <div class="card__head">
        <span class="card__title">${esc(r.title) || '<em>Untitled routine</em>'}</span>
        ${statusChip(r)}
      </div>
      <div class="card__prompt">${esc(r.prompt) || '(no prompt)'}</div>
      <div class="card__meta">
        ${recur}<span class="card__meta-item">⚡ <b>${esc(modelName)}</b></span>${when}${repo}
      </div>
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
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const r = getRoutine(el.dataset.id);
        if (!r) return;
        const act = btn.dataset.act;
        if (act === 'edit') return openDrawer(r);
        if (act === 'schedule') return openDrawer(r, { forceSchedule: true });
        if (act === 'run') {
          r.scheduledAt = new Date().toISOString();
          if (r.status !== 'scheduled') r.status = 'scheduled';
          upsertRoutine(r);
          render();
          if (await commitRoutine(r, 'Queued to run now')) await fireTrigger(r);
          return;
        }
        if (act === 'duplicate') {
          const copy = Object.assign({}, r);
          delete copy.id; delete copy.createdAt; delete copy.lastRun; copy.repoPath = null;
          copy.title = (r.title || 'Untitled') + ' (copy)'; copy.status = 'library'; copy.scheduledAt = null;
          const made = upsertRoutine(copy); render();
          commitRoutine(made, 'Duplicated to Library');
          return;
        }
        if (act === 'library' || act === 'archive') {
          r.status = act === 'archive' ? 'archived' : 'library';
          r.scheduledAt = null;
          upsertRoutine(r); render();
          commitRoutine(r, act === 'archive' ? 'Archived' : 'Moved to Library');
          return;
        }
        if (act === 'delete') {
          if (!confirm('Delete this routine permanently (also removes the note from the repo)?')) return;
          try { await removeFromRepo(r); } catch (err) { toast('Repo delete failed: ' + err.message, 'error'); }
          state.routines = state.routines.filter((x) => x.id !== r.id);
          save(); render(); toast('Deleted.');
        }
      });
    });
  }

  function renderHistory() {
    if (!state.runs.length) {
      view.innerHTML = `<div class="empty"><h3>No live tests yet</h3>
        <p>This tab logs <b>Test live</b> previews fired from the drawer. Real scheduled runs are executed by a Claude Code session and logged in <code>routines/logs/</code> in the repo.</p></div>`;
      return;
    }
    view.innerHTML = `<div class="section-head"><h2>Live test history</h2>
        <button class="btn btn--ghost btn--sm" id="clearHistory">Clear</button></div>
      <div class="history">${state.runs.map(runRow).join('')}</div>`;
    $('#clearHistory').addEventListener('click', () => { if (confirm('Clear test history?')) { state.runs = []; save(); render(); } });
  }
  function runRow(run) {
    return `<div class="run">
      <div class="run__head">
        <span class="chip chip--${run.status}">${run.status}</span>
        <span class="run__title">${esc(run.title)}</span>
        <span class="run__time">${fmt(run.firedAt)}</span>
      </div>
      <div class="run__body">${esc(run.output)}</div>
    </div>`;
  }

  /* ---------- Drawer (create / edit) ---------- */
  let editingId = null;

  function openDrawer(routine = null, opts = {}) {
    editingId = routine ? routine.id : null;
    drawerTitle.textContent = routine ? 'Edit routine' : 'New routine';
    const r = routine || { title: '', prompt: '', model: state.settings.model, recurrence: 'none', scheduledAt: null };
    const whenVal = r.scheduledAt ? toLocalInput(new Date(r.scheduledAt)) : defaultWhen();

    drawerBody.innerHTML = `
      <div class="field">
        <label class="label" for="f-title">Title</label>
        <input class="input" id="f-title" placeholder="e.g. Morning competitor scan" value="${esc(r.title)}" />
      </div>
      <div class="field">
        <label class="label" for="f-prompt">Directions for Claude</label>
        <textarea class="textarea" id="f-prompt" placeholder="Describe the task. It runs in a Claude Code session with full tools — it can read/write files, run commands, research, and commit.">${esc(r.prompt)}</textarea>
        <span class="hint">Saved as the body of a routine note in <code>routines/</code>. Use {{date}} / {{datetime}} for the run time.</span>
      </div>
      <div class="field">
        <label class="label" for="f-model">Model hint</label>
        <select class="select" id="f-model">
          ${MODELS.map((m) => `<option value="${m.id}" ${(r.model || state.settings.model) === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
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
      <div class="field">
        <button class="btn btn--ghost btn--sm" id="f-test" type="button">⚡ Test live (optional, uses API)</button>
        <div class="run__body" id="f-test-out" style="display:none"></div>
      </div>
      <div class="notice">
        <b>Run now</b> commits the note and pings your trigger to start a Claude session.
        <b>Schedule</b> queues it for the time above (repeating if set) — a scheduled
        trigger fires it. <b>Save to library</b> just parks it.
      </div>`;

    drawerFoot.innerHTML = `
      <button class="btn btn--accent" data-do="now">▶ Run now</button>
      <button class="btn btn--brand" data-do="schedule">⏰ Schedule</button>
      <button class="btn btn--secondary" data-do="library">▣ Save to library</button>`;

    $('#f-test', drawerBody).addEventListener('click', testLive);
    drawerFoot.querySelectorAll('[data-do]').forEach((b) => b.addEventListener('click', () => submitDrawer(b.dataset.do)));
    if (opts.forceSchedule) setTimeout(() => $('#f-when', drawerBody)?.focus(), 50);
    else setTimeout(() => $('#f-title', drawerBody)?.focus(), 50);
    overlay.classList.add('is-open');
  }

  async function testLive() {
    const prompt = $('#f-prompt').value;
    if (!prompt.trim()) return toast('Add directions first.', 'error');
    const out = $('#f-test-out'); const btn = $('#f-test');
    btn.disabled = true; btn.textContent = '⚡ Testing…';
    out.style.display = 'block'; out.textContent = 'Calling the Messages API…';
    const res = await callClaude(prompt, $('#f-model').value);
    out.textContent = res.text;
    btn.disabled = false; btn.textContent = '⚡ Test live (optional, uses API)';
    if (editingId) recordRun(getRoutine(editingId) || { id: editingId, title: $('#f-title').value }, res);
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
    if (!d.prompt.trim()) { toast('Add directions first.', 'error'); $('#f-prompt').focus(); return; }
    const base = { id: d.id, title: d.title, prompt: d.prompt, model: d.model, recurrence: d.recurrence };

    if (action === 'library') {
      const r = upsertRoutine(Object.assign(base, { status: 'library', scheduledAt: null }));
      closeDrawer(); currentView = 'library'; syncTabs(); render();
      await commitRoutine(r, 'Saved to Library');
      return;
    }
    if (action === 'schedule') {
      if (!d.whenRaw) return toast('Pick a date & time to schedule.', 'error');
      const when = new Date(d.whenRaw);
      if (when.getTime() <= Date.now() && d.recurrence === 'none')
        return toast('That time is in the past — pick a future time or set Repeat.', 'error');
      let scheduledAt = when.toISOString();
      if (when.getTime() <= Date.now()) scheduledAt = nextOccurrence(scheduledAt, d.recurrence);
      const r = upsertRoutine(Object.assign(base, { status: 'scheduled', scheduledAt }));
      closeDrawer(); currentView = 'scheduled'; syncTabs(); render();
      await commitRoutine(r, `Scheduled — fires ${relative(scheduledAt)}`);
      return;
    }
    if (action === 'now') {
      const r = upsertRoutine(Object.assign(base, { status: 'scheduled', scheduledAt: new Date().toISOString() }));
      closeDrawer(); currentView = 'scheduled'; syncTabs(); render();
      if (await commitRoutine(r, 'Queued to run now')) await fireTrigger(r);
    }
  }

  function closeDrawer() { overlay.classList.remove('is-open'); editingId = null; }

  /* ---------- Settings drawer ---------- */
  function openSettings() {
    editingId = null;
    drawerTitle.textContent = 'Settings';
    const g = ghCfg();
    drawerBody.innerHTML = `
      <div class="notice"><b>How routines run:</b> notes are committed to your repo, and a
      scheduled or webhook-triggered Claude Code session carries out the due ones
      (see <code>routines/README.md</code>).</div>

      <div class="field">
        <label class="label">GitHub — commit routines here</label>
        <input class="input" id="g-token" type="password" placeholder="GitHub token (repo contents: write)" value="${esc(g.token)}" />
        <span class="hint">Fine-grained PAT with <b>Contents: Read &amp; write</b> on this repo. Stored only in this browser.</span>
      </div>
      <div class="field__row">
        <div class="field"><label class="label" for="g-owner">Owner</label>
          <input class="input" id="g-owner" value="${esc(g.owner)}" /></div>
        <div class="field"><label class="label" for="g-repo">Repo</label>
          <input class="input" id="g-repo" value="${esc(g.repo)}" /></div>
        <div class="field"><label class="label" for="g-branch">Branch</label>
          <input class="input" id="g-branch" value="${esc(g.branch)}" /></div>
      </div>

      <div class="field">
        <label class="label" for="s-trigger">Routine trigger URL (POST)</label>
        <input class="input" id="s-trigger" placeholder="leave blank to use the Netlify CLAUDE_TRIGGER function" value="${esc(state.settings.triggerUrl)}" />
        <span class="hint">Leave blank when hosted on Netlify — <b>Run now</b> calls <code>/.netlify/functions/claude-trigger</code>, which fires your <code>CLAUDE_TRIGGER</code> webhook server-side. Set a URL here to POST a webhook directly instead.</span>
      </div>

      <div class="field">
        <label class="label" for="s-key">Anthropic API key (optional — for “Test live” only)</label>
        <input class="input" id="s-key" type="password" placeholder="sk-ant-…" value="${esc(state.settings.apiKey)}" />
        <span class="hint">Only used by the in-drawer Test button for instant previews. Not needed for scheduled runs.</span>
      </div>
      <div class="field">
        <label class="label" for="s-model">Default model</label>
        <select class="select" id="s-model">
          ${MODELS.map((m) => `<option value="${m.id}" ${state.settings.model === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
        </select>
      </div>`;
    drawerFoot.innerHTML = `<button class="btn btn--primary" id="s-save">Save settings</button>`;
    $('#s-save').addEventListener('click', () => {
      Object.assign(state.settings.github, {
        token: $('#g-token').value.trim(), owner: $('#g-owner').value.trim(),
        repo: $('#g-repo').value.trim(), branch: $('#g-branch').value.trim() || 'main',
      });
      state.settings.triggerUrl = $('#s-trigger').value.trim();
      state.settings.apiKey = $('#s-key').value.trim();
      state.settings.model = $('#s-model').value;
      save(); closeDrawer(); render(); toast('Settings saved.');
    });
    overlay.classList.add('is-open');
  }

  /* ---------- Tabs ---------- */
  function syncTabs() { $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === currentView)); }

  /* ---------- Init ---------- */
  function init() {
    $('#newBtn').addEventListener('click', () => openDrawer());
    $('#settingsBtn').addEventListener('click', openSettings);
    $('#drawerClose').addEventListener('click', closeDrawer);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDrawer(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
    $$('.tab').forEach((t) => t.addEventListener('click', () => { currentView = t.dataset.view; syncTabs(); render(); }));

    if (!state.routines.length && !state.runs.length && !localStorage.getItem(STORE_KEY)) {
      upsertRoutine({
        title: 'Daily marketing standup',
        prompt: 'You are my marketing chief of staff. Summarize what I should focus on today across content, ads, and outreach as 5 punchy bullets, and write it to standups/{{date}}.md.',
        model: DEFAULT_MODEL, recurrence: 'weekdays', status: 'library', scheduledAt: null,
      });
    }

    syncTabs();
    render();
    setInterval(paintStatus, 30000);
  }

  init();
})();
