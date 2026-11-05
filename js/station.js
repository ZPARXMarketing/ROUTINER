/* ============================================================
   Station — "you + your agents", from the Project Station design.

   A second face on the SAME Supabase data the planner (index.html) reads:
   routiner_runs, routiner_routines, routiner_notes, routiner_settings, plus the
   openrouter-usage function for spend. It writes nothing of its own: the only
   actions are the ones History already offers (reply, retry, stop), sent to
   openrouter-agent exactly as js/app.js sends them. Anything else links back to
   the planner.

   Two rules carried over from the rest of Routiner:
   - Never invent a number. A figure the data cannot back shows "—", and a
     source that could not be read says so rather than reading as zero.
   - Secrets never reach the page. routiner_settings.accounts carries Fire URLs
     and tokens; they are dropped the moment the row is read.
   ============================================================ */
import { createClient } from './vendor/supabase-js.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { nextOccurrences } from './schedule.js';
import { modelLabel, setModelPrefs } from './model-router.js';

/* Same storage key as the planner, so one sign-in covers both pages. */
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { storageKey: 'routiner-auth' } });
const USAGE_URL = `${SUPABASE_URL}/functions/v1/openrouter-usage?limit=100`;
const AGENT_FN = `${SUPABASE_URL}/functions/v1/openrouter-agent`;
const POLL_MS = 15000;
const DAY = 86400000;

const TOOL_LABELS = {
  read: 'Read your data and run history',
  research: 'Web research',
  write: 'Write to apps',
  schedule: 'Schedule work for later',
  code: 'Fix code on GitHub (agent/ branches)',
};
const KNOWN_LABELS = { sparks9679: 'Sparks', zparxmarketing: 'Zparx', openrouter: 'OpenRouter' };
const RECURRENCE = { daily: 'Repeats daily', weekdays: 'Repeats weekdays', weekly: 'Repeats weekly' };

/* ---------- state ---------- */
let session = null;
let routines = [];
let runs = [];
let notes = [];
let accounts = [];          // secrets stripped
let usage = null;           // openrouter-usage payload, or { error }
let loadError = '';
let weekOffset = 0;
let boardFilter = { pr: false };
let search = '';
const drafts = new Map();   // runId → unsent reply
let busy = false;

/* ---------- tiny helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const t = (iso) => (iso ? new Date(iso).getTime() : NaN);
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const fmtWhen = (ms) => {
  if (!Number.isFinite(ms)) return '—';
  const sameDay = new Date(ms).toDateString() === new Date().toDateString();
  return sameDay ? fmtTime(ms) : `${fmtDay(ms)} · ${fmtTime(ms)}`;
};
function ago(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = Date.now() - ms;
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.round(d / 60000)} min ago`;
  if (d < DAY) return `${Math.round(d / 3600000)} hr ago`;
  return `${Math.round(d / DAY)} d ago`;
}
function span(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.round(ms / 60000);
  if (m < 1) return '<1 m';
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')}`;
}
const usd = (v) => (Number.isFinite(v) ? `$${v.toFixed(2)}` : '—');
const startOfDay = (ms = Date.now()) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
function toast(msg, bad = false) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' toast--bad' : ''}`;
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}
const AGENT_SVG = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 3v5M12 16v5M3 12h5M16 12h5"/></svg>';
const agentIco = (cls = '') => `<span class="agent-ico ${cls}" aria-hidden="true">${AGENT_SVG}</span>`;

/* ---------- data ---------- */
function stripAccounts(raw) {
  const list = Array.isArray(raw) ? raw
    : (raw && typeof raw === 'object')
      ? Object.entries(raw).map(([id, v]) => ({ id, triggers: v && (v.trigger || v.token) ? [{ id: 't1', label: 'A', trigger: v.trigger }] : [] }))
      : [];
  return list.map((a) => {
    const kind = a.kind || (a.id === 'openrouter' ? 'openrouter' : 'claude');
    return {
      id: a.id, label: a.label || KNOWN_LABELS[a.id] || a.id, kind,
      triggers: (a.triggers || []).map((tr, i) => ({
        id: tr.id, label: tr.label || String.fromCharCode(65 + i),
        model: tr.model || '', tools: Array.isArray(tr.tools) ? tr.tools : (tr.tools && typeof tr.tools === 'object' ? Object.keys(tr.tools).filter((k) => tr.tools[k]) : null),
        // A boolean, never the value: is there a Fire URL to send to at all?
        configured: kind === 'claude' ? !!(tr.trigger && String(tr.trigger).trim()) : true,
      })),
    };
  });
}

async function loadAll() {
  const [rRes, runRes, nRes, sRes] = await Promise.all([
    sb.from('routiner_routines').select('*').order('updated_at', { ascending: false }),
    sb.from('routiner_runs').select('id,routine_id,title,status,output,messages,model,account,trigger_key,tools,goal,started_at,fired_at')
      .order('fired_at', { ascending: false }).limit(200),
    sb.from('routiner_notes').select('id,body,status,created_at').order('created_at', { ascending: false }).limit(300),
    sb.from('routiner_settings').select('accounts,model_prefs').maybeSingle(),
  ]);
  if (rRes.error || runRes.error) throw new Error((rRes.error || runRes.error).message || 'Could not read Routiner');
  routines = (rRes.data || []).map((r) => ({
    id: r.id, title: r.title || 'Untitled', prompt: r.prompt || '', model: r.model, account: r.account, triggerKey: r.trigger_key,
    recurrence: r.recurrence || 'none', status: r.status, scheduledAt: r.scheduled_at, durationMin: r.duration_min || 30,
  }));
  runs = (runRes.data || []).map((x) => ({
    id: x.id, routineId: x.routine_id, title: x.title || 'Untitled', status: x.status || 'success', output: x.output || '',
    messages: Array.isArray(x.messages) ? x.messages : null, model: x.model || null, account: x.account || null,
    triggerKey: x.trigger_key || null, tools: x.tools || null, goal: x.goal || null,
    startedAt: t(x.started_at), firedAt: t(x.fired_at),
  }));
  notes = nRes.error ? [] : (nRes.data || []);
  accounts = stripAccounts(sRes && sRes.data && sRes.data.accounts);
  try { setModelPrefs(sRes && sRes.data && sRes.data.model_prefs); } catch { /* catalog defaults */ }
}

async function loadUsage() {
  try {
    const r = await fetch(USAGE_URL, { headers: { accept: 'application/json' } });
    const d = await r.json();
    usage = d && d.ok ? d : { error: (d && d.error) || `HTTP ${r.status}` };
  } catch (e) { usage = { error: e.message || 'unreachable' }; }
}

