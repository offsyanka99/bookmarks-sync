#!/usr/bin/env node
/**
 * Sign the Firefox extension via AMO (addons.mozilla.org) using web-ext.
 *
 * Prerequisites:
 *   1. Free AMO developer account
 *   2. JWT credentials: https://addons.mozilla.org/developers/addon/api/key/
 *   3. Export:
 *        export WEB_EXT_API_KEY="user:..."
 *        export WEB_EXT_API_SECRET="..."
 *
 * Usage (from repo root):
 *   npm run ext:sign-firefox              # unlisted channel (default)
 *   npm run ext:sign-firefox -- --listed  # public AMO listing
 *
 * After success:
 *   - Signed XPI lands in dist/
 *   - Stable copy: dist/bookmarks-sync-firefox.xpi
 *   - Versioned:   dist/bookmarks-sync-firefox-<version>.xpi
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extRoot, '..');
const firefoxDir = path.join(extRoot, 'firefox');
const distDir = path.join(repoRoot, 'dist');
const syncScript = path.join(extRoot, 'scripts', 'sync-firefox.mjs');

const listed = process.argv.includes('--listed');
const channel = listed ? 'listed' : 'unlisted';

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
  fail(
    [
      'Missing AMO API credentials.',
      '',
      'Create JWT keys at: https://addons.mozilla.org/developers/addon/api/key/',
      'Then export:',
      '  export WEB_EXT_API_KEY="user:..."',
      '  export WEB_EXT_API_SECRET="..."',
      '',
      'Then re-run: npm run ext:sign-firefox',
    ].join('\n')
  );
}

if (!fs.existsSync(firefoxDir)) {
  fail(`Missing firefox dir: ${firefoxDir}`);
}

// Align chrome → firefox before signing
console.log('Syncing chrome/ → firefox/ …');
const sync = spawnSync(process.execPath, [syncScript], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (sync.status !== 0) fail('ext:sync failed');

const manifest = JSON.parse(
  fs.readFileSync(path.join(firefoxDir, 'manifest.json'), 'utf8')
);
const version = manifest.version || '0.0.0';
const geckoId = manifest?.browser_specific_settings?.gecko?.id;
if (!geckoId) fail('Firefox manifest missing browser_specific_settings.gecko.id');

console.log('');
console.log(`Signing Firefox extension v${version}`);
console.log(`  id:      ${geckoId}`);
console.log(`  channel: ${channel}`);
console.log(`  source:  ${firefoxDir}`);
console.log(`  output:  ${distDir}`);
console.log('');

fs.mkdirSync(distDir, { recursive: true });

// web-ext sign uploads source and returns a Mozilla-signed XPI
const sign = spawnSync(
  'npx',
  [
    '--yes',
    'web-ext@8',
    'sign',
    `--channel=${channel}`,
    `--source-dir=${firefoxDir}`,
    `--artifacts-dir=${distDir}`,
    // Timeout for AMO queue (ms); signing can take several minutes
    '--timeout=900000',
  ],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  }
);

if (sign.status !== 0) {
  fail('web-ext sign failed (see AMO output above).');
}

// Find newest signed xpi in dist (web-ext names vary)
const xpIs = fs
  .readdirSync(distDir)
  .filter((n) => n.endsWith('.xpi'))
  .map((n) => {
    const p = path.join(distDir, n);
    return { name: n, path: p, mtime: fs.statSync(p).mtimeMs };
  })
  .sort((a, b) => b.mtime - a.mtime);

if (!xpIs.length) {
  fail('No .xpi found in dist/ after sign — check web-ext output.');
}

const newest = xpIs[0];
const versioned = path.join(distDir, `bookmarks-sync-firefox-${version}.xpi`);
const stable = path.join(distDir, 'bookmarks-sync-firefox.xpi');

// Prefer renaming the AMO artifact to our stable names when it is the newest
if (path.resolve(newest.path) !== path.resolve(versioned)) {
  fs.copyFileSync(newest.path, versioned);
}
fs.copyFileSync(versioned, stable);

// Confirm META-INF (signed)
const list = spawnSync('unzip', ['-l', versioned], { encoding: 'utf8' });
const signed =
  list.status === 0 && /META-INF\/mozilla\.rsa/.test(list.stdout || '');

console.log('');
console.log('---');
console.log(`Signed package: ${versioned}`);
console.log(`Stable name:    ${stable}`);
console.log(`Mozilla signed: ${signed ? 'yes' : 'UNKNOWN — check META-INF manually'}`);
console.log('');
console.log('Next:');
console.log('  1. Smoke-test: about:addons → Install Add-on From File → versioned .xpi');
console.log('  2. Update FIREFOX-INSTALL.md if needed');
console.log('  3. Commit dist/bookmarks-sync-firefox-*.xpi for distribution');
if (channel === 'unlisted') {
  console.log('  (unlisted: self-distribute the XPI; not on public AMO search)');
} else {
  console.log('  (listed: complete AMO listing / review in the developer hub)');
}
