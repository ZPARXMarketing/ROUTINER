/* Station (station.html) end to end, in a real browser.

   Supabase and the usage function are stubbed at the network layer with one
   fixture covering every state Station draws: a running run with a plan, a
   blocked run, a failed run, a missed routine, a finished run that opened a
   PR, scheduled + recurring routines, a shelf routine, an active Board note,
   and accounts whose Fire URL/token must never reach the page.

   Run: node scripts/test-station.mjs   (prints SKIP if Chromium is missing) */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/* Same skip rule as test-boot.mjs; also takes a globally installed Playwright. */
let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  try { ({ chromium } = createRequire(`${process.cwd()}/`)('playwright')); }
  catch { console.log('SKIP: playwright not installed (npm i -D playwright)'); process.exit(0); }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.STATION_SHOTS || '';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = path.join(ROOT, url === '/' ? 'station.html' : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let browser;
try {
  browser = await chromium.launch({ args: ['--no-sandbox'] });
} catch (e) {
  console.log(`SKIP: no Chromium available (${e.message.split('\n')[0]})`);
  server.close(); process.exit(0);
}

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ' — ' + extra}`); };

/* ---------- fixture ---------- */
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60000, HR = 3600000;
const SECRET = 'https://api.example/fire/SECRET-FIRE-URL';
const TOKEN = 'sk-SECRET-TOKEN-123';
const PR = 'https://github.com/zparxmarketing/routiner/pull/111';
const RUNS = [
  { id: 'r-run', routine_id: 'rt-1', title: 'Fix the retry classifier', status: 'running', output: '', account: 'acc-kimi', trigger_key: 'k1', model: 'moonshotai/kimi-k2.7-code', tools: ['read', 'code'],
    messages: [{ role: 'user', content: 'Fix it' }, { role: 'assistant', content: '', tool_calls: [{ function: { name: 'gh_search_code' } }] }],
    goal: { objective: 'Classify 429s as retryable', done: ['Read the classifier', 'Wrote the test'], remaining: ['Patch the regex', 'Open the PR'], phase: 'active' },
    started_at: iso(now - 25 * MIN), fired_at: iso(now - 1 * MIN) },
  { id: 'r-blocked', routine_id: null, title: 'Rotate the webhook secret', status: 'error', output: '', account: 'acc-kimi', trigger_key: 'k1', model: 'moonshotai/kimi-k2.7-code', tools: ['read'],
    messages: [{ role: 'user', content: 'Rotate it' }, { role: 'assistant', content: 'I need the new secret value to continue.' }],
    goal: { objective: 'Rotate the secret', done: ['Found where it is read'], remaining: ['Set the new value'], phase: 'blocked', blocked_reason: { code: 'needs-human', message: 'Which secret name should the new value go under?' } },
    started_at: iso(now - 3 * HR), fired_at: iso(now - 2 * HR) },
  { id: 'r-failed', routine_id: 'rt-2', title: 'Nightly lead sweep', status: 'error', output: 'OpenRouter call timed out (50000ms)', account: 'acc-kimi', trigger_key: 'k1', model: 'deepseek/deepseek-chat', tools: ['read'],
    messages: [{ role: 'user', content: 'Sweep' }, { role: 'assistant', content: 'OpenRouter call timed out (50000ms)' }], goal: null,
    started_at: iso(now - 5 * HR), fired_at: iso(now - 5 * HR + 4 * MIN) },
  { id: 'r-missed', routine_id: 'rt-3', title: 'Weekly recap', status: 'missed', output: '', account: 'sparks9679', trigger_key: 't_a', model: null, tools: null, messages: null, goal: null,
    started_at: iso(now - 26 * HR), fired_at: iso(now - 26 * HR) },
  { id: 'r-done', routine_id: 'rt-4', title: 'Smoke test: agent can open a PR', status: 'success', output: `Opened ${PR}`, account: 'acc-kimi', trigger_key: 'k1', model: 'moonshotai/kimi-k2.7-code', tools: ['read', 'code'],
    messages: [{ role: 'user', content: 'Open a PR' }, { role: 'assistant', content: `Done: ${PR}` }, { role: 'user', content: '[auto-continue]', _source: 'auto-continue' }],
    goal: { objective: 'Open a PR', done: ['Edited TODO.md', 'Opened the PR'], remaining: [], phase: 'complete' },
    started_at: iso(now - 40 * MIN), fired_at: iso(now - 30 * MIN) },
];
const sod = new Date(); sod.setHours(0, 0, 0, 0);
const laterToday = Math.min(sod.getTime() + 23 * HR, now + 2 * HR);
const ROUTINES = [
  { id: 'rt-1', title: 'Fix the retry classifier', prompt: 'x', status: 'library', recurrence: 'none', account: 'acc-kimi', trigger_key: 'k1', model: 'auto', scheduled_at: null, duration_min: 30, updated_at: iso(now) },
  { id: 'rt-5', title: 'Plan the Board', prompt: 'x', status: 'scheduled', recurrence: 'daily', account: 'sparks9679', trigger_key: 't_a', model: 'auto', scheduled_at: iso(laterToday - 3 * 86400000), duration_min: 45, updated_at: iso(now) },
  { id: 'rt-6', title: 'Lead enrichment: Huntsville chiro', prompt: 'x', status: 'scheduled', recurrence: 'none', account: 'acc-kimi', trigger_key: 'k1', model: 'deepseek/deepseek-chat', scheduled_at: iso(now + 26 * HR), duration_min: 30, updated_at: iso(now) },
];
const NOTES = [{ id: 'n1', body: 'Add a Discord digest of agent runs', status: 'active', created_at: iso(now - HR) }, { id: 'n2', body: 'idea', status: 'brainstorm', created_at: iso(now) }];
const SETTINGS = { accounts: [
  { id: 'sparks9679', label: 'Sparks', kind: 'claude', triggers: [{ id: 't_a', label: 'A', trigger: SECRET, token: TOKEN }, { id: 't_b', label: 'B', trigger: '', token: '' }] },
  { id: 'acc-kimi', label: 'Kimi', kind: 'openrouter-agent', key: TOKEN, triggers: [{ id: 'k1', label: 'A', model: 'moonshotai/kimi-k2.7-code', tools: ['read', 'code', 'schedule'] }] },
  { id: 'openrouter', label: 'OpenRouter', kind: 'openrouter', triggers: [{ id: 'perplexity', label: 'Perplexity' }] },
], model_prefs: null };
const USAGE = { ok: true, key: { usage: 20.5, limit: 30, limit_remaining: 9.5, label: 'x' },
  totals: { today: { cost: 0.4321, tokens: 1000, calls: 2 }, month: { cost: 3, tokens: 1, calls: 1 } }, by_model: [],
  recent: [{ created_at: iso(now - MIN), model: 'm', total_tokens: 1, cost: 0.3, account: 'acc-kimi', trigger_key: 'k1' }, { created_at: iso(now - 2 * MIN), model: 'm', total_tokens: 1, cost: 0.1321, account: 'x', trigger_key: 'y' }] };
const STORED = JSON.stringify({ access_token: 'test-token', refresh_token: 'r', expires_at: Math.floor(now / 1000) + 3600, user: { id: 'u', email: 'you@example.com' } });

const agentCalls = [];
async function open(width = 1366, height = 1000) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await ctx.route('**fonts.g**', (r) => r.abort());
  await ctx.route('**/*.supabase.co/**', (route) => {
    const req = route.request(); const url = req.url();
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/auth/v1/')) return json({});
    if (url.includes('/functions/v1/openrouter-usage')) return json(USAGE);
    if (url.includes('/functions/v1/openrouter-agent')) { agentCalls.push(JSON.parse(req.postData() || '{}')); return json({ ok: true }); }
    if (url.includes('/rest/v1/routiner_runs')) return json(RUNS);
    if (url.includes('/rest/v1/routiner_routines')) return json(ROUTINES);
    if (url.includes('/rest/v1/routiner_notes')) return json(NOTES);
    if (url.includes('/rest/v1/routiner_settings')) return json(SETTINGS);
    return json([]);
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts|ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript((s) => { localStorage.setItem('routiner-auth', s); localStorage.setItem('station.theme', 'light'); }, STORED);
  return { ctx, page, errors };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); };

/* ---------- Needs you ---------- */
{
  const { ctx, page, errors } = await open();
  await page.goto(`${BASE}/station.html`);
  await page.waitForSelector('.h-hero');
  await page.waitForFunction(() => !document.body.textContent.includes('Reading…'));
  const h = await page.textContent('.h-hero');
  check('headline counts blocked + failed + missed', h.trim() === '3 things need you.', h);
  const pills = await page.$$eval('.col-main .pill', (els) => els.map((e) => e.textContent.trim()));
  check('one card per kind', ['⚠︎ Blocked', '✕ Run failed', '○ Missed'].every((p) => pills.includes(p)), pills.join(','));
  const body = await page.textContent('body');
  check('blocked card states the reason, not prose guessed from the transcript', body.includes('Which secret name should the new value go under?'));
  check('spend today comes from the usage function', body.includes('$0.43'));
  check('key balance in the nav', body.includes('$9.50 left'));
  check('running run shows its plan step', body.includes('Step 3 of 4 · Patch the regex'));
  check('finished run lists its PR', body.includes('#111'));
  check('instances listed, unconfigured trigger skipped', (await page.$$eval('.st-group--agents .st-link', (e) => e.length)) === 2);
  const html = await page.content();
  check('no Fire URL or token in the page', !html.includes('SECRET-FIRE-URL') && !html.includes('SECRET-TOKEN'));
  await shot(page, 'needs');
  check('no page errors (Needs you)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/* ---------- Board / Calendar / Fleet ---------- */
{
  const { ctx, page, errors } = await open();
  await page.goto(`${BASE}/station.html#/board`);
  await page.waitForSelector('.board');
  const counts = await page.$$eval('.bcol', (cols) => cols.map((c) => c.querySelectorAll('.tcard').length));
  check('board columns: scheduled, running, needs you, done', JSON.stringify(counts) === '[2,1,3,1]', JSON.stringify(counts));
  await page.click('[data-act="filter-pr"]');
  const pr = await page.$$eval('.bcol', (cols) => cols.map((c) => c.querySelectorAll('.tcard').length));
  check('Has PR keeps only runs with a PR', JSON.stringify(pr) === '[0,0,0,1]', JSON.stringify(pr));
  await shot(page, 'board');

  await page.goto(`${BASE}/station.html#/calendar`);
  await page.waitForSelector('.cal');
  const evs = await page.$$eval('.ev', (e) => e.map((x) => x.textContent));
  check('calendar draws this week\'s runs and upcoming blocks', evs.length >= 4, String(evs.length));
  check('shelf routine listed as not scheduled', (await page.textContent('.cal-side')).includes('Fix the retry classifier'));
  const before = await page.textContent('.cal-main h1');
  await page.click('[data-act="week"][data-d="1"]');
  const after = await page.textContent('.cal-main h1');
  await page.click('[data-act="week"][data-d="0"]');
  check('next week moves the header, Today comes back', before !== after && (await page.textContent('.cal-main h1')) === before, `${before} / ${after}`);
  await shot(page, 'calendar');

  await page.goto(`${BASE}/station.html#/fleet`);
  await page.waitForSelector('.fleet');
  const fleet = await page.textContent('.fleet');
  check('fleet: agent spend today from the usage ledger', fleet.includes('$0.30'));
  check('fleet: Claude instance says spend is not metered here', fleet.includes('Not metered here'));
  check('fleet: success rate over the week (1 of 3 = 33%)', fleet.includes('33%'), fleet.replace(/\s+/g, ' ').slice(0, 300));
  await shot(page, 'fleet');
  check('no page errors (board/calendar/fleet)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/* ---------- Run: answer a blocked run ---------- */
{
  const { ctx, page, errors } = await open();
  await page.goto(`${BASE}/station.html#/run/r-blocked`);
  await page.waitForSelector('#reply');
  const txt = await page.textContent('#main');
  check('run view: alert names the code', txt.includes('needs-human'));
  check('run view: done and remaining steps', (await page.$$eval('.steps li', (e) => e.length)) === 2);
  await page.fill('#reply', 'Use WEBHOOK_SECRET_V2');
  await page.click('[data-act="send"]');
  await page.waitForFunction(() => document.querySelector('.toast'));
  const call = agentCalls.find((c) => c.runId === 'r-blocked');
  check('reply posts runId + prompt + access token to openrouter-agent', call && call.prompt === 'Use WEBHOOK_SECRET_V2' && call.accessToken === 'test-token', JSON.stringify(call));
  await shot(page, 'run');

  await page.goto(`${BASE}/station.html#/run/r-done`);
  await page.waitForSelector('.steps');
  check('injected turns render as a notice, not a user bubble', (await page.textContent('#main')).includes('Routiner continued the run'));
  check('no page errors (run)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/* ---------- iPad portrait: nothing spills sideways ---------- */
for (const [w, h] of [[1024, 768], [768, 1024]]) {
  const { ctx, page } = await open(w, h);
  for (const v of ['needs', 'board', 'calendar', 'fleet', 'run/r-run']) {
    await page.goto(`${BASE}/station.html#/${v}`);
    await page.waitForSelector('#main h1');
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`${w}px ${v}: no page-level horizontal scroll`, over <= 0, `${over}px`);
  }
  const small = await page.$$eval('button, a.btn, .st-link, .chip', (els) => els.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).map((e) => e.textContent.trim()).slice(0, 5));
  check(`${w}px: tap targets are at least 44px`, small.length === 0, small.join(','));
  if (w === 768) await shot(page, 'ipad-portrait-run');
  await ctx.close();
}

/* ---------- signed out ---------- */
{
  const ctx = await browser.newContext();
  await ctx.route('**fonts.g**', (r) => r.abort());
  await ctx.route('**/*.supabase.co/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/station.html`);
  await page.waitForSelector('.gate');
  check('signed out: sends you to the planner to sign in', (await page.textContent('.gate')).includes('Sign in first'));
  await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