/* ---------- derivations ---------- */
const accountOf = (id) => accounts.find((a) => a.id === id);
function instanceName(account, triggerKey) {
  if (!account) return 'Claude';
  const a = accountOf(account);
  const label = a ? a.label : (KNOWN_LABELS[account] || account);
  const tr = a && a.triggers.find((x) => x.id === triggerKey);
  return tr && a.triggers.length > 1 ? `${label} · ${tr.label}` : label;
}
const runAgent = (r) => instanceName(r.account, r.triggerKey);
const isAgentRun = (r) => !!(r.account && Array.isArray(r.messages));
const runStart = (r) => (Number.isFinite(r.startedAt) ? r.startedAt : r.firedAt);
function goalProgress(g) {
  if (!g) return null;
  const done = Array.isArray(g.done) ? g.done.length : 0;
  const rem = Array.isArray(g.remaining) ? g.remaining.length : 0;
  if (!done && !rem) return null;
  const total = done + rem;
  const now = Array.isArray(g.remaining) && g.remaining[0];
  return { done, total, pct: Math.round((done / total) * 100), step: now ? `Step ${Math.min(done + 1, total)} of ${total} · ${now}` : `${done} of ${total} done` };
}
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c && (c.text || ''))).join('\n');
  return '';
}
const PR_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
function prsOf(r) {
  const seen = new Set();
  const scan = (s) => { for (const m of String(s || '').match(PR_RE) || []) seen.add(m); };
  scan(r.output);
  (r.messages || []).forEach((m) => scan(textOf(m.content)));
  return [...seen];
}
const prLabel = (url) => `#${url.split('/').pop()}`;

/* What needs a human, newest first. Each kind is a state the data actually
   records — never a guess from prose. */
function needsYou() {
  const weekAgo = Date.now() - 7 * DAY;
  const out = [];
  const laterSuccess = (r) => r.routineId && runs.some((o) => o.routineId === r.routineId && o.status === 'success' && o.firedAt > r.firedAt);
  for (const r of runs) {
    if (!(r.firedAt >= weekAgo)) continue;
    if (r.goal && r.goal.phase === 'blocked' && r.status !== 'running') {
      const br = r.goal.blocked_reason || {};
      out.push({ kind: 'blocked', run: r, at: r.firedAt, title: br.message || r.title, sub: r.goal.objective || r.title, code: br.code || '' });
    } else if (r.status === 'error' && !laterSuccess(r)) {
      out.push({ kind: 'failed', run: r, at: r.firedAt, title: r.title, sub: lastSaid(r) || 'The run stopped with an error.' });
    } else if (r.status === 'missed' && !laterSuccess(r)) {
      out.push({ kind: 'missed', run: r, at: r.firedAt, title: r.title, sub: 'Its time passed with nothing recorded.' });
    }
  }
  out.sort((a, b) => b.at - a.at);
  const k = usage && usage.key;
  if (k && k.limit != null && Number(k.limit_remaining) <= 1) {
    out.unshift({ kind: 'budget', at: Date.now(), title: `OpenRouter key has ${usd(Number(k.limit_remaining))} left`, sub: `Of a ${usd(Number(k.limit))} limit. Agent runs fail once it reaches zero.` });
  }
  return out;
}
function lastSaid(r) {
  const ms = r.messages || [];
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i];
    if (m && m.role === 'assistant' && !m._source) { const s = textOf(m.content).trim(); if (s) return clip(s, 220); }
  }
  return clip(String(r.output || '').trim(), 220);
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const running = () => runs.filter((r) => r.status === 'running');
const scheduled = () => routines
  .filter((r) => r.status === 'scheduled' && r.scheduledAt)
  .map((r) => ({ ...r, next: t((nextOccurrences(r.scheduledAt, r.recurrence, 1)[0]) || null) }))
  .filter((r) => Number.isFinite(r.next))
  .sort((a, b) => a.next - b.next);
const finishedSince = (ms) => runs.filter((r) => r.status === 'success' && r.firedAt >= ms);

