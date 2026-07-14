#!/usr/bin/env node
/**
 * Guardrail: ensure chrome/ and firefox/ shared code stay in sync.
 *
 * Compares file contents under both trees, excluding browser-specific
 * manifest.json (service_worker vs scripts).
 *
 * Exit 0 when aligned; exit 1 with a report when diverged.
 *
 *   npm run ext:check
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const chromeDir = path.join(root, 'chrome');
const firefoxDir = path.join(root, 'firefox');

/** Files that are allowed to differ (browser packaging). */
const ALLOW_DIFF = new Set(['manifest.json']);

function listFiles(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name === '.DS_Store') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) listFiles(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function hashFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

if (!fs.existsSync(chromeDir)) {
  console.error('Missing chrome/');
  process.exit(1);
}
if (!fs.existsSync(firefoxDir)) {
  console.error('Missing firefox/ — run npm run ext:sync first');
  process.exit(1);
}

const chromeFiles = new Set(listFiles(chromeDir));
const firefoxFiles = new Set(listFiles(firefoxDir));

const onlyChrome = [...chromeFiles].filter((f) => !firefoxFiles.has(f) && !ALLOW_DIFF.has(f));
const onlyFirefox = [...firefoxFiles].filter((f) => !chromeFiles.has(f) && !ALLOW_DIFF.has(f));
const shared = [...chromeFiles].filter((f) => firefoxFiles.has(f) && !ALLOW_DIFF.has(f));

const contentDiffs = [];
for (const rel of shared.sort()) {
  const a = path.join(chromeDir, rel);
  const b = path.join(firefoxDir, rel);
  if (hashFile(a) !== hashFile(b)) {
    contentDiffs.push(rel);
  }
}

// Versions should match
let versionIssue = null;
try {
  const cv = JSON.parse(fs.readFileSync(path.join(chromeDir, 'manifest.json'), 'utf8')).version;
  const fv = JSON.parse(fs.readFileSync(path.join(firefoxDir, 'manifest.json'), 'utf8')).version;
  if (cv !== fv) {
    versionIssue = `manifest version chrome=${cv} firefox=${fv}`;
  }
} catch (err) {
  versionIssue = `could not read manifests: ${err.message}`;
}

const problems = [];
if (onlyChrome.length) {
  problems.push(`Only in chrome/:\n  - ${onlyChrome.join('\n  - ')}`);
}
if (onlyFirefox.length) {
  problems.push(`Only in firefox/:\n  - ${onlyFirefox.join('\n  - ')}`);
}
if (contentDiffs.length) {
  problems.push(`Content differs:\n  - ${contentDiffs.join('\n  - ')}`);
}
if (versionIssue) {
  problems.push(versionIssue);
}

if (problems.length) {
  console.error('Extension chrome/ ↔ firefox/ are OUT OF SYNC.\n');
  for (const p of problems) console.error(p);
  console.error('\nFix: edit under chrome/, then run: npm run ext:sync');
  process.exit(1);
}

console.log(
  `OK: chrome/ and firefox/ share ${shared.length} files (manifest.json excluded).`
);
if (versionIssue === null) {
  const v = JSON.parse(fs.readFileSync(path.join(chromeDir, 'manifest.json'), 'utf8')).version;
  console.log(`Versions aligned: ${v}`);
}
