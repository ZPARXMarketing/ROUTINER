#!/usr/bin/env node
/* ============================================================
   Regenerate js/vendor/supabase-js.js

   The app used to `import { createClient } from 'https://esm.sh/…'` at the top
   of js/app.js. That made every cold load depend on a third-party CDN *before
   any of our code ran*: two serial round trips (esm.sh resolves the unpinned
   `@2` tag with a short-lived redirect stub, then fetches the real build), and
   if either one was slow or failed the whole module never executed — a blank
   page with no error. "Refresh a few times and it works" was exactly that.

   So the bundle is vendored: one same-origin file, no redirect, no third party.
   This script rebuilds it. It is NOT part of the deploy (the site is static and
   publishes the repo as-is) — run it by hand when bumping supabase-js, then
   commit the result.

     node scripts/vendor-supabase.mjs            # current pinned version
     node scripts/vendor-supabase.mjs 2.112.0    # bump to a specific version

   Requires network access to the npm registry; nothing else.
   ============================================================ */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'js', 'vendor', 'supabase-js.js');

/* Keep in sync with the banner in the generated file. */
const DEFAULT_VERSION = '2.111.0';
const version = process.argv[2] || DEFAULT_VERSION;

const work = mkdtempSync(join(tmpdir(), 'vendor-supabase-'));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: work, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

try {
  console.log(`Bundling @supabase/supabase-js@${version} …`);
  writeFileSync(join(work, 'package.json'), '{"private":true}');
  run('npm', ['install', '--no-audit', '--no-fund', '--silent', `@supabase/supabase-js@${version}`, 'esbuild']);

  /* Only createClient is used by the app — a narrow entry keeps the bundle
     honest about what we actually depend on. */
  writeFileSync(join(work, 'entry.js'), "export { createClient } from '@supabase/supabase-js';\n");
  run(join(work, 'node_modules', '.bin', 'esbuild'), [
    'entry.js', '--bundle', '--format=esm', '--platform=browser',
    '--target=es2020', '--minify', '--legal-comments=none', '--outfile=bundle.js',
  ]);

  const code = readFileSync(join(work, 'bundle.js'), 'utf8');

  /* Guard the two ways a "browser" bundle can still be unusable in a browser. */
  const leftover = code.match(/\bfrom\s*["'][^"']+["']|\brequire\s*\(/);
  if (leftover) throw new Error(`bundle still has an unresolved import: ${leftover[0]}`);
  if (!/export\s*\{[^}]*\bas createClient\b[^}]*\}|export\s*\{\s*createClient\s*\}/.test(code)) {
    throw new Error('bundle does not export createClient');
  }

  const banner = `/* @supabase/supabase-js v${version} — bundled for the browser (ESM, minified).\n`
    + `   Vendored on purpose: boot must not depend on a third-party CDN.\n`
    + `   Do not edit. Regenerate with: node scripts/vendor-supabase.mjs [version]\n`
    + `   Upstream: https://github.com/supabase/supabase-js (MIT) */\n`;

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, banner + code);
  const kb = (statSync(OUT).size / 1024).toFixed(1);
  console.log(`Wrote js/vendor/supabase-js.js (${kb} kB)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
