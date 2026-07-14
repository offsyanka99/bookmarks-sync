#!/usr/bin/env node
/**
 * Copy shared extension code from chrome/ → firefox/, keep Firefox manifest.
 * Also refresh icons from shared/icons/ (single source of truth).
 *
 * Edit code under chrome/ (source of truth), then run:
 *   npm run ext:sync
 *
 * Load:
 *   Chrome/Brave → bookmarks-extension/chrome/
 *   Firefox      → bookmarks-extension/firefox/
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const repoRoot = path.resolve(root, '..');
const chromeDir = path.join(root, 'chrome');
const firefoxDir = path.join(root, 'firefox');
const sharedIconsDir = path.join(root, 'shared', 'icons');
const firefoxManifestPath = path.join(firefoxDir, 'manifest.json');
const chromeManifestPath = path.join(chromeDir, 'manifest.json');
const packageJsonPath = path.join(repoRoot, 'package.json');

const SKIP_NAMES = new Set(['manifest.json']);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function packageVersion() {
  try {
    return readJson(packageJsonPath).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function chromeVersion() {
  try {
    return readJson(chromeManifestPath).version || packageVersion();
  } catch {
    return packageVersion();
  }
}

function copyRecursive(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (SKIP_NAMES.has(name)) continue;
      copyRecursive(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** Copy shared icons into chrome/icons and firefox/icons (source: shared/icons). */
function syncIconsFromShared() {
  if (!fs.existsSync(sharedIconsDir)) {
    console.warn('Warning: shared/icons/ missing — leaving browser icon folders as-is.');
    return;
  }
  for (const target of [
    path.join(chromeDir, 'icons'),
    path.join(firefoxDir, 'icons'),
  ]) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(sharedIconsDir)) {
      const src = path.join(sharedIconsDir, name);
      if (!fs.statSync(src).isFile()) continue;
      fs.copyFileSync(src, path.join(target, name));
    }
  }
}

/** Firefox-only gecko block (AMO data consent + min version for optional_host_permissions). */
function geckoSettings() {
  return {
    id: 'bookmarks-sync@offsyanka99.github.io',
    // optional_host_permissions needs Firefox 128+; also covers modern MV3 baseline
    strict_min_version: '128.0',
    // Required for new AMO submissions — bookmarks sync to the user's own server
    data_collection_permissions: {
      required: ['bookmarksInfo'],
    },
  };
}

function buildFirefoxManifestFallback(version) {
  return {
    manifest_version: 3,
    name: 'Bookmarks Sync',
    version,
    description:
      'Sync browser bookmarks with your self-hosted bookmarks-sync server.',
    browser_specific_settings: {
      gecko: geckoSettings(),
    },
    icons: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
    action: {
      default_title: 'Bookmarks Sync',
      default_popup: 'popup/popup.html',
      default_icon: {
        16: 'icons/icon16.png',
        32: 'icons/icon32.png',
        48: 'icons/icon48.png',
      },
    },
    options_ui: {
      page: 'options/options.html',
      open_in_tab: true,
    },
    background: {
      scripts: ['background.js'],
      type: 'module',
    },
    permissions: ['bookmarks', 'storage', 'alarms', 'notifications'],
    host_permissions: ['http://*/*', 'https://*/*'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    optional_permissions: ['http://*/*', 'https://*/*'],
  };
}

if (!fs.existsSync(chromeDir)) {
  console.error('Missing chrome/ directory');
  process.exit(1);
}

const version = chromeVersion();

// Preserve Firefox-specific manifest (or build one aligned to chrome version)
let firefoxManifest = null;
if (fs.existsSync(firefoxManifestPath)) {
  firefoxManifest = fs.readFileSync(firefoxManifestPath, 'utf8');
} else {
  firefoxManifest = `${JSON.stringify(buildFirefoxManifestFallback(version), null, 2)}\n`;
}

// Wipe firefox tree then recreate from chrome
fs.rmSync(firefoxDir, { recursive: true, force: true });
fs.mkdirSync(firefoxDir, { recursive: true });
copyRecursive(chromeDir, firefoxDir);
fs.writeFileSync(firefoxManifestPath, firefoxManifest);

// Align version + Firefox background shape
try {
  const chromeManifest = readJson(chromeManifestPath);
  const ff = readJson(firefoxManifestPath);
  if (chromeManifest.version) ff.version = chromeManifest.version;
  else ff.version = version;
  if (chromeManifest.name) ff.name = chromeManifest.name;
  if (chromeManifest.description) ff.description = chromeManifest.description;
  ff.background = {
    scripts: ['background.js'],
    type: 'module',
  };
  delete ff.minimum_chrome_version;
  delete ff.service_worker;
  ff.host_permissions = ['http://*/*', 'https://*/*'];
  ff.optional_host_permissions = ['http://*/*', 'https://*/*'];
  ff.optional_permissions = ['http://*/*', 'https://*/*'];
  // Always re-apply gecko block so AMO-required keys cannot drift
  ff.browser_specific_settings = {
    ...(ff.browser_specific_settings || {}),
    gecko: {
      ...(ff.browser_specific_settings?.gecko || {}),
      ...geckoSettings(),
    },
  };
  fs.writeFileSync(firefoxManifestPath, `${JSON.stringify(ff, null, 2)}\n`);
} catch (err) {
  console.warn('Could not align firefox version:', err.message);
}

// Icons: shared/ is source of truth for both targets
syncIconsFromShared();

console.log(`Synced chrome/ → firefox/ (v${version}; Firefox manifest preserved).`);
console.log('Icons refreshed from shared/icons/.');
console.log('');
console.log('Load unpacked:');
console.log(`  Chrome/Brave: ${chromeDir}`);
console.log(`  Firefox:      ${firefoxDir}`);
