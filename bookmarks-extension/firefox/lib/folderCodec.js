/**
 * Folder path encoding and directory-row helpers.
 *
 * Server `folder` string = parent location (logical roots, not UI titles):
 *   "toolbar:" | "toolbar:Work" | "other:..." | "menu:..." | "mobile:..."
 *
 * Brave/Chrome label the toolbar "Bookmarks bar"; Firefox uses "Bookmarks Toolbar".
 * Both map to the same logical root `toolbar` via fixed node ids + top-level titles.
 * Directory rows: tags include DIR_TAG, url "".
 */

export const DIR_TAG = '__dir__';

/** Display names of browser roots (EN + common variants). Never create these as nested folders. */
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

/** Firefox well-known root folder ids */
export const FIREFOX_TOOLBAR_IDS = new Set(['toolbar_____']);
export const FIREFOX_OTHER_IDS = new Set(['unfiled_____']);
export const FIREFOX_MENU_IDS = new Set(['menu________']);
export const FIREFOX_MOBILE_IDS = new Set(['mobile______']);

/**
 * Chromium (Chrome/Brave/Edge) well-known root folder ids.
 * https://developer.chrome.com/docs/extensions/reference/api/bookmarks
 */
export const CHROME_TOOLBAR_IDS = new Set(['1']);
export const CHROME_OTHER_IDS = new Set(['2']);
export const CHROME_MOBILE_IDS = new Set(['3']);

export const ROOT_KINDS = new Set(['toolbar', 'other', 'menu', 'mobile']);

/**
 * True when this id is a browser-managed root folder (safe to use anywhere in the tree).
 * @param {string|number|null|undefined} id
 * @returns {boolean}
 */
export function isFixedBrowserRootId(id) {
  const s = String(id ?? '');
  return (
    FIREFOX_TOOLBAR_IDS.has(s) ||
    FIREFOX_OTHER_IDS.has(s) ||
    FIREFOX_MENU_IDS.has(s) ||
    FIREFOX_MOBILE_IDS.has(s) ||
    CHROME_TOOLBAR_IDS.has(s) ||
    CHROME_OTHER_IDS.has(s) ||
    CHROME_MOBILE_IDS.has(s)
  );
}

/**
 * Map a fixed browser root id → logical kind, or null.
 * @param {string|number|null|undefined} id
 * @returns {'toolbar'|'other'|'menu'|'mobile'|null}
 */
export function kindFromFixedRootId(id) {
  const s = String(id ?? '');
  if (FIREFOX_TOOLBAR_IDS.has(s) || CHROME_TOOLBAR_IDS.has(s)) return 'toolbar';
  if (FIREFOX_OTHER_IDS.has(s) || CHROME_OTHER_IDS.has(s)) return 'other';
  if (FIREFOX_MENU_IDS.has(s)) return 'menu';
  if (FIREFOX_MOBILE_IDS.has(s) || CHROME_MOBILE_IDS.has(s)) return 'mobile';
  return null;
}

/**
 * True when a folder title matches a browser root label (any language-ish EN variants).
 * Used to avoid creating nested "Bookmarks bar" / "Bookmarks Toolbar" folders on apply.
 * @param {string|null|undefined} title
 */
export function isRootLikeTitle(title) {
  const raw = String(title || '').trim();
  if (!raw) return false;
  if (ROOT_TITLES.has(raw)) return true;
  const t = raw.toLowerCase();
  // Exact-ish root labels only — do NOT match arbitrary folders containing "other"/"toolbar"
  if (t === 'bookmarks bar' || t === 'bookmarks toolbar' || t === 'bookmark toolbar') {
    return true;
  }
  if (t === 'other bookmarks' || t === 'other bookmark' || t === 'unfiled bookmarks') {
    return true;
  }
  if (t === 'bookmarks menu' || t === 'bookmark menu') return true;
  if (t === 'mobile bookmarks' || t === 'mobile bookmark') return true;
  if (t === 'all bookmarks' || t === 'all bookmark') return true;
  return false;
}

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

/**
 * Classify a node as a browser root kind.
 *
 * IMPORTANT: title matching is only safe for *top-level* children of the tree
 * root (use from getRootIds). Nested user folders must not use title matching —
 * names like "Work toolbar" or "Other projects" used to be mis-classified and
 * re-rooted, which scrambled the Bookmarks Toolbar especially on Firefox.
 *
 * @param {{ id?: string|number, title?: string }|null|undefined} node
 * @param {{ allowTitleMatch?: boolean }} [opts]
 *   allowTitleMatch: default true for backward-compatible top-level use.
 *   Pass false (or rely on fixed ids only) when walking nested folders.
 * @returns {'toolbar'|'other'|'menu'|'mobile'|null}
 */
export function classifyRootNode(node, opts = {}) {
  if (!node) return null;
  const allowTitleMatch = opts.allowTitleMatch !== false;

  const fixed = kindFromFixedRootId(node.id);
  if (fixed) return fixed;

  if (!allowTitleMatch) return null;

  // Top-level only: match common EN root labels (Brave "Bookmarks bar",
  // Firefox "Bookmarks Toolbar", etc.). Prefer exact-ish phrases over includes().
  const t = String(node.title || '')
    .trim()
    .toLowerCase();
  if (!t) return null;

  // Top-level EN labels (Brave "Bookmarks bar", Firefox "Bookmarks Toolbar", …)
  if (
    t === 'bookmarks bar' ||
    t === 'bookmarks toolbar' ||
    t === 'bookmark toolbar' ||
    t === 'bookmark bar'
  ) {
    return 'toolbar';
  }
  if (t === 'other bookmarks' || t === 'other bookmark' || t === 'unfiled bookmarks' || t === 'unfiled') {
    return 'other';
  }
  if (t === 'bookmarks menu' || t === 'bookmark menu') {
    return 'menu';
  }
  if (t === 'mobile bookmarks' || t === 'mobile bookmark') {
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