/* ---------- actions (same wire as js/app.js agentPost) ---------- */
async function agentPost(body) {
  const payload = { ...body };
  try { payload.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { /* UTC */ }
  try {
    const { data: { session: s } } = await sb.auth.getSession();
    if (s?.access_token) payload.accessToken = s.access_token;
  } catch { /* the function will 401 and say so */ }
  return fetch(AGENT_FN, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(payload) });
}
async function sendToRun(runId, prompt, okMsg) {
  if (busy) return;
  busy = true; render();
  try {
    const r = await agentPost({ runId, prompt });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
    drafts.delete(runId);
    toast(okMsg);
  } catch (e) {
    // A long reply can outlast the request; the run row still advances. The
    // next poll shows it — say what is known, not that it failed outright.
    toast(`Didn't get an answer back (${e.message}). If the run moved, it will show on the next refresh.`, true);
  } finally {
    busy = false;
    await refresh();
  }
}
async function stopRun(runId) {
  if (busy) return;
  busy = true; render();
  try {
    const r = await agentPost({ runId, action: 'stop' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
    toast('Stopped. Retry picks it up from the transcript.');
  } catch (e) { toast(`Stop failed: ${e.message}`, true); }
  finally { busy = false; await refresh(); }
}

/* ---------- shell ---------- */
function route() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  const [view, id] = h.split('/');
  return { view: ['needs', 'board', 'calendar', 'run', 'fleet'].includes(view) ? view : 'needs', id };
}
function instances() {
  const list = [];
  for (const a of accounts) {
    if (a.kind === 'openrouter') continue; // the enrichment handle, not an agent
    for (const tr of a.triggers) {
      if (!tr.configured) continue;
      list.push({ key: `${a.id}:${tr.id}`, account: a.id, trigger: tr.id, kind: a.kind, name: instanceName(a.id, tr.id), model: tr.model, tools: tr.tools });
    }
  }
  return list;
}
function navHtml(view) {
  const needs = needsYou().length;
  const inst = instances();
  const link = (v, href, ico, label, extra = '') =>
    `<a class="st-link" href="${href}" ${view === v ? 'aria-current="page"' : ''}>${ico}<span class="st-link__grow">${label}</span>${extra}</a>`;
  const I = {
    inbox: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/></svg>',
    board: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12l3 3 5-6"/></svg>',
    cal: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    fleet: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3v5M12 16v5M3 12h5M16 12h5"/></svg>',
  };
  const runningBy = (i) => runs.filter((r) => r.status === 'running' && r.account === i.account && r.triggerKey === i.trigger).length;
  const k = usage && usage.key;
  let keyLine;
  if (!usage) keyLine = '<span class="muted">Reading…</span>';
  else if (usage.error) keyLine = '<span class="warn strong">Couldn\'t read the key</span>';
  else if (!k) keyLine = '<span class="muted">No key info</span>';
  else if (k.limit == null) keyLine = `<span class="strong">${usd(Number(k.usage))} spent</span><span class="muted">No limit set on the key.</span>`;
  else {
    const low = Number(k.limit_remaining) <= 1;
    keyLine = `<span class="${low ? 'bad' : 'ok'} strong">${low ? '✕' : '✓'} ${usd(Number(k.limit_remaining))} left</span><span class="muted">of a ${usd(Number(k.limit))} limit</span>`;
  }
  const theme = document.documentElement.dataset.theme || 'light';
  return `
  <div class="st-brand">
    <div class="st-brand__mark" aria-hidden="true">Z</div>
    <div class="st-brand__text"><span class="strong">ZPARX Station</span><span class="small muted">You + ${inst.length} agent${inst.length === 1 ? '' : 's'}</span></div>
  </div>
  <div class="st-field"><label for="q">Search</label><input id="q" class="st-input" type="search" placeholder="Runs and routines…" value="${esc(search)}" autocomplete="off"></div>
  <div class="st-group st-group--views">
    ${link('needs', '#/needs', I.inbox, 'Needs you', needs ? `<span class="st-badge">${needs}</span>` : '')}
    ${link('board', '#/board', I.board, 'Board')}
    ${link('calendar', '#/calendar', I.cal, 'Calendar')}
    ${link('fleet', '#/fleet', I.fleet, 'Agent fleet')}
  </div>
  <div class="st-group st-group--agents">
    <span class="st-group__label">Agents</span>
    ${inst.length ? inst.map((i) => {
      const n = runningBy(i);
      return `<a class="st-link" href="#/fleet">${agentIco()}<span class="st-link__grow">${esc(i.name)}</span><span class="small muted">${n ? `${n} running` : 'Idle'}</span></a>`;
    }).join('') : '<span class="small muted" style="padding:0 10px">None set up yet.</span>'}
  </div>
  <div class="st-foot">
    <span class="strong">OpenRouter key</span>
    ${keyLine}
    <a href="usage.html">Usage</a>
  </div>
  <div class="st-field">
    <label for="theme">Theme</label>
    <select id="theme" class="st-select">
      ${['light', 'dim', 'dark', 'sepia', 'hc-light', 'hc-dark'].map((v) => `<option value="${v}" ${v === theme ? 'selected' : ''}>${v.replace('hc-', 'High contrast ')}</option>`).join('')}
    </select>
  </div>
  <a class="st-link" href="index.html"><span class="st-link__grow">Open the planner</span></a>`;
}

function render() {
  const nav = $('#nav'); const main = $('#main');
  if (!nav || !main) return;
  const { view, id } = route();
  // Don't repaint over a reply being typed; the poll will catch up after.
  const active = document.activeElement;
  if (active && active.id === 'reply' && view === 'run') { paintNavOnly(view); return; }
  nav.innerHTML = navHtml(view === 'run' ? '' : view);
  wireNav();
  if (loadError) { main.innerHTML = `<div class="alert alert--bad"><strong>Couldn't read Routiner</strong><p>${esc(loadError)}</p><div class="btn-row"><button class="btn btn--primary" type="button" data-act="reload">Try again</button></div></div>`; wireMain(); return; }
  const q = search.trim().toLowerCase();
  main.innerHTML = ({ needs: viewNeeds, board: () => viewBoard(q), calendar: viewCalendar, run: () => viewRun(id), fleet: viewFleet }[view])();
  wireMain();
}
function paintNavOnly(view) { const nav = $('#nav'); nav.innerHTML = navHtml(view === 'run' ? '' : view); wireNav(); }

/* ---------- Needs you (Home) ---------- */
const KIND = {
  blocked: { pill: '⚠︎ Blocked', cls: 'warn', card: 'card--warn' },
  failed: { pill: '✕ Run failed', cls: 'bad', card: 'card--bad' },
  missed: { pill: '○ Missed', cls: 'bad', card: 'card--bad' },
  budget: { pill: '$ Budget', cls: '', card: '' },
};
function needCard(n) {
  const k = KIND[n.kind];
  const r = n.run;
  const who = r ? `<span class="row" style="align-items:center">${agentIco('agent-ico--dash')}${esc(runAgent(r))}</span>` : '';
  const prs = r ? prsOf(r) : [];
  let actions = '';
  if (n.kind === 'blocked') actions = `<a class="btn btn--primary" href="#/run/${r.id}">Answer</a><a class="btn btn--quiet" href="#/run/${r.id}">Open run</a>`;
  else if (n.kind === 'failed') actions = `${isAgentRun(r) ? `<button class="btn btn--primary" type="button" data-act="retry" data-run="${r.id}" ${busy ? 'disabled' : ''}>Retry</button>` : ''}<a class="btn btn--secondary" href="#/run/${r.id}">Open run</a>`;
  else if (n.kind === 'missed') actions = '<a class="btn btn--primary" href="index.html">Run it from the planner</a>';
  else actions = '<a class="btn btn--primary" href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener">Top up the key</a><a class="btn btn--quiet" href="usage.html">Usage</a>';
  return `
  <article class="card ${k.card}">
    <div class="card__meta">
      <span class="pill ${k.cls ? `pill--${k.cls}` : ''}">${k.pill}</span>
      ${who}
      ${prs.map((u) => `<a class="mono" href="${esc(u)}" target="_blank" rel="noopener">PR ${esc(prLabel(u))}</a>`).join('')}
      <span class="card__meta-end">${esc(ago(n.at))}${n.code ? ` · <span class="mono">${esc(n.code)}</span>` : ''}</span>
    </div>
    <h2 class="h-sec">${esc(clip(n.title, 160))}</h2>
    ${n.sub && n.sub !== n.title ? `<p>${esc(n.sub)}</p>` : ''}
    <div class="btn-row">${actions}</div>
  </article>`;
}
function viewNeeds() {
  const items = needsYou();
  const today = startOfDay();
  const done = finishedSince(today);
  const run = running();
  const sch = scheduled();
  const queuedToday = sch.filter((r) => r.next < today + DAY);
  const failedToday = runs.filter((r) => r.status === 'error' && r.firedAt >= today).length;
  const oldest = items.filter((i) => i.run).reduce((m, i) => Math.min(m, i.at), Infinity);
  const spend = usage && usage.totals && usage.totals.today;
  const k = usage && usage.key;
  const now = new Date();
  const headline = items.length ? `${items.length} thing${items.length === 1 ? '' : 's'} need${items.length === 1 ? 's' : ''} you.` : 'Nothing needs you.';
  const lede = `Since midnight your agents finished ${done.length} run${done.length === 1 ? '' : 's'}${failedToday ? ` and ${failedToday} failed` : ''}. ${run.length ? `${run.length} running now.` : 'Nothing is running.'}`;
  return `
  <header class="ph" style="flex-direction:column;align-items:stretch;gap:6px">
    <span class="small muted">${esc(now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }))} · ${esc(fmtTime(now.getTime()))}</span>
    <h1 class="h-hero">${esc(headline)}</h1>
    <p class="lede">${esc(lede)}</p>
  </header>
  <div class="stats">
    <div class="stat"><span class="small muted">Finished today</span><span class="stat__n">${done.length}</span><span class="small ${failedToday ? 'bad strong' : 'ok strong'}">${failedToday ? `✕ ${failedToday} failed` : '✓ 0 failed'}</span></div>
    <div class="stat"><span class="small muted">Running now</span><span class="stat__n">${run.length}</span><span class="small muted">${queuedToday.length} more today</span></div>
    <div class="stat"><span class="small muted">Waiting on you</span><span class="stat__n">${items.length}</span><span class="small ${Number.isFinite(oldest) ? 'warn strong' : 'muted'}">${Number.isFinite(oldest) ? `⚠︎ oldest ${esc(ago(oldest).replace(' ago', ''))}` : 'All clear'}</span></div>
    <div class="stat"><span class="small muted">Spend today</span><span class="stat__n">${spend ? usd(Number(spend.cost)) : '—'}</span><span class="small muted">${spend ? (k && k.limit != null ? `${usd(Number(k.limit_remaining))} left on key` : `${spend.calls} model calls`) : (usage && usage.error ? "Couldn't read spend" : 'Reading…')}</span></div>
  </div>
  <div class="cols">
    <section class="col-main" aria-label="Needs you">
      ${items.length ? items.map(needCard).join('') : '<div class="empty">Nothing is blocked, failed or missed in the last 7 days.</div>'}
    </section>
    <aside class="col-side" aria-label="Handled without you">
      <section class="sec">
        <div class="sec__head"><h2 class="h-sub">Running now</h2><a href="#/fleet">Fleet</a></div>
        ${run.length ? run.map(runCard).join('') : '<div class="empty">No agent is running.</div>'}
      </section>
      <section class="sec">
        <h2 class="h-sub">Finished without you · ${done.length}</h2>
        ${done.length ? `<ol class="list">${done.slice(0, 8).map((r) => `
          <li><span class="ok strong" aria-hidden="true">✓</span>
            <div class="list__body"><a class="list__title" href="#/run/${r.id}" style="color:var(--ink);text-decoration:none">${esc(r.title)}</a>
            <span class="muted">${esc(runAgent(r))} · ${esc(fmtTime(r.firedAt))}${prsOf(r).length ? ` · <span class="mono">${prsOf(r).map(prLabel).map(esc).join(' ')}</span>` : ''}</span></div></li>`).join('')}</ol>`
          : '<div class="empty">Nothing finished yet today.</div>'}
      </section>
      <section class="sec">
        <div class="sec__head"><h2 class="h-sub">Rest of today</h2><a href="#/calendar">Calendar</a></div>
        ${queuedToday.length ? queuedToday.slice(0, 8).map((r) => `
          <div class="row"><span class="muted" style="width:72px;flex:none;font-variant-numeric:tabular-nums">${esc(fmtTime(r.next))}</span><span>${esc(r.title)}</span></div>`).join('')
          : '<div class="empty">Nothing else is scheduled today.</div>'}
      </section>
    </aside>
  </div>`;
}
function runCard(r) {
  const p = goalProgress(r.goal);
  return `
  <a class="runcard" href="#/run/${r.id}">
    <div class="row"><span class="strong">${esc(runAgent(r))}</span><span class="row__end">${esc(span(Date.now() - runStart(r)))} so far</span></div>
    <span class="strong">${esc(r.title)}</span>
    ${p ? `<div class="progress" aria-hidden="true"><div class="progress__bar" style="width:${p.pct}%"></div></div><span class="small muted">${esc(p.step)}</span>` : '<span class="small muted">No plan recorded yet.</span>'}
  </a>`;
}

/* ---------- Board ---------- */
function tabsBar(sel) {
  const tab = (v, label) => `<a class="tab" role="tab" href="#/${v}" aria-selected="${sel === v}">${label}</a>`;
  return `<div class="tabsbar"><div class="tabs" role="tablist" aria-label="Views">${tab('board', 'Board')}${tab('calendar', 'Calendar')}${tab('fleet', 'Agent fleet')}</div>
    ${sel === 'board' ? `<div class="tabsbar__end"><button class="chip" type="button" data-act="filter-pr" aria-pressed="${boardFilter.pr}">${boardFilter.pr ? '✓ ' : ''}Has PR</button></div>` : ''}</div>`;
}
function tcard({ href, key, due, title, progress, who, status, statusCls, prs }) {
  return `
  <a class="tcard" href="${href}">
    <div class="row muted"><span class="mono">${esc(key)}</span>${(prs || []).map((u) => `<span class="mono">${esc(prLabel(u))}</span>`).join('')}<span class="row__end">${esc(due || '')}</span></div>
    <span class="tcard__title">${esc(title)}</span>
    ${progress ? `<div style="display:flex;flex-direction:column;gap:4px"><div class="progress" aria-hidden="true"><div class="progress__bar" style="width:${progress.pct}%"></div></div><span class="small muted">${esc(progress.step)}</span></div>` : ''}
    <div class="tcard__foot"><span class="row" style="align-items:center">${agentIco()}${esc(who)}</span><span class="${statusCls || 'muted'}">${esc(status || '')}</span></div>
  </a>`;
}
function viewBoard(q) {
  const match = (s) => !q || String(s || '').toLowerCase().includes(q);
  const keepRun = (r) => match(r.title) && (!boardFilter.pr || prsOf(r).length);
  const weekAgo = Date.now() - 7 * DAY;
  const sched = boardFilter.pr ? [] : scheduled().filter((r) => match(r.title));
  const runN = running().filter(keepRun);
  const needs = needsYou().filter((n) => n.run && keepRun(n.run));
  const done = runs.filter((r) => r.status === 'success' && r.firedAt >= weekAgo).filter(keepRun);
  const cols = [
    { name: 'Scheduled', hint: 'Agents run these at their time.', cards: sched.map((r) => tcard({
      href: '#/calendar', key: instanceName(r.account, r.triggerKey), due: fmtWhen(r.next), title: r.title,
      who: r.model && r.model !== 'auto' ? modelLabel(r.model) : instanceName(r.account, r.triggerKey),
      status: RECURRENCE[r.recurrence] || 'Scheduled' })) },
    { name: 'Running', hint: 'Agents working now.', cards: runN.map((r) => tcard({
      href: `#/run/${r.id}`, key: runAgent(r), due: `${span(Date.now() - runStart(r))}`, title: r.title, progress: goalProgress(r.goal),
      who: r.model ? modelLabel(r.model) : runAgent(r), status: '● Running', statusCls: 'warn', prs: prsOf(r) })) },
    { name: 'Needs you', hint: 'Agents stop when only you can answer.', cards: needs.map((n) => tcard({
      href: `#/run/${n.run.id}`, key: runAgent(n.run), due: ago(n.at), title: n.run.title,
      who: n.run.model ? modelLabel(n.run.model) : runAgent(n.run), prs: prsOf(n.run),
      status: KIND[n.kind].pill, statusCls: KIND[n.kind].cls })) },
    { name: 'Done', hint: 'Finished in the last 7 days.', cards: done.slice(0, 20).map((r) => tcard({
      href: `#/run/${r.id}`, key: runAgent(r), due: fmtWhen(r.firedAt), title: r.title,
      who: r.model ? modelLabel(r.model) : runAgent(r), prs: prsOf(r), status: '✓ Done', statusCls: 'ok' })) },
  ];
  const feed = runs.slice(0, 8);
  const top = needsYou().filter((n) => n.run).slice(0, 2);
  return `
  <header class="ph">
    <div class="ph__text">
      <span class="small muted">Routiner</span>
      <h1 class="h-page">Board</h1>
      <div class="row muted" style="gap:16px;flex-wrap:wrap"><span>${sched.length} scheduled</span><span>${runN.length} running</span><span>${notes.filter((n) => n.status === 'active').length} active notes on the planner's Board</span></div>
    </div>
    <div class="btn-row"><a class="btn btn--secondary" href="index.html">Planner Board</a><a class="btn btn--primary" href="index.html">New routine</a></div>
  </header>
  ${tabsBar('board')}
  <div class="cols" style="gap:24px">
    <div class="board-wrap" style="flex:999 1 560px;min-width:0">
      <div class="board">
        ${cols.map((c) => `
        <section class="bcol">
          <div class="bcol__head"><div class="row" style="align-items:center"><h2 class="h-sub">${c.name}</h2><span class="small muted">${c.cards.length}</span></div><span class="small muted">${c.hint}</span></div>
          ${c.cards.join('') || '<div class="empty">Nothing here.</div>'}
        </section>`).join('')}
      </div>
    </div>
    <aside class="col-side" aria-label="Live activity">
      <section class="panel panel--accent">
        <div class="sec__head"><h2 class="h-sub">Needs you · ${needsYou().length}</h2><a href="#/needs">See all</a></div>
        ${top.length ? top.map((n, i) => `${i ? '<div class="rule"></div>' : ''}
          <div style="display:flex;flex-direction:column;gap:8px">
            <span class="strong">${esc(clip(n.title, 120))}</span>
            <span class="small muted">${esc(runAgent(n.run))} · ${esc(ago(n.at))}</span>
            <div><a class="btn btn--${i ? 'secondary' : 'primary'}" href="#/run/${n.run.id}">${n.kind === 'blocked' ? 'Answer' : 'Review'}</a></div>
          </div>`).join('') : '<span class="small muted">All clear.</span>'}
      </section>
      <section class="sec">
        <div class="sec__head"><h2 class="h-sub">Recent activity</h2><span class="end small ok strong">● Updates every 15 s</span></div>
        <ol class="list">${feed.map((r) => `
          <li>${agentIco()}<div class="list__body"><span><strong>${esc(runAgent(r))}</strong> ${esc(activityVerb(r))} <a href="#/run/${r.id}">${esc(clip(r.title, 70))}</a></span><span class="muted">${esc(ago(r.firedAt))}</span></div></li>`).join('')}
        </ol>
      </section>
    </aside>
  </div>`;
}
function activityVerb(r) {
  if (r.status === 'running') return 'is working on';
  if (r.goal && r.goal.phase === 'blocked') return 'is blocked on';
  return ({ success: 'finished', error: 'failed', missed: 'missed' })[r.status] || `${r.status}:`;
}

/* ---------- Calendar ---------- */
const H = 56;
function weekStart(offset) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow + offset * 7);
  return d.getTime();
}
function calendarEvents(ws) {
  const we = ws + 7 * DAY;
  const evs = [];
  for (const r of runs) {
    const s = runStart(r);
    if (!(s >= ws && s < we)) continue;
    const e = Math.max(Number.isFinite(r.firedAt) ? r.firedAt : s, s + 20 * 60000);
    const st = r.status === 'running' ? ['● Running', 'warn'] : r.goal && r.goal.phase === 'blocked' ? ['⚠︎ Blocked', 'warn']
      : r.status === 'success' ? ['✓ Done', 'ok'] : r.status === 'missed' ? ['○ Missed', 'bad'] : r.status === 'error' ? ['✕ Failed', 'bad'] : [r.status, 'muted'];
    evs.push({ s, e, title: r.title, sub: runAgent(r), status: st[0], cls: st[1], href: `#/run/${r.id}`, past: true });
  }
  const now = Date.now();
  for (const r of routines) {
    if (r.status !== 'scheduled' || !r.scheduledAt) continue;
    for (const iso of nextOccurrences(r.scheduledAt, r.recurrence, 60, Math.max(ws, now) - 1)) {
      const s = t(iso);
      if (s >= we) break;
      if (s < ws) continue;
      evs.push({ s, e: s + (r.durationMin || 30) * 60000, title: r.title, sub: instanceName(r.account, r.triggerKey), status: RECURRENCE[r.recurrence] || 'Scheduled', cls: 'muted', href: 'index.html', past: false });
    }
  }
  return evs;
}
function layoutDay(evs) {
  evs.sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = []; let clusterEnd = -Infinity;
  const flush = () => { const n = Math.max(...cluster.map((x) => x.lane + 1)); cluster.forEach((x) => { x.lanes = n; }); cluster = []; };
  for (const ev of evs) {
    if (ev.s >= clusterEnd && cluster.length) flush();
    const used = new Set(cluster.filter((x) => x.e > ev.s).map((x) => x.lane));
    let lane = 0; while (used.has(lane)) lane++;
    ev.lane = lane; cluster.push(ev); clusterEnd = Math.max(clusterEnd, ev.e);
  }
  if (cluster.length) flush();
  return evs;
}
function viewCalendar() {
  const ws = weekStart(weekOffset);
  const evs = calendarEvents(ws);
  const hourOf = (ms) => { const d = new Date(ms); return d.getHours() + d.getMinutes() / 60; };
  let lo = 8; let hi = 18;
  evs.forEach((e) => { lo = Math.min(lo, Math.floor(hourOf(e.s))); hi = Math.max(hi, Math.min(24, Math.ceil((e.e - startOfDay(e.s)) / 3600000))); });
  hi = Math.min(24, Math.max(hi, lo + 4));
  const height = (hi - lo) * H;
  // setDate, not +i*DAY, so a DST change doesn't shift a column by an hour.
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(ws); d.setDate(d.getDate() + i); return d.getTime(); });
  const today = startOfDay();
  const nowH = hourOf(Date.now());
  const we = days[6] + DAY;
  const a = new Date(ws); const b = new Date(we - 1);
  const mon = (d) => d.toLocaleDateString([], { month: 'long' });
  const title = `${mon(a)} ${a.getDate()} – ${a.getMonth() === b.getMonth() ? '' : `${mon(b)} `}${b.getDate()}, ${b.getFullYear()}`;
  const library = routines.filter((r) => r.status === 'library');
  const active = notes.filter((n) => n.status === 'active');
  const colHtml = (d0) => {
    const mine = layoutDay(evs.filter((e) => e.s >= d0 && e.s < d0 + DAY));
    const evHtml = mine.map((e) => {
      const top = Math.max(0, (hourOf(e.s) - lo) * H + 1);
      const endH = Math.min(hi, (e.e - d0) / 3600000);
      const h = Math.max(22, (endH - hourOf(e.s)) * H - 3);
      return `<a class="ev ${e.past ? 'ev--past' : ''}" href="${e.href}" style="top:${top}px;height:${h}px;left:calc(${(e.lane * 100) / e.lanes}% + 3px);width:calc(${100 / e.lanes}% - 6px)" title="${esc(`${fmtTime(e.s)} · ${e.title} · ${e.sub}`)}">
        <span class="ev__t">${agentIco('agent-ico--bare')}<span>${esc(e.title)}</span></span>
        ${h >= 38 ? `<span class="ev__s">${esc(fmtTime(e.s))} · ${esc(e.sub)}</span>` : ''}
        ${h >= 56 ? `<span class="ev__st ${e.cls}">${esc(e.status)}</span>` : ''}</a>`;
    }).join('');
    const now = d0 === today && nowH >= lo && nowH <= hi ? `<div class="nowline" role="img" aria-label="Now, ${esc(fmtTime(Date.now()))}" style="top:${(nowH - lo) * H}px"></div>` : '';
    return `<div class="cal__col" style="height:${height}px">${evHtml}${now}</div>`;
  };
  return `
  <div class="cols">
    <aside class="cal-side" aria-label="Unscheduled and key">
      <section class="sec">
        <div style="display:flex;flex-direction:column;gap:2px"><h2 class="h-sub">Not scheduled · ${library.length}</h2><span class="small muted">Routines on the shelf. Schedule one from the planner.</span></div>
        ${library.slice(0, 8).map((r) => `<a class="uitem" href="index.html"><span class="small muted mono">${esc(instanceName(r.account, r.triggerKey))}</span><span class="strong">${esc(r.title)}</span></a>`).join('') || '<div class="empty">The shelf is empty.</div>'}
      </section>
      <section class="sec">
        <div style="display:flex;flex-direction:column;gap:2px"><h2 class="h-sub">On the Board · ${active.length}</h2><span class="small muted">Active notes waiting to be planned.</span></div>
        ${active.slice(0, 6).map((n) => `<div class="uitem"><span class="small muted">${esc(ago(t(n.created_at)))}</span><span>${esc(clip(String(n.body || ''), 120))}</span></div>`).join('') || '<div class="empty">No active notes.</div>'}
      </section>
      <section class="legend" aria-label="Key">
        <span class="strong">Key</span>
        <span><span class="swatch" aria-hidden="true"></span>Scheduled agent run</span>
        <span><span class="swatch swatch--past" aria-hidden="true"></span>Run that happened</span>
        <span><span style="width:28px;height:0;border-top:2px solid var(--danger)" aria-hidden="true"></span>Now</span>
      </section>
    </aside>
    <section class="cal-main">
      <header class="ph" style="align-items:center">
        <div class="ph__text" style="flex-basis:280px"><span class="small muted">Week of ${esc(fmtDay(ws))}</span><h1 class="h-page">${esc(title)}</h1></div>
        <div class="cal-tools">
          <button class="iconbtn" type="button" data-act="week" data-d="-1" aria-label="Previous week"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg></button>
          <button class="btn btn--secondary" type="button" data-act="week" data-d="0">Today</button>
          <button class="iconbtn" type="button" data-act="week" data-d="1" aria-label="Next week"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button>
          <a class="btn btn--primary" href="index.html">Schedule agent run</a>
        </div>
      </header>
      ${tabsBar('calendar')}
      <div class="cal"><div class="cal__inner">
        <div class="cal__head"><div></div>${days.map((d0) => `
          <div class="cal__day"><span class="small muted">${esc(new Date(d0).toLocaleDateString([], { weekday: 'short' }))}</span><span class="cal__date ${d0 === today ? 'cal__date--today' : ''}">${new Date(d0).getDate()}</span>${d0 === today ? '<span class="sr-only">Today</span>' : ''}</div>`).join('')}
        </div>
        <div class="cal__body">
          <div class="cal__gutter" style="height:${height}px">${Array.from({ length: hi - lo + 1 }, (_, i) => {
            const hr = lo + i; const lab = hr === 0 || hr === 24 ? '12 AM' : `${hr > 12 ? hr - 12 : hr} ${hr >= 12 ? 'PM' : 'AM'}`;
            return i ? `<span class="cal__hour" style="top:${i * H - 8}px">${lab}</span>` : '';
          }).join('')}</div>
          ${days.map(colHtml).join('')}
        </div>
      </div></div>
      ${evs.length ? '' : '<div class="empty">Nothing ran or is scheduled this week.</div>'}
    </section>
  </div>`;
}

