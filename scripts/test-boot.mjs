#!/usr/bin/env node
/* ============================================================
   Boot-path tests — "does the app actually come up, and does it say so when
   it can't?"

   Every check here corresponds to a way Routiner used to end up as a blank
   white page that the reader could only answer by refreshing until it worked:
   a third-party CDN in front of the module graph, an auth lock that never
   resolved, and a first data fetch whose failure produced a toast over nothing.

   Drives the real index.html / app.js / app.css in Chromium over a local
   static server. Supabase is stubbed at the network layer — this never touches
   the live project.

     node scripts/test-boot.mjs

   Needs `playwright` (npm i -D playwright) and a Chromium build; skips with
   exit 0 if neither is present, so it can sit in CI without being mandatory.
   ============================================================ */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { console.log('SKIP: playwright not installed (npm i -D playwright)'); process.exit(0); }

/* Playwright's bundled browser and the one baked into an image often disagree
   on build number, so find whatever Chromium is actually on disk. */
function findChromium() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(root, dir, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined; // let Playwright use its own default
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
let block404 = null;
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (block404 && url === block404) { res.writeHead(404); return res.end('blocked by test'); }
  const file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let browser;
try {
  browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
} catch (e) {
  console.log(`SKIP: no Chromium available (${e.message.split('\n')[0]})`);
  server.close(); process.exit(0);
}

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ' — ' + extra}`);
};
const seen = (p) => p.textContent('#view').catch(() => '(no #view)');

/* A signed-in session, straight into the storage key the app uses. */
const STORED = JSON.stringify({
  access_token: 'test-token', refresh_token: 'test-refresh',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'test-user', email: 'you@example.com' },
});

/* Stub Supabase + block webfonts so a test never waits on the network. */
async function context({ storage = null, restDown = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  await ctx.route('**/*.supabase.co/**', (route) => {
    if (route.request().url().includes('/auth/v1/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (restDown) return route.abort('failed');
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]', headers: { 'content-range': '0-0/0' } });
  });
  await ctx.route('**fonts.g**', (r) => r.abort());
  const page = await ctx.newPage();
  if (storage) await page.addInitScript((s) => localStorage.setItem('routiner-auth', s), storage);
  return { ctx, page };
}

console.log('\nBoot path');
// ── The app boots, and boots entirely from this origin ──────────────────────
{
  const { ctx, page } = await context();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.auth h2', { timeout: 10000 }).catch(() => {});
  check('signed-out boot lands on the sign-in card', await page.isVisible('.auth h2'), await seen(page));
  check('boot raises no page errors', errs.length === 0, errs.join('; '));
  check('the boot placeholder gets replaced', !(await page.isVisible('#boot')));

  const urls = await page.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name));
  check('supabase-js is served from this origin', urls.some((u) => u.includes('/js/vendor/supabase-js.js')));

  /* The regression that mattered: anything third-party that the browser waits
     on can blank the app. Scripts are the worst case (a failed module takes the
     whole graph with it), so no off-origin script may exist at all… */
  const offScripts = await page.evaluate(() =>
    [...document.querySelectorAll('script[src]')].map((s) => s.src).filter((s) => !s.startsWith(location.origin)));
  check('no third-party script on the boot path', offScripts.length === 0, offScripts.join(', '));

  /* …and off-origin stylesheets must be non-render-blocking, or a slow font CDN
     paints an empty page. `media="print"` (flipped to `all` on load) is how. */
  const blocking = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel~="stylesheet"]')]
      .filter((l) => !l.href.startsWith(location.origin))
      .filter((l) => !l.getAttribute('onload')?.includes("media='all'"))
      .map((l) => l.href));
  check('no render-blocking third-party stylesheet', blocking.length === 0, blocking.join(', '));
  await ctx.close();
}

// ── The font CDN hangs (the check above, proven behaviourally) ─────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  await ctx.route('**/*.supabase.co/**', (route) => (route.request().url().includes('/auth/v1/')
    ? route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    : route.fulfill({ status: 200, contentType: 'application/json', body: '[]', headers: { 'content-range': '0-0/0' } })));
  /* Never answer, never fail — the case a plain <link rel=stylesheet> waits on
     forever, and the one that used to leave a white page. */
  await ctx.route('**fonts.g**', () => {});
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: 'commit' });
  const painted = await page.waitForSelector('.auth h2', { timeout: 10000 }).then(() => true, () => false);
  check('a hanging font CDN does not block first paint', painted, `${Date.now() - t0}ms`);
  await ctx.close();
}

console.log('\nBoot failures are visible');
// ── The app module can't be fetched ────────────────────────────────────────
{
  block404 = '/js/app.js';
  const { ctx, page } = await context();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#bootRetry:visible', { timeout: 10000 }).catch(() => {});
  check('a missing app module shows an error, not a blank page', await page.isVisible('#bootRetry'), await seen(page));
  check('…and names what happened', /didn.t start/i.test(await page.textContent('#bootMsg')));
  await ctx.close();
  block404 = null;
}

// ── The vendored dependency can't be fetched ───────────────────────────────
{
  block404 = '/js/vendor/supabase-js.js';
  const { ctx, page } = await context();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#bootRetry:visible', { timeout: 20000 }).catch(() => {});
  check('a missing dependency shows an error, not a blank page', await page.isVisible('#bootRetry'), await seen(page));
  await ctx.close();
  block404 = null;
}

console.log('\nStalls recover instead of hanging');
// ── A Web Lock nobody will ever release (a killed/suspended tab held it) ────
{
  const { ctx, page } = await context({ storage: STORED });
  await page.addInitScript(() => {
    const real = navigator.locks.request.bind(navigator.locks);
    navigator.locks.request = (name, opts, cb) =>
      String(name).includes('routiner-auth') ? new Promise(() => {}) : real(name, opts, cb);
  });
  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('.topbar', { state: 'visible', timeout: 25000 }).catch(() => {});
  const ms = Date.now() - t0;
  check('a wedged auth lock still comes up signed in', await page.isVisible('.topbar'), await seen(page));
  check('…within the timeout budget', ms < 15000, `${ms}ms`);
  await ctx.close();
}

// ── The first data load fails ──────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  let restDown = true, attempts = 0;
  await ctx.route('**/*.supabase.co/**', (route) => {
    if (route.request().url().includes('/auth/v1/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    attempts++;
    if (restDown) return route.abort('failed');
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]', headers: { 'content-range': '0-0/0' } });
  });
  await ctx.route('**fonts.g**', (r) => r.abort());
  const page = await ctx.newPage();
  await page.addInitScript((s) => localStorage.setItem('routiner-auth', s), STORED);
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('[data-act="retry"]', { timeout: 20000 }).catch(() => {});
  check('a failed first load offers Try again', await page.isVisible('[data-act="retry"]'), await seen(page));
  /* Three parallel queries per attempt; two attempts before giving up. */
  check('…after one silent retry', attempts >= 6, `${attempts} requests`);
  /* And the sign-in card must not be what the reader is left staring at. */
  check('…and does not leave the sign-in card up', !(await page.isVisible('.auth h2')));

  restDown = false;
  await page.click('[data-act="retry"]');
  await page.waitForSelector('.hx, .grid, .empty', { timeout: 20000 }).catch(() => {});
  check('Try again recovers in place, no reload', !(await page.isVisible('[data-act="retry"]')), await seen(page));
  await ctx.close();
}

/* ── Chat: starting one, without first inventing a routine ─────────────────
   A conversation used to require a routine — you made a scheduled thing, ran
   it, and its run was the only thread you could talk to. The New chat composer
   is the fix, and it has no coverage anywhere else: it lives entirely in the
   pane whose height chain has already broken twice on real devices. */
{
  const AGENT_SETTINGS = {
    user_id: 'test-user', fire_enabled: true, model_policy: null,
    accounts: [{
      id: 'acc_kimi', label: 'Kimi', kind: 'openrouter-agent', key: '',
      triggers: [{ id: 't_a', label: 'A', trigger: '', token: '', model: 'moonshotai/kimi-k2.7-code', tools: ['read', 'research', 'write', 'schedule'] }],
    }],
  };
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  let posted = null;
  await ctx.route('**/*.supabase.co/**', (route) => {
    const url = route.request().url();
    const json = (body, headers = {}) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers });
    if (url.includes('/auth/v1/')) return json({});
    // The agent endpoint: record what the composer actually sent, then answer
    // as the edge function would for a run that finished in one segment.
    if (url.includes('/functions/v1/openrouter-agent')) {
      posted = JSON.parse(route.request().postData() || '{}');
      return json({ ok: true, runId: 'run-1', output: 'On it.', steps: 1, cost: 0.0001, model: 'moonshotai/kimi-k2.7-code' });
    }
    if (url.includes('routiner_settings')) return json(AGENT_SETTINGS);
    return json([], { 'content-range': '0-0/0' });
  });
  await ctx.route('**fonts.g**', (r) => r.abort());
  const page = await ctx.newPage();
  await page.addInitScript((s) => localStorage.setItem('routiner-auth', s), STORED);
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('.topbar', { timeout: 20000 }).catch(() => {});

  console.log('\nChat can be started without a routine');
  // With no runs at all, the pane must be somewhere to type — not the dead-end
  // "Nothing here yet" card it used to be.
  const composerUp = await page.waitForSelector('#chat-input', { timeout: 10000 }).then(() => true, () => false);
  check('an empty Chat opens on the composer, not a dead end', composerUp, await seen(page));
  check('the rail offers a New chat button', await page.isVisible('#hx-new'));

  if (composerUp) {
    await page.fill('#chat-input', 'Draft the launch email, then check the metrics tomorrow at 9am.');
    await page.click('#chat-send');
    await page.waitForTimeout(800);
    check('sending posts a fresh run', !!posted && !posted.runId, JSON.stringify(posted || {}).slice(0, 160));
    check('…on the configured instance', posted?.account === 'acc_kimi' && posted?.triggerKey === 't_a');
    check("…with that instance's model and tools",
      posted?.model === 'moonshotai/kimi-k2.7-code' && (posted?.tools || []).includes('schedule'));
    // The title has to come from the message: a chat has no routine to borrow
    // a name from, and an untitled rail row is unfindable.
    check('…titled from the message', /^Draft the launch email/.test(posted?.title || ''), posted?.title);
    // Only the browser knows where the reader is, and "9am tomorrow" is
    // meaningless without it — a missing zone schedules work overnight.
    check("…carrying the reader's timezone", typeof posted?.tz === 'string' && posted.tz.length > 0, posted?.tz);
  }
  await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
