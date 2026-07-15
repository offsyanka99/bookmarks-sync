#!/usr/bin/env node
/**
 * Build installable extension packages.
 *
 *   npm run ext:pack           # chrome zip + firefox xpi
 *   npm run ext:pack-firefox   # firefox only
 *   npm run ext:pack-chrome    # chrome only
 *
 * Firefox permanent install:
 *   Release Firefox requires a Mozilla-signed XPI (see bookmarks-extension/FIREFOX-INSTALL.md).
 *   Developer Edition / Nightly can install this unsigned XPI after disabling signature checks.
 *
 * The Firefox package uses a fixed extension id (bookmarks-sync@offsyanka99.github.io)
 * so settings survive updates once permanently installed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extRoot, '..');
const distDir = path.join(repoRoot, 'dist');

const arg = process.argv[2] || 'all'; // all | chrome | firefox

function runSyncFirefox() {
  const r = spawnSync(
    process.execPath,
    [path.join(extRoot, 'scripts', 'sync-firefox.mjs')],
    { stdio: 'inherit' }
  );
  if (r.status !== 0) process.exit(r.status || 1);
}

function listFiles(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === '.DS_Store' || name === 'FIREFOX_LOAD.txt') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) listFiles(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

/**
 * Create a zip/xpi with files at archive root (required for extensions).
 * Prefers system `zip`; falls back to a minimal stored-zip writer.
 */
async function zipDirectory(srcDir, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

  const zipBin = spawnSync('zip', ['-r', '-q', outFile, '.'], {
    cwd: srcDir,
    stdio: 'inherit',
  });
  if (zipBin.status === 0) return;

  // Fallback: Node-only ZIP (store only)
  await writeStoreZip(srcDir, outFile);
}

/** Minimal ZIP writer (no compression) — enough for extension packages. */
async function writeStoreZip(srcDir, outFile) {
  const files = listFiles(srcDir);
  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (n) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n, 0);
    return b;
  };
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
  };

  for (const rel of files) {
    const data = fs.readFileSync(path.join(srcDir, rel));
    const name = rel.split(path.sep).join('/'); // zip uses /
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0), // stored
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      data,
    ]);

    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(nameBuf.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBuf,
      ])
    );

    chunks.push(local);
    offset += local.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralBuf.length),
    u32(offset),
    u16(0),
  ]);

  fs.writeFileSync(outFile, Buffer.concat([...chunks, centralBuf, end]));
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return ~c >>> 0;
}

function readChromeManifest() {
  return JSON.parse(
    fs.readFileSync(path.join(extRoot, 'chrome', 'manifest.json'), 'utf8')
  );
}

function validateChromePackage(src) {
  const manifestPath = path.join(src, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('Chrome package missing manifest.json');
    process.exit(1);
  }
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (m.manifest_version !== 3) {
    console.error('Chrome package must be Manifest V3');
    process.exit(1);
  }
  if (!m.background?.service_worker) {
    console.error('Chrome package must use background.service_worker');
    process.exit(1);
  }
  if (m.browser_specific_settings) {
    console.error('Chrome package must not include browser_specific_settings (Firefox-only)');
    process.exit(1);
  }
  // Store requires a 128px icon
  const icon128 = m.icons?.['128'];
  if (!icon128 || !fs.existsSync(path.join(src, icon128))) {
    console.error('Chrome package missing icons.128 PNG');
    process.exit(1);
  }
  // Never ship a private key in the store zip
  if (fs.existsSync(path.join(src, 'key.pem'))) {
    console.error('Refuse to pack: key.pem present in chrome/ (remove before store upload)');
    process.exit(1);
  }
  const desc = String(m.description || '');
  if (desc.length > 132) {
    console.error(`Chrome description too long (${desc.length} > 132 chars)`);
    process.exit(1);
  }
  return m;
}

async function packChrome() {
  // Refresh icons from shared/ before packaging
  const syncIcons = path.join(extRoot, 'scripts', 'sync-firefox.mjs');
  // Only need chrome icons; full ext:sync is fine and keeps trees aligned
  runSyncFirefox();

  const src = path.join(extRoot, 'chrome');
  const m = validateChromePackage(src);
  const version = m.version || '0.0.0';

  const outVersioned = path.join(distDir, `bookmarks-sync-chrome-${version}.zip`);
  const outLatest = path.join(distDir, 'bookmarks-sync-chrome.zip');
  await zipDirectory(src, outVersioned);
  fs.copyFileSync(outVersioned, outLatest);

  // Sanity: zip must have manifest at archive root
  const list = spawnSync('unzip', ['-l', outVersioned], { encoding: 'utf8' });
  if (list.status === 0 && !/manifest\.json/.test(list.stdout)) {
    console.error('Chrome zip appears empty or missing manifest.json at root');
    process.exit(1);
  }
  if (list.status === 0 && /manifest\.json/.test(list.stdout)) {
    const bad = list.stdout
      .split('\n')
      .some((line) => /chrome\/manifest\.json|bookmarks-extension\//.test(line));
    if (bad) {
      console.error('Chrome zip must contain files at archive root (not nested folders)');
      process.exit(1);
    }
  }

  console.log(`Chrome package: ${outVersioned}`);
  console.log(`Chrome package: ${outLatest} (same build)`);
  console.log(`Version:        ${version}`);
  console.log('Upload the .zip to Chrome Web Store (Developer Dashboard).');
  console.log('Guide: bookmarks-extension/CHROME-STORE.md');
  return outVersioned;
}

async function packFirefox() {
  runSyncFirefox();
  const src = path.join(extRoot, 'firefox');
  // Validate fixed id (required for settings to stick across restarts once permanent)
  const manifest = JSON.parse(
    fs.readFileSync(path.join(src, 'manifest.json'), 'utf8')
  );
  const id = manifest?.browser_specific_settings?.gecko?.id;
  if (!id) {
    console.error('Firefox manifest missing browser_specific_settings.gecko.id');
    process.exit(1);
  }
  if (!manifest.background?.scripts) {
    console.error('Firefox manifest must use background.scripts');
    process.exit(1);
  }

  const out = path.join(distDir, 'bookmarks-sync-firefox.xpi');
  await zipDirectory(src, out);
  console.log(`Firefox package: ${out}`);
  console.log(`Extension id:   ${id}`);
  console.log('');
  console.log('Install steps: bookmarks-extension/FIREFOX-INSTALL.md');
  return out;
}

fs.mkdirSync(distDir, { recursive: true });

const jobs = [];
if (arg === 'all' || arg === 'chrome') jobs.push(packChrome());
if (arg === 'all' || arg === 'firefox') jobs.push(packFirefox());

await Promise.all(jobs);
console.log('');
console.log('Done. Packages are in dist/');