/* ---------- Run (Task + agent run) ---------- */
function viewRun(id) {
  const r = runs.find((x) => x.id === id);
  if (!r) return `<div class="empty">That run isn't in the last 200. <a href="#/needs">Back to Needs you</a></div>`;
  const g = r.goal || null;
  const p = goalProgress(g);
  const prs = prsOf(r);
  const blocked = g && g.phase === 'blocked';
  const statusPill = r.status === 'running' ? `<span class="pill pill--warn">● Running${p ? ` · step ${Math.min(p.done + 1, p.total)} of ${p.total}` : ''}</span>`
    : blocked ? '<span class="pill pill--warn">⚠︎ Blocked</span>'
    : r.status === 'success' ? '<span class="pill pill--ok">✓ Done</span>'
    : r.status === 'missed' ? '<span class="pill pill--bad">○ Missed</span>'
    : r.status === 'error' ? '<span class="pill pill--bad">✕ Failed</span>' : `<span class="pill">${esc(r.status)}</span>`;
  const routine = r.routineId && routines.find((x) => x.id === r.routineId);
  const tools = Array.isArray(r.tools) ? r.tools : [];
  const ms = r.messages || [];
  const toolCalls = ms.flatMap((m) => (m && Array.isArray(m.tool_calls) ? m.tool_calls : []));
  const lastCalls = toolCalls.slice(-4).map((c) => `→ ${(c.function && c.function.name) || c.name || 'tool'}`).join('\n');

  let alert = '';
  if (blocked) {
    const br = g.blocked_reason || {};
    alert = `<div class="alert"><strong>${esc(runAgent(r))} needs you${br.code ? ` · <span class="mono">${esc(br.code)}</span>` : ''}</strong><p>${esc(br.message || 'The run stopped and is waiting on you.')}</p></div>`;
  } else if (r.status === 'error') {
    alert = `<div class="alert alert--bad"><strong>The run failed</strong><p>${esc(lastSaid(r) || 'No message was recorded.')}</p></div>`;
  }

  const steps = [];
  if (g) {
    (g.done || []).forEach((s) => steps.push({ mark: '✓', cls: 'ok', title: s }));
    (g.remaining || []).forEach((s, i) => steps.push({ mark: i === 0 && r.status === 'running' ? '●' : '○', cls: i === 0 && r.status === 'running' ? 'warn' : 'muted', title: s, log: i === 0 && r.status === 'running' ? lastCalls : '' }));
  }

  const thread = [];
  for (const m of ms) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = textOf(m.content).trim();
    if (!text) continue;
    if (m._source) { thread.push(`<div class="notice">${esc(m._source === 'auto-continue' ? 'Routiner continued the run' : m._source === 'repeat-guard' ? 'Routiner nudged the agent off a loop' : m._source)}</div>`); continue; }
    if (m.role === 'user') {
      thread.push(`<article class="msg"><span class="human-ico" aria-hidden="true">You</span><div class="msg__body"><span class="strong">You</span><p class="msg__text">${esc(clip(text, 4000))}</p></div></article>`);
    } else {
      thread.push(`<article class="msg">${agentIco('agent-ico--msg')}<div class="msg__body"><span class="strong">${esc(runAgent(r))} <span class="small muted" style="font-weight:400">Agent</span></span><p class="msg__text">${esc(clip(text, 4000))}</p></div></article>`);
    }
  }
  if (!thread.length && r.output) {
    thread.push(`<article class="msg">${agentIco('agent-ico--msg')}<div class="msg__body"><span class="strong">${esc(runAgent(r))}</span><p class="msg__text">${esc(clip(r.output, 6000))}</p></div></article>`);
  }

  const props = [
    ['Status', r.status === 'running' ? 'Running' : blocked ? 'Blocked' : r.status],
    ['Agent', runAgent(r)],
    ['Model', r.model ? modelLabel(r.model) : '—'],
    ['Started', fmtWhen(runStart(r))],
    [r.status === 'running' ? 'Running for' : 'Last activity', r.status === 'running' ? span(Date.now() - runStart(r)) : fmtWhen(r.firedAt)],
    ['Took', r.status === 'running' ? '—' : Number.isFinite(r.startedAt) ? span(r.firedAt - r.startedAt) : '—'],
    ['Routine', routine ? routine.title : (r.routineId ? 'Deleted routine' : 'Chat (no routine)')],
    ['Tool calls', toolCalls.length ? String(toolCalls.length) : '—'],
  ];
  const draft = drafts.get(r.id) || '';
  return `
  <header style="display:flex;flex-direction:column;gap:8px">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="#/needs">Needs you</a><span aria-hidden="true">/</span><a href="#/board">Board</a><span aria-hidden="true">/</span><span>${esc(clip(r.title, 60))}</span></nav>
    <h1 class="h-page">${esc(r.title)}</h1>
    <div class="row" style="flex-wrap:wrap;align-items:center">
      ${statusPill}
      <span class="pill pill--agent">${esc(runAgent(r))}${r.status === 'running' ? ' is working' : ''}</span>
      ${prs.map((u) => `<a class="pill mono" href="${esc(u)}" target="_blank" rel="noopener" style="text-decoration:none">PR ${esc(prLabel(u))}</a>`).join('')}
    </div>
  </header>
  <div class="cols">
    <main class="col-main" style="gap:32px">
      ${alert}
      ${g && g.objective ? `<section class="sec"><h2 class="h-sec">Goal</h2><p style="max-width:var(--measure-default);white-space:pre-wrap">${esc(g.objective)}</p></section>` : ''}
      <section class="sec">
        <div class="sec__head"><h2 class="h-sec">Agent run</h2><span class="small muted">Started ${esc(fmtWhen(runStart(r)))}${p ? ` · ${p.done} of ${p.total} steps done` : ''}</span></div>
        ${steps.length ? `<ol class="steps">${steps.map((s) => `
          <li><span class="steps__mark ${s.cls}" aria-hidden="true">${s.mark}</span>
            <div style="flex-grow:1;min-width:0;display:flex;flex-direction:column;gap:4px"><span class="strong">${esc(s.title)}</span>${s.log ? `<pre class="log">${esc(s.log)}</pre>` : ''}</div></li>`).join('')}</ol>`
          : `<div class="empty">${isAgentRun(r) ? 'This run kept no plan, so there are no steps to show. The transcript is below.' : 'This run reported back without a step-by-step plan.'}</div>`}
      </section>
      <section class="sec" style="gap:16px">
        <h2 class="h-sec">Discussion</h2>
        ${thread.join('') || '<div class="empty">Nothing was said in this run.</div>'}
        <div style="display:flex;flex-direction:column;gap:6px">
          <label for="reply" class="strong">Reply</label>
          <textarea id="reply" class="st-textarea" rows="3" placeholder="Answer the agent, or steer the run">${esc(draft)}</textarea>
          <div class="btn-row"><button class="btn btn--primary" type="button" data-act="send" data-run="${r.id}" ${busy ? 'disabled' : ''}>${busy ? 'Sending…' : 'Send'}</button></div>
        </div>
      </section>
    </main>
    <aside class="col-side" aria-label="Run details">
      <section class="panel">
        <h2 class="h-sub">Control the agent</h2>
        ${r.status === 'running' && isAgentRun(r) ? `<button class="btn btn--secondary" type="button" data-act="stop" data-run="${r.id}" ${busy ? 'disabled' : ''}>Stop run</button>` : ''}
        ${r.status !== 'running' && isAgentRun(r) ? `<button class="btn btn--secondary" type="button" data-act="retry" data-run="${r.id}" ${busy ? 'disabled' : ''}>${r.status === 'success' ? 'Run again from here' : 'Retry'}</button>` : ''}
        <a class="btn btn--quiet" href="index.html">Open in the planner's Chat</a>
        ${prs.map((u) => `<a class="btn btn--quiet" href="${esc(u)}" target="_blank" rel="noopener">Open PR ${esc(prLabel(u))} on GitHub</a>`).join('')}
      </section>
      <section class="panel panel--flush">
        <h2 class="h-sub">Properties</h2>
        <dl class="props">${props.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      </section>
      ${tools.length ? `<section class="panel"><h2 class="h-sub">Allowed to</h2>${tools.map((x) => `<span class="perm"><b class="ok" aria-hidden="true">✓</b>${esc(TOOL_LABELS[x] || x)}</span>`).join('')}<a href="#/fleet" class="small">How agents behave</a></section>` : ''}
    </aside>
  </div>`;
}

