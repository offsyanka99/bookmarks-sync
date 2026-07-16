/**
 * Folder path encoding and directory-row helpers.
 *
 * Server `folder` string = parent location:
 *   "toolbar:" | "toolbar:Work" | "other:..." | "menu:..." | "mobile:..."
 * Directory rows: tags include DIR_TAG, url "".
 */

export const DIR_TAG = '__dir__';

export const ROOT_TITLES = new Set([
  'Bookmarks bar',
  'Bookmarks Bar',
  'Bookmarks Toolbar',
  'Bookmarks toolbar',
  'Other bookmarks',
  'Other Bookmarks',
  'Bookmarks Menu',
  'Bookmarks menu',
  'Mobile bookmarks',
  'Mobile Bookmarks',
  'All Bookmarks',
  'All bookmarks',
]);

export const FIREFOX_TOOLBAR_IDS = new Set(['toolbar_____']);
export const FIREFOX_OTHER_IDS = new Set(['unfiled_____']);
export const FIREFOX_MENU_IDS = new Set(['menu________']);
export const FIREFOX_MOBILE_IDS = new Set(['mobile______']);
export const ROOT_KINDS = new Set(['toolbar', 'other', 'menu', 'mobile']);

export function encodeFolder(root, relativePath) {
  const r = ROOT_KINDS.has(root) ? root : 'other';
  const p = String(relativePath || '').replace(/^\/+|\/+$/g, '');
  return `${r}:${p}`;
}

export function decodeFolder(folder) {
  const s = String(folder ?? '');
  const m = /^(toolbar|other|menu|mobile):(.*)$/s.exec(s);
  if (m) return { root: m[1], path: m[2] || '' };
  return { root: 'other', path: s };
}

export function isDirEntry(b) {
  if (!b) return false;
  const tags = Array.isArray(b.tags) ? b.tags : [];
  if (tags.includes(DIR_TAG)) return true;
  if (typeof b.url === 'string' && b.url.startsWith('folder:')) return true;
  return false;
}

export function itemSignature(b) {
  const tags = Array.isArray(b.tags) ? [...b.tags].sort().join(',') : '';
  return [
    b.folder || '',
    Number(b.position) || 0,
    b.title || '',
    b.url || '',
    tags,
    b.deletedAt || '',
  ].join('\0');
}

/**
 * Normalize URL for same-folder duplicate matching (aligns with server normalizeUrl).
 * @param {string|null|undefined} url
 * @returns {string}
 */
export function normalizeUrl(url) {
  if (url == null) return '';
  const raw = String(url).trim();
  if (!raw) return '';
  try {
    return new URL(raw).href;
  } catch {
    return raw;
  }
}

/**
 * True when two bookmark URLs should be treated as the same target.
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 */
export function urlsMatch(a, b) {
  const na = normalizeUrl(a);
  const nb = normalizeUrl(b);
  if (!na || !nb) return false;
  return na === nb;
}

export function classifyRootNode(node) {
  if (!node) return null;
  const id = String(node.id);
  const t = (node.title || '').toLowerCase();
  if (
    FIREFOX_TOOLBAR_IDS.has(id) ||
    t.includes('toolbar') ||
    (t.includes('bookmark') && t.includes('bar'))
  ) {
    return 'toolbar';
  }
  if (FIREFOX_OTHER_IDS.has(id) || t.includes('other') || t.includes('unfiled')) {
    return 'other';
  }
  if (FIREFOX_MENU_IDS.has(id) || (t.includes('menu') && t.includes('bookmark'))) {
    return 'menu';
  }
  if (FIREFOX_MOBILE_IDS.has(id) || t.includes('mobile')) {
    return 'mobile';
  }
  return null;
}

export function parentIdForRoot(kind, roots, fallbackId) {
  if (kind === 'toolbar') return roots.toolbarId;
  if (kind === 'menu' && roots.menuId) return roots.menuId;
  if (kind === 'mobile' && roots.mobileId) return roots.mobileId;
  if (kind === 'other') return roots.otherId;
  return fallbackId;
}

export function parentDepth(folder) {
  const { path } = decodeFolder(folder);
  if (!path) return 0;
  return path.split('/').filter(Boolean).length;
}

export function msToIso(ms) {
  if (!ms || !Number.isFinite(Number(ms))) return new Date().toISOString();
  return new Date(Number(ms)).toISOString();
}
