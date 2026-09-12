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
  let posted = null, savedRoutine = null;
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
    // Keeping a chat prompt writes an ordinary routine row; answer as PostgREST
    // does for insert().select().single() so the app's own path is exercised.
    if (url.includes('routiner_routines') && route.request().method() === 'POST') {
      savedRoutine = JSON.parse(route.request().postData() || '{}');
      return json({ id: 'rt-1', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...savedRoutine });
    }
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

    // Keeping the prompt, not just the answer (issue #100). The message you are
    // about to send is often the thing worth having again next week, and the
    // only way onto the shelf used to be re-typing it into the routine drawer.
    await page.click('#chat-save');
    await page.waitForTimeout(400);
    check('the composer can keep a prompt in the Library', !!savedRoutine, JSON.stringify(savedRoutine || {}).slice(0, 160));
    check('…as an unscheduled shelf item', savedRoutine?.status === 'library' && !savedRoutine?.scheduled_at);
    check('…carrying the prompt and the instance it would have run on',
      /launch email/.test(savedRoutine?.prompt || '') && savedRoutine?.account === 'acc_kimi' && savedRoutine?.trigger_key === 't_a');
    // Saving is not sending: the draft stays put, so one click does not cost
    // the message.
    check('…without sending it or clearing the box',
      !posted && /launch email/.test(await page.inputValue('#chat-input')));

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

    // Choosing the model for this one chat (issue #102). The picker starts on
    // the instance's model — the check above — so this proves the pick is what
    // actually gets sent, not just what the select shows.
    await page.click('#hx-new');
    const pickerUp = await page.waitForSelector('#chat-model', { timeout: 8000 }).then(() => true, () => false);
    check('the composer offers a model picker', pickerUp);
    if (pickerUp) {
      check('…defaulting to the instance model', await page.inputValue('#chat-model') === 'moonshotai/kimi-k2.7-code');
      check('…grouped by lab', (await page.locator('#chat-model optgroup').count()) >= 5);
      await page.selectOption('#chat-model', 'z-ai/glm-5');
      await page.fill('#chat-input', 'Second chat, different model.');
      await page.click('#chat-send');
      await page.waitForTimeout(800);
      check('…and the pick is what gets run', posted?.model === 'z-ai/glm-5', posted?.model);
    }
  }
  await ctx.close();
}