/* ---------- Fleet ---------- */
function viewFleet() {
  const weekAgo = Date.now() - 7 * DAY;
  const today = startOfDay();
  const inst = instances();
  const recent = (usage && Array.isArray(usage.recent)) ? usage.recent : null;
  // Per-instance spend is only knowable when the recent list covers every call
  // made today; past that it would be an undercount, so it shows "—".
  const todayCalls = usage && usage.totals && usage.totals.today ? Number(usage.totals.today.calls) : NaN;
  const recentToday = recent ? recent.filter((x) => t(x.created_at) >= today) : [];
  const spendKnown = recent && Number.isFinite(todayCalls) && recentToday.length >= todayCalls;
  const totalRunning = running().length;
  const queued = scheduled();
  const spend = usage && usage.totals && usage.totals.today;
  const card = (i) => {
    const mine = runs.filter((r) => r.account === i.account && r.triggerKey === i.trigger);
    const now = mine.filter((r) => r.status === 'running');
    const week = mine.filter((r) => r.firedAt >= weekAgo && (r.status === 'success' || r.status === 'error'));
    const ok = week.filter((r) => r.status === 'success');
    const durs = ok.filter((r) => Number.isFinite(r.startedAt)).map((r) => r.firedAt - r.startedAt);
    const avg = durs.length ? span(durs.reduce((a, b) => a + b, 0) / durs.length) : '—';
    const q = queued.filter((r) => r.account === i.account && (r.triggerKey || null) === (i.trigger || null));
    const mySpend = spendKnown ? recentToday.filter((x) => x.account === i.account && x.trigger_key === i.trigger).reduce((a, x) => a + Number(x.cost || 0), 0) : null;
    const tools = Array.isArray(i.tools) ? i.tools : (i.kind === 'openrouter-agent' ? ['read', 'research', 'write', 'schedule'] : null);
    const role = i.kind === 'claude' ? 'Claude Code session · its own tools' : `OpenRouter agent · ${i.model ? modelLabel(i.model) : 'default model'}`;
    return `
    <article class="card agent">
      <div class="agent__head">
        ${agentIco('agent-ico--lg agent-ico--dash')}
        <div class="agent__name"><h2 class="h-sec">${esc(i.name)}</h2><span class="small muted">${esc(role)}</span></div>
        <span class="small strong ${now.length ? 'warn' : 'muted'}">${now.length ? `● ${now.length} running` : 'Idle'}</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <span class="st-label">Working on</span>
        ${now.length ? now.map((r) => { const p = goalProgress(r.goal); return `<a href="#/run/${r.id}" style="display:flex;flex-direction:column;gap:4px;color:var(--ink);text-decoration:none"><span class="small strong">${esc(r.title)}</span>${p ? `<div class="progress" aria-hidden="true"><div class="progress__bar" style="width:${p.pct}%"></div></div>` : ''}</a>`; }).join('')
          : `<span class="small muted">Nothing right now.${q[0] ? ` Next run: ${esc(fmtWhen(q[0].next))}` : ''}</span>`}
        <span class="small muted">${q.length} scheduled</span>
      </div>
      <dl class="kpis">
        <div><dt>Finished / 7 d</dt><dd>${ok.length}</dd></div>
        <div><dt>Success</dt><dd>${week.length ? `${Math.round((ok.length / week.length) * 100)}%` : '—'}</dd></div>
        <div><dt>Avg run</dt><dd>${esc(avg)}</dd></div>
      </dl>
      <div class="row"><span class="strong">Spend today</span><span class="row__end" style="color:var(--ink);font-variant-numeric:tabular-nums">${i.kind === 'claude' ? 'Not metered here' : mySpend == null ? '—' : usd(mySpend)}</span></div>
      ${tools ? `<div style="display:flex;flex-direction:column;gap:6px"><span class="st-label">Allowed to</span>
        ${Object.keys(TOOL_LABELS).map((k) => `<span class="perm"><b class="${tools.includes(k) ? 'ok' : 'bad'}" aria-hidden="true">${tools.includes(k) ? '✓' : '✕'}</b>${tools.includes(k) ? '' : '<span class="sr-only">Not allowed: </span>'}${esc(TOOL_LABELS[k])}</span>`).join('')}</div>` : ''}
      <div class="btn-row" style="margin-top:auto"><a class="btn btn--quiet" href="index.html">Settings in the planner</a></div>
    </article>`;
  };
  const rules = [
    ['Reading code, issues, PRs and CI', '✓', 'Does it on its own', 'ok'],
    ['Changing code', '✓', 'Opens a PR on an agent/ branch', 'ok'],
    ['Merging a PR', '?', 'Only if AGENT_ALLOW_MERGE is on, and never while CI is red or unfinished', 'warn'],
    ['Something only you can give (a key, a choice)', '?', 'Stops as Blocked and lands in Needs you', 'warn'],
    ['The OpenRouter key runs out', '✕', 'Stops the run and says so; no retries', 'bad'],
    ['Repos outside GITHUB_ALLOWED_REPOS', '✕', 'Refused', 'bad'],
  ];
  const recentRuns = runs.slice(0, 10);
  return `
  <header class="ph">
    <div class="ph__text">
      <a href="#/needs" class="small">Back to Needs you</a>
      <h1 class="h-hero">Agent fleet</h1>
      <p class="muted">${inst.length} agent${inst.length === 1 ? '' : 's'} · ${totalRunning} running · ${queued.length} scheduled · ${spend ? `${usd(Number(spend.cost))} spent today` : 'spend unknown'}</p>
    </div>
    <div class="btn-row"><a class="btn btn--primary" href="index.html">Add agent</a></div>
  </header>
  ${tabsBar('fleet')}
  ${!spendKnown && usage && !usage.error ? '<p class="small muted">Per-agent spend shows "—" when today has more model calls than the usage list returns.</p>' : ''}
  <section class="fleet" aria-label="Agents">${inst.length ? inst.map(card).join('') : '<div class="empty">No agents set up. Add one in the planner\'s Settings.</div>'}</section>
  <div class="cols">
    <section class="col-main" style="flex:1 1 480px;gap:12px">
      <div style="display:flex;flex-direction:column;gap:2px"><h2 class="h-big">How agents behave</h2><p class="muted">What the GitHub agent does on its own. Set by the server (edge secrets), not per agent.</p></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">When</th><th scope="col">Agents will</th></tr></thead>
        <tbody>${rules.map(([w, m, a, c]) => `<tr><td>${esc(w)}</td><td class="strong ${c}">${m} ${esc(a)}</td></tr>`).join('')}</tbody></table></div>
    </section>
    <section class="col-main" style="flex:1 1 480px;gap:12px">
      <div style="display:flex;flex-direction:column;gap:2px"><h2 class="h-big">Recent runs</h2><p class="muted">Every run is logged with its outcome. Select one to open it.</p></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Run</th><th scope="col">Agent</th><th scope="col">Result</th><th scope="col" class="num">Time</th></tr></thead>
        <tbody>${recentRuns.map((r) => `<tr><td><a href="#/run/${r.id}">${esc(clip(r.title, 60))}</a></td><td>${esc(runAgent(r))}</td>
          <td class="${r.status === 'success' ? 'ok' : r.status === 'running' ? 'warn' : 'bad'} strong">${esc(activityVerb(r).replace(/^is /, '').replace(/ (on|working on)$/, '').replace(/^working$/, 'running'))}</td>
          <td class="num">${(r.status === 'success' || r.status === 'error') && Number.isFinite(r.startedAt) ? esc(span(r.firedAt - r.startedAt)) : '—'}</td></tr>`).join('')}</tbody></table></div>
    </section>
  </div>`;
}

