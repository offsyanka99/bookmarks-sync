#!/usr/bin/env node
/**
 * Prepare Chrome + Firefox packages for store review (Google / Mozilla).
 *
 * From repo root:
 *   npm run ext:prepare-store
 *
 * Does not sign for AMO (needs WEB_EXT_API_KEY / WEB_EXT_API_SECRET).
 * After this script: upload Chrome ZIP; run npm run ext:sign-firefox for Mozilla.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extRoot, '..');
const distDir = path.join(repoRoot, 'dist');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: opts.capture ? 'pipe' : 'inherit',
    ...opts,
  });
  if (r.status !== 0) {
    if (opts.capture && r.stderr) console.error(r.stderr);
    if (opts.capture && r.stdout) console.error(r.stdout);
    process.exit(r.status || 1);
  }
  return r;
}

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`✓ ${msg}`);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

console.log('=== Bookmarks Sync — store package prep ===\n');

// 1. Align trees + pack
run(process.execPath, [path.join(extRoot, 'scripts', 'sync-firefox.mjs')]);
run(process.execPath, [path.join(extRoot, 'scripts', 'check-extension-sync.mjs')]);
run(process.execPath, [path.join(extRoot, 'scripts', 'pack.mjs'), 'all']);

const chromeManifest = readJson(path.join(extRoot, 'chrome', 'manifest.json'));
const firefoxManifest = readJson(path.join(extRoot, 'firefox', 'manifest.json'));
const version = chromeManifest.version;

if (firefoxManifest.version !== version) {
  fail(`Version mismatch: chrome ${version} vs firefox ${firefoxManifest.version}`);
}
ok(`Version aligned: ${version}`);

// 2. Chrome package checks
const chromeZip = path.join(distDir, `bookmarks-sync-chrome-${version}.zip`);
if (!fs.existsSync(chromeZip)) fail(`Missing ${chromeZip}`);
ok(`Chrome ZIP: ${chromeZip}`);

const chromeList = run('unzip', ['-l', chromeZip], { capture: true });
const chromeOut = chromeList.stdout || '';
if (!/manifest\.json/.test(chromeOut)) fail('Chrome ZIP missing manifest.json');
if (/browser_specific_settings/.test(chromeOut)) {
  // content not in listing; check extracted not needed
}
if (/key\.pem|node_modules|\.git\//.test(chromeOut)) {
  fail('Chrome ZIP contains forbidden paths');
}
// manifest at root: lines should include "manifest.json" without a directory prefix in the name field
const chromeNames = chromeOut
  .split('\n')
  .map((l) => l.trim().split(/\s+/).pop())
  .filter(Boolean);
if (!chromeNames.includes('manifest.json')) {
  fail('Chrome ZIP must have manifest.json at archive root');
}
ok('Chrome ZIP structure OK (manifest at root)');

const descLen = String(chromeManifest.description || '').length;
if (descLen > 132) fail(`Chrome description ${descLen} > 132 chars`);
ok(`Chrome description length ${descLen} ≤ 132`);

if (chromeManifest.manifest_version !== 3) fail('Chrome must be MV3');
if (!chromeManifest.background?.service_worker) fail('Chrome needs service_worker');
if (chromeManifest.browser_specific_settings) fail('Chrome must not ship gecko block');
if (!chromeManifest.optional_host_permissions?.length) {
  fail('Chrome should declare optional_host_permissions for user API URL');
}
if (chromeManifest.host_permissions?.length) {
  fail('Chrome should not use required host_permissions (use optional only)');
}
ok('Chrome manifest store-safe');

// 3. Firefox package + lint
const firefoxXpi = path.join(distDir, `bookmarks-sync-firefox-${version}.xpi`);
if (!fs.existsSync(firefoxXpi)) fail(`Missing ${firefoxXpi}`);
ok(`Firefox XPI: ${firefoxXpi}`);

const gecko = firefoxManifest.browser_specific_settings?.gecko;
if (!gecko?.id) fail('Firefox missing gecko.id');
if (gecko.id !== 'bookmarks-sync@offsyanka99.github.io') {
  fail(`Unexpected gecko id: ${gecko.id}`);
}
if (!gecko.data_collection_permissions?.required?.includes('bookmarksInfo')) {
  fail('Firefox missing data_collection_permissions.required bookmarksInfo (AMO)');
}
if (firefoxManifest.host_permissions?.length) {
  fail(
    'Firefox has required host_permissions — remove for AMO (use optional_host_permissions only)'
  );
}
if (!firefoxManifest.optional_host_permissions?.length) {
  fail('Firefox missing optional_host_permissions');
}
ok(`Firefox gecko id + data collection OK (${gecko.id})`);

console.log('\nRunning web-ext lint …');
run('npx', ['--yes', 'web-ext@8', 'lint', '--source-dir', 'bookmarks-extension/firefox']);
ok('web-ext lint: 0 errors');

const ffList = run('unzip', ['-l', firefoxXpi], { capture: true });
const signed = /META-INF\/mozilla\.rsa/.test(ffList.stdout || '');
if (signed) {
  ok('Firefox XPI is Mozilla-signed');
} else {
  console.log('○ Firefox XPI is UNSIGNED (expected until AMO sign)');
}

// 4. Privacy policy present
const privacyMd = path.join(repoRoot, 'docs', 'PRIVACY.md');
const privacyHtml = path.join(repoRoot, 'docs', 'privacy.html');
if (!fs.existsSync(privacyMd)) fail('Missing docs/PRIVACY.md');
if (!fs.existsSync(privacyHtml)) fail('Missing docs/privacy.html');
ok('Privacy policy files present');

// 5. Store assets
const assets = [
  'docs/chrome-store/screenshot-01-options-1280x800.png',
  'docs/chrome-store/screenshot-02-popup-1280x800.png',
  'docs/chrome-store/promo-small-440x280.png',
];
for (const a of assets) {
  if (!fs.existsSync(path.join(repoRoot, a))) fail(`Missing store asset: ${a}`);
}
ok('Chrome store screenshots / promo present');

// Summary
const summaryPath = path.join(distDir, `STORE-SUBMIT-${version}.txt`);
const summary = `
Bookmarks Sync extension — store submission pack
================================================
Version:     ${version}
Prepared:    ${new Date().toISOString()}

CHROME WEB STORE
----------------
Upload ZIP:
  ${chromeZip}
  (or dist/bookmarks-sync-chrome.zip)

Dashboard:
  https://chrome.google.com/webstore/devconsole
  Item ID: ndiehbfpikbmhdgffcfohoeojlmfbpal

Privacy policy URL:
  https://github.com/offsyanka99/bookmarks-sync/blob/main/docs/PRIVACY.md

What's new (paste):
• Multi-browser delete fix: tombstones + sticky soft-deletes
• Toolbar mapping fix: Brave "Bookmarks bar" and Firefox "Bookmarks Toolbar" share toolbar:
• Safer apply: no nested root folders; less order thrashing on Firefox
• Optional host access only — data only goes to the API URL you configure

Single purpose:
  Sync the user’s browser bookmarks with their self-hosted Bookmarks Sync server.

MOZILLA AMO / SIGNED XPI
------------------------
Source dir:  bookmarks-extension/firefox
Unsigned:    ${firefoxXpi}
Gecko id:    ${gecko.id}
Channel:     unlisted (self-distribute) or listed (public AMO)

Sign (needs credentials):
  export WEB_EXT_API_KEY="user:..."
  export WEB_EXT_API_SECRET="..."
  npm run ext:sign-firefox              # unlisted
  npm run ext:sign-firefox -- --listed  # public listing

Confirm signature:
  unzip -l dist/bookmarks-sync-firefox-${version}.xpi | grep META-INF/mozilla.rsa

AMO notes for reviewers (paste):
This extension syncs bookmarks with a server URL the user configures (self-hosted).
It does not send data to the developer. Host access is optional and requested only
for the origin of the API base URL when the user clicks Save or Test connection.
Data collection category: bookmarksInfo (bookmark titles/URLs/folders for sync).
Permissions: bookmarks, storage, alarms, notifications, optional_host_permissions.

Privacy:
  https://github.com/offsyanka99/bookmarks-sync/blob/main/docs/PRIVACY.md
  Homepage: https://github.com/offsyanka99/bookmarks-sync

Docs:
  bookmarks-extension/CHROME-STORE.md
  bookmarks-extension/FIREFOX-INSTALL.md
  bookmarks-extension/STORE-SUBMIT.md
`.trimStart();

fs.writeFileSync(summaryPath, summary);
console.log(`\n${summary}`);
console.log(`\nWrote ${summaryPath}`);
console.log('\n=== Ready for store upload (Chrome) / AMO sign (Firefox) ===\n');