/* ── The rest of the workspace: a Claude instance in Chat, the routine drawer,
   and a routine that logged nothing ──────────────────────────────────────────
   One context, because all four regressions below need the same signed-in app
   with both kinds of account configured, and rebuilding it four times costs a
   Chromium page load each. */
{
  const MIXED_SETTINGS = {
    user_id: 'test-user', fire_enabled: true, model_policy: null,
    accounts: [
      { id: 'acc_kimi', label: 'Kimi', kind: 'openrouter-agent', key: '',
        triggers: [{ id: 't_a', label: 'A', trigger: '', token: '', model: 'moonshotai/kimi-k2.7-code', tools: ['read', 'research'] }] },
      { id: 'sparks9679', label: 'Sparks9679', kind: 'claude', key: '',
        triggers: [{ id: 't_c', label: 'A', trigger: 'https://example.invalid/fire', token: 'tok', model: '', tools: [] }] },
    ],
  };
  /* A one-off whose time has passed with no run logged — the exact row that
     used to render as "ran" with a dead-end note (issue #109). */
  const STALE_ROUTINE = {
    id: 'rt-stale', user_id: 'test-user', title: 'Deep research sweep',
    prompt: 'Research the competitor set and summarise.',
    account: 'acc_kimi', trigger_key: 't_a', model: 'moonshotai/kimi-k2.7-code',
    task_type: 'research', complexity: 'medium', recurrence: 'none', status: 'scheduled',
    scheduled_at: new Date(Date.now() - 3 * 3600_000).toISOString(), duration_min: 30,
    last_run: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };

  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const routinePosts = [];
  let claudeFire = null, agentFire = null;
  await ctx.route('**/*.supabase.co/**', (route) => {
    const url = route.request().url();
    const json = (body, headers = {}) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers });
    if (url.includes('/auth/v1/')) return json({});
    if (url.includes('/functions/v1/openrouter-agent')) {
      agentFire = JSON.parse(route.request().postData() || '{}');
      return json({ ok: true, runId: 'run-9', output: 'Done.', steps: 1, cost: 0.0001 });
    }
    if (url.includes('routiner_settings')) return json(MIXED_SETTINGS);
    if (url.includes('routiner_routines')) {
      if (route.request().method() === 'POST') {
        const body = JSON.parse(route.request().postData() || '{}');
        routinePosts.push(body);
        /* Slow on purpose: the duplicate-routine bug lives entirely in the
           window between the first click and the insert coming back, so a
           fast stub would never reproduce it (issue #108). */
        return new Promise((done) => setTimeout(() => done(json({ id: `rt-${routinePosts.length}`,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...body })), 700));
      }
      return json([STALE_ROUTINE], { 'content-range': '0-0/1' });
    }
    return json([], { 'content-range': '0-0/0' });
  });
  /* The Claude fire goes to this app's own Netlify function, not Supabase. */
  await ctx.route('**/.netlify/functions/claude-trigger', (route) => {
    claudeFire = JSON.parse(route.request().postData() || '{}');
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await ctx.route('**fonts.g**', (r) => r.abort());
  const page = await ctx.newPage();
  await page.addInitScript((s) => {
    localStorage.setItem('routiner-auth', s);
    /* The master fire switch defaults to off anywhere but the live host, so a
       localhost test would never reach a fire path at all. */
    localStorage.setItem('routiner.settings.v1', JSON.stringify({ firing: true }));
  }, STORED);
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('.topbar', { timeout: 20000 }).catch(() => {});

  console.log('\nA routine that logged nothing says so (issue #109)');
  /* The stale routine is the only History row, so it opens selected. */
  const staleUp = await page.waitForSelector('#run-firenow', { timeout: 10000 }).then(() => true, () => false);
  check('a routine with no run offers Run now, not a dead end', staleUp, await seen(page));
  if (staleUp) {
    const pane = await page.textContent('#hx-main');
    // "Ran" was a claim about a run that never happened — the whole complaint.
    check('…and the chip does not claim it ran', /Never ran/.test(pane) && !/>Ran</.test(pane), pane.slice(0, 200));
    check('…naming what to check', /never fired/i.test(pane));
    await page.click('#run-firenow');
    await page.waitForTimeout(900);
    check('…and Run now actually fires it', !!agentFire && /competitor set/.test(agentFire.prompt || ''),
      JSON.stringify(agentFire || {}).slice(0, 120));
  }

  console.log('\nChat can still run a Claude routine (issue #106)');
  await page.click('#hx-new');
  await page.waitForSelector('#chat-instance', { timeout: 8000 }).catch(() => {});
  const opts = await page.locator('#chat-instance option').allTextContents();
  check('the composer lists the Claude instance too', opts.some((o) => /Claude/.test(o)), opts.join(' | '));
  if (opts.some((o) => /Claude/.test(o))) {
    await page.selectOption('#chat-instance', 'sparks9679|t_c');
    await page.waitForTimeout(200);
    // A Claude session picks its own model; offering a picker would be a lie.
    check('…and drops the model picker for it', (await page.locator('#chat-model').count()) === 0);
    await page.fill('#chat-input', 'Process the board and schedule this week.');
    await page.click('#chat-send');
    await page.waitForTimeout(900);
    check('…sending hits the Claude trigger, not the agent function',
      !!claudeFire && /Process the board/.test(claudeFire.text || ''), JSON.stringify(claudeFire || {}).slice(0, 140));
    check('…on the chosen account and trigger',
      claudeFire?.account === 'sparks9679' && claudeFire?.triggerKey === 't_c');
  }

  console.log('\nThe routine drawer (issues #107, #108)');
  await page.click('#newBtn');
  await page.waitForSelector('#f-prompt', { timeout: 8000 });
  /* When above what, so the prompt has the rest of the drawer to grow into and
     the reader is not asked for the paragraph before the time slot. */
  const whenFirst = await page.evaluate(() => {
    const w = document.querySelector('#f-when'), p = document.querySelector('#f-prompt');
    return !!(w && p) && !!(w.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  check('the prompt sits underneath the date and time', whenFirst);

  /* The picker must offer only what the chosen account can run. A Claude
     account used to get the whole catalog, so a routine could be pinned to a
     model claude-trigger.mjs drops at fire time — the card then named a model
     that never ran. Driven through the real account <select>, because the
     narrowing lives in refreshDrawerKind's account-change path. */
  const modelValues = async (acct) => {
    await page.selectOption('#f-account', acct);
    await page.waitForTimeout(200);
    return page.locator('#f-model option').evaluateAll((els) => els.map((e) => e.value));
  };
  const OR_SLUG = /^(deepseek|z-ai|moonshotai|openai|google|x-ai|meta-llama|mistralai|qwen|minimax)\//;
  const claudeVals = await modelValues('sparks9679');
  check('a Claude account offers no OpenRouter model', !claudeVals.some((v) => OR_SLUG.test(v)), claudeVals.join(', '));
  check('…and still offers the Claude ones', claudeVals.includes('claude-sonnet-5'));
  const agentVals = await modelValues('acc_kimi');
  check('an agent account offers no Claude model', !agentVals.some((v) => /^claude-/.test(v)), agentVals.join(', '));
  // Switching back must re-narrow rather than leave the agent list in place —
  // the stale-list case is why this is driven through the real <select>.
  check('…and switching back re-narrows', (await modelValues('sparks9679')).includes('claude-sonnet-5'));

  /* The guard that makes the narrowing safe. Narrowing ALONE would be worse
     than the bug it fixes: a routine pinned to the other executor's model falls
     out of the list, the <select> lands on option zero, and the next save
     rewrites the routine to something nobody chose. So the pin is rescued and
     labelled. This is the exact shape of the "Dark tetrad" row — a DeepSeek
     model sitting on a Claude account. */
  await page.selectOption('#f-account', 'acc_kimi');
  await page.waitForTimeout(200);
  await page.selectOption('#f-model', 'deepseek/deepseek-r1');
  await page.selectOption('#f-account', 'sparks9679');
  await page.waitForTimeout(200);
  check('a pin to the other executor survives the narrowing',
    await page.inputValue('#f-model') === 'deepseek/deepseek-r1', await page.inputValue('#f-model'));
  check('…and the drawer says why it will not run',
    /Won.t run on this account/.test(await page.innerHTML('#f-model')));

  const before = routinePosts.length;
  await page.fill('#f-title', 'Twice-clicked routine');
  await page.fill('#f-prompt', 'Do the thing exactly once.');
  const soon = new Date(Date.now() + 86_400_000);
  const pad = (n) => String(n).padStart(2, '0');
  await page.fill('#f-when', `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T09:00`);
  /* Two clicks inside the insert's round trip — a stray double-tap, or a reader
     pressing again because nothing visibly happened yet. */
  await page.click('[data-do="schedule"]');
  await page.click('[data-do="schedule"]', { force: true }).catch(() => {});
  await page.waitForTimeout(1600);
  check('clicking Schedule twice writes one routine, not two', routinePosts.length - before === 1,
    `${routinePosts.length - before} insert(s)`);
  await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
