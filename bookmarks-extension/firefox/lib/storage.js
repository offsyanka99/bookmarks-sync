/** chrome.storage helpers for settings, id maps, and sync meta. */

/** @typedef {'merge' | 'download' | 'upload'} SyncStrategy */

const DEFAULT_SETTINGS = {
  apiBaseUrl: 'http://127.0.0.1:31059',
  apiKey: '',

  // --- Sync behaviour ---
  /** Sync shortly after local bookmark create/change/move/remove */
  syncOnChange: false,
  /** Sync once when the browser profile starts */
  syncOnStartup: false,
  /** Schedule periodic syncs */
  timeBasedSync: false,
  /** Minutes between time-based syncs (used when timeBasedSync is true). Default 15. */
  syncIntervalMinutes: 15,

  /**
   * Synchronization strategy:
   * - merge: keep compatible changes from local + other browsers (recommended)
   * - download: undo local, apply server
   * - upload: push local, overwrite server
   * @type {SyncStrategy}
   */
  strategy: 'merge',

  /**
   * Where reconstructed server folders live for *new* items:
   * - "toolbar" → Bookmarks Bar
   * - "other" → Other Bookmarks
   */
  syncRoot: 'other',
  /** Soft-delete local bookmarks removed on the server (merge/download) */
  removeLocalMissing: true,

  /**
   * Refuse syncs that would remove more than failsafePercent of bookmarks
   * (server or local). Manual sync can override after confirmation.
   */
  destructiveFailsafe: true,
  /** 1–100; default 50 */
  destructiveFailsafePercent: 50,

  /**
   * When applying server bookmarks, if idMap misses, reuse a local sibling
   * with the same URL under the same parent instead of creating a duplicate.
   * Recommended on (Floccus-style).
   */
  matchByUrl: true,

  /**
   * @deprecated prefer timeBasedSync + syncIntervalMinutes; still read for migration
   */
  autoSyncMinutes: 0,
};

const STRATEGIES = new Set(['merge', 'download', 'upload']);

/**
 * Normalize + migrate settings (e.g. old autoSyncMinutes → timeBasedSync).
 * @param {Partial<typeof DEFAULT_SETTINGS>} raw
 */
export function normalizeSettings(raw = {}) {
  const next = { ...DEFAULT_SETTINGS, ...raw };

  // Migrate legacy autoSyncMinutes if new flags never set
  if (
    raw.timeBasedSync === undefined &&
    Number(raw.autoSyncMinutes) > 0
  ) {
    next.timeBasedSync = true;
    next.syncIntervalMinutes = Math.max(1, Number(raw.autoSyncMinutes) || 15);
  }

  next.apiBaseUrl =
    typeof next.apiBaseUrl === 'string'
      ? next.apiBaseUrl.trim().replace(/\/+$/, '')
      : DEFAULT_SETTINGS.apiBaseUrl;
  next.apiKey = typeof next.apiKey === 'string' ? next.apiKey.trim() : '';

  next.syncOnChange = Boolean(next.syncOnChange);
  next.syncOnStartup = Boolean(next.syncOnStartup);
  next.timeBasedSync = Boolean(next.timeBasedSync);

  let interval = Number(next.syncIntervalMinutes);
  if (!Number.isFinite(interval) || interval < 1) interval = 15;
  next.syncIntervalMinutes = Math.min(24 * 60, Math.floor(interval));

  if (!STRATEGIES.has(next.strategy)) {
    next.strategy = 'merge';
  }

  next.syncRoot = next.syncRoot === 'toolbar' ? 'toolbar' : 'other';
  next.removeLocalMissing = next.removeLocalMissing !== false;
  next.destructiveFailsafe = next.destructiveFailsafe !== false;
  let pct = Number(next.destructiveFailsafePercent);
  if (!Number.isFinite(pct) || pct < 1) pct = 50;
  if (pct > 100) pct = 100;
  next.destructiveFailsafePercent = Math.floor(pct);

  next.matchByUrl = next.matchByUrl !== false;

  // Keep autoSyncMinutes aligned for any old UI/code paths
  next.autoSyncMinutes = next.timeBasedSync ? next.syncIntervalMinutes : 0;

  return next;
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get({ settings: DEFAULT_SETTINGS });
  return normalizeSettings(settings || {});
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...partial });
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getIdMap() {
  const { idMap } = await chrome.storage.local.get({
    idMap: { localToServer: {}, serverToLocal: {} },
  });
  return {
    localToServer: { ...(idMap?.localToServer || {}) },
    serverToLocal: { ...(idMap?.serverToLocal || {}) },
  };
}

export async function saveIdMap(idMap) {
  await chrome.storage.local.set({
    idMap: {
      localToServer: idMap.localToServer || {},
      serverToLocal: idMap.serverToLocal || {},
    },
  });
}

export async function getMeta() {
  const { meta } = await chrome.storage.local.get({
    meta: {
      lastSyncAt: null,
      lastResult: null,
      lastError: null,
      lastSyncStatus: 'never',
      /** Cached from GET /info timeFormat ('12h' | '24h') */
      serverTimeFormat: '24h',
    },
  });
  return meta || {};
}

export async function saveMeta(partial) {
  const current = await getMeta();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ meta: next });
  return next;
}

/**
 * Last successful sync snapshot: serverId → { sig, updatedAt }
 * Used so merge only bumps updatedAt for items that actually changed locally
 * (avoids one browser overwriting another's order on every sync).
 */
export async function getSyncSnapshot() {
  const { syncSnapshot } = await chrome.storage.local.get({ syncSnapshot: {} });
  return syncSnapshot && typeof syncSnapshot === 'object' ? syncSnapshot : {};
}

export async function saveSyncSnapshot(snapshot) {
  await chrome.storage.local.set({ syncSnapshot: snapshot || {} });
  return snapshot;
}

export { DEFAULT_SETTINGS, STRATEGIES };