/* ---------- wiring ---------- */
function wireNav() {
  const q = $('#q');
  if (q) q.addEventListener('input', () => {
    search = q.value;
    if (route().view !== 'board') { location.hash = '#/board'; return; }
    const pos = q.selectionStart; render(); const q2 = $('#q'); if (q2) { q2.focus(); q2.setSelectionRange(pos, pos); }
  });
  const th = $('#theme');
  if (th) th.addEventListener('change', () => { setTheme(th.value); });
}
function wireMain() {
  const main = $('#main');
  main.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', () => {
    const act = el.dataset.act; const id = el.dataset.run;
    if (act === 'reload') boot();
    else if (act === 'retry') sendToRun(id, 'continue', 'Retrying. It shows as running on the next refresh.');
    else if (act === 'stop') stopRun(id);
    else if (act === 'send') {
      const text = ($('#reply')?.value || '').trim();
      if (!text) { toast('Type a reply first.'); return; }
      drafts.set(id, text);
      sendToRun(id, text, 'Sent.');
    } else if (act === 'filter-pr') { boardFilter.pr = !boardFilter.pr; render(); }
    else if (act === 'week') { const d = Number(el.dataset.d); weekOffset = d === 0 ? 0 : weekOffset + d; render(); }
  }));
  const reply = $('#reply');
  if (reply) reply.addEventListener('input', () => { const { id } = route(); drafts.set(id, reply.value); });
}
function setTheme(v) {
  document.documentElement.dataset.theme = v;
  try { localStorage.setItem('station.theme', v); } catch { /* private mode */ }
}

/* ---------- boot ---------- */
async function refresh() {
  try { await loadAll(); loadError = ''; } catch (e) { loadError = e.message || String(e); }
  render();
  loadUsage().then(render);
}
async function boot() {
  let s = null;
  try {
    ({ data: { session: s } } = await Promise.race([
      sb.auth.getSession(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('session timeout')), 8000)),
    ]));
  } catch { s = null; }
  session = s;
  if (!session) {
    document.body.innerHTML = `<div class="gate"><h1 class="h-page">Sign in first</h1><p class="muted">Station reads the same account as the planner. Sign in there, then come back.</p><div class="btn-row"><a class="btn btn--primary" href="index.html">Open the planner</a></div></div>`;
    return;
  }
  render();
  await refresh();
  setInterval(() => { if (document.visibilityState === 'visible' && !busy) refresh(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
}

(() => {
  let theme = null;
  try { theme = localStorage.getItem('station.theme'); } catch { /* */ }
  if (!theme) theme = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  setTheme(theme);
})();
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
boot();
