/**
 * End-to-end sync: local browser tree ↔ bookmarks-sync server.
 *
 * Strategies:
 * - merge: push only changed locals (timestamp bump), keep server-newer others, apply result
 * - download: pull server only and rewrite local to match
 * - upload: force-push full local tree as source of truth
 */

import {
  getSettings,
  getIdMap,
  saveIdMap,
  getMeta,
  saveMeta,
  getSyncSnapshot,
  saveSyncSnapshot,
} from './storage.js';
import {
  ensureHostPermission,
  syncBookmarks,
  getHealth,
  getInfo,
  listBookmarks,
  ApiError,
} from './api.js';
import {
  collectLocalBookmarks,
  clearManagedBookmarkRoots,
  toServerPayload,
  applyServerBookmarks,
  snapshotFromServerBookmarks,
} from './bookmarks.js';
import { debugLog } from './debugLog.js';

/** Set by background while applying remote changes so change-hooks can ignore noise. */
let suppressLocalChangeHooks = false;
let suppressUntil = 0;

/** Base suppress after light apply; heavy applies scale up (see suppressMsForApply). */
const SUPPRESS_BASE_MS = 4000;
const SUPPRESS_DOWNLOAD_MS = 20000;
const SUPPRESS_HEAVY_MS = 30000;
const SUPPRESS_HEAVY_OPS = 40;

/**
 * Longer suppress after large tree rewrites so change-based sync does not re-push noise.
 * @param {{ created?: number, updated?: number, removed?: number, ops?: number }|null} apply
 * @param {string} strategy
 */
export function suppressMsForApply(apply, strategy) {
  if (strategy === 'download') return SUPPRESS_DOWNLOAD_MS;
  const ops =
    Number(apply?.ops) ||
    (Number(apply?.created) || 0) +
      (Number(apply?.updated) || 0) +
      (Number(apply?.removed) || 0);
  if (ops >= SUPPRESS_HEAVY_OPS) return SUPPRESS_HEAVY_MS;
  if (ops >= 15) return Math.min(SUPPRESS_HEAVY_MS, SUPPRESS_BASE_MS + ops * 200);
  return SUPPRESS_BASE_MS;
}

export function setSuppressLocalChangeHooks(value, durationMs = SUPPRESS_BASE_MS) {
  suppressLocalChangeHooks = Boolean(value);
  if (value) {
    suppressUntil = Date.now() + durationMs;
  } else {
    suppressUntil = 0;
  }
}

export function isSuppressingLocalChangeHooks() {
  if (suppressLocalChangeHooks) return true;
  if (suppressUntil && Date.now() < suppressUntil) return true;
  return false;
}

/** Cancel pending change-based sync (call from background). */
let cancelChangeBasedSyncFn = null;
export function registerChangeBasedCanceller(fn) {
  cancelChangeBasedSyncFn = fn;
}
export function cancelPendingChangeBasedSync() {
  if (typeof cancelChangeBasedSyncFn === 'function') cancelChangeBasedSyncFn();
}

export async function testConnection() {
  const settings = await getSettings();
  if (!settings.apiBaseUrl) {
    throw new ApiError('Set an API base URL first');
  }

  const granted = await ensureHostPermission(settings.apiBaseUrl);
  if (!granted) {
    throw new ApiError('Host permission was denied for this API URL');
  }

  const health = await getHealth(settings);
  const info = await getInfo(settings);

  let auth = null;
  if (settings.apiKey) {
    const list = await listBookmarks(settings);
    auth = {
      ok: true,
      bookmarkCount: list?.count ?? list?.bookmarks?.length ?? 0,
    };
  }

  return { health, info, auth };
}

/**
 * Build a Floccus-style failsafe message.
 */
export function formatDestructiveMessage({
  side,
  percent,
  wouldRemove,
  total,
  lastSyncAt,
}) {
  const where = side === 'server' ? 'on the server' : 'on this device';
  const pct = Math.round(percent);
  let msg =
    `The current sync run would delete ${pct}% of your bookmarks ${where} ` +
    `(${wouldRemove} of ${total}). Refusing to execute. ` +
    `Disable this failsafe in the extension settings if you want to proceed automatically. ` +
    `If you didn't cause this, use Download to replace this device with the server, ` +
    `or Upload to replace the server with this device.`;
  if (lastSyncAt) {
    try {
      msg += ` | Last synchronized: ${new Date(lastSyncAt).toLocaleString()}`;
    } catch (err) {
      debugLog('sync', 'format lastSyncAt failed', { err: String(err) });
      msg += ` | Last synchronized: ${lastSyncAt}`;
    }
  }
  return msg;
}

function assertLocalDestructiveOk(settings, { localCount, wouldRemove, side, lastSyncAt, confirmDestructive }) {
  if (!settings.destructiveFailsafe || confirmDestructive) return;
  const total = localCount;
  if (total < 10 || wouldRemove <= 0) return;
  const percent = (wouldRemove / total) * 100;
  const threshold = settings.destructiveFailsafePercent || 50;
  if (percent < threshold) return;
  throw new ApiError(
    formatDestructiveMessage({
      side,
      percent,
      wouldRemove,
      total,
      lastSyncAt,
    }),
    {
      code: 'destructive_refused',
      status: 409,
      body: {
        error: 'destructive_refused',
        percent: Math.round(percent),
        wouldDelete: wouldRemove,
        activeCount: total,
        threshold,
        side,
      },
    }
  );
}

export async function runSync(opts = {}) {
  const settings = await getSettings();
  if (!settings.apiBaseUrl || !settings.apiKey) {
    throw new ApiError('Configure API base URL and API key in Settings');
  }

  const granted = await ensureHostPermission(settings.apiBaseUrl);
  if (!granted) {
    throw new ApiError('Host permission was denied for this API URL');
  }

  const strategy = opts.strategy || settings.strategy || 'merge';
  const confirmDestructive = Boolean(opts.confirmDestructive);

  await saveMeta({ lastSyncStatus: 'running', lastError: null });
  cancelPendingChangeBasedSync();
  // Pre-apply suppress; extended after heavy apply below
  let suppressMs = suppressMsForApply(null, strategy);
  setSuppressLocalChangeHooks(true, suppressMs);

  try {
    let result;
    if (strategy === 'download') {
      result = await runDownloadStrategy(settings, { confirmDestructive });
    } else if (strategy === 'upload') {
      result = await runUploadStrategy(settings, { ...opts, confirmDestructive });
    } else {
      result = await runMergeStrategy(settings, { ...opts, confirmDestructive });
    }

    result.strategy = strategy;
    result.reason = opts.reason || 'manual';

    // Persist snapshot so the next merge only bumps timestamps for real local edits
    if (result._snapshot) {
      await saveSyncSnapshot(result._snapshot);
      delete result._snapshot;
    }

    await saveMeta({
      lastSyncAt: result.lastSyncAt,
      lastResult: result,
      lastError: null,
      lastSyncStatus: 'ok',
    });

    // Longer suppress after heavy local rewrites (download / large merge apply)
    suppressMs = suppressMsForApply(result.localApply, strategy);
    debugLog('sync', 'post-apply suppress', { strategy, suppressMs, localApply: result.localApply });
    setSuppressLocalChangeHooks(true, suppressMs);
    cancelPendingChangeBasedSync();

    return result;
  } catch (err) {
    const message = err?.message || String(err);
    await saveMeta({
      lastSyncStatus: 'error',
      lastError: message,
    });
    throw err;
  } finally {
    // Hooks stay suppressed until suppressUntil; clear flag only
    suppressLocalChangeHooks = false;
  }
}

async function runMergeStrategy(settings, opts = {}) {
  const local = await collectLocalBookmarks();
  const idMap = await getIdMap();
  const meta = await getMeta();
  const snapshot = await getSyncSnapshot();

  const mapSize = Object.keys(idMap.localToServer || {}).length;
  // Only bump updatedAt for items whose signature changed vs last successful sync
  const { payload, idMap: mapAfterPushPrep } = toServerPayload(local, idMap, {
    snapshot,
    bumpAll: false,
  });

  const canReplaceSafely =
    Boolean(meta.lastSyncAt) && mapSize > 0 && local.length > 0;
  const replace =
    opts.replace === true
      ? true
      : opts.replace === false
        ? false
        : canReplaceSafely;

  const serverResult = await syncBookmarks(settings, payload, {
    replace,
    force: Boolean(opts.force),
    lastSyncAt: meta.lastSyncAt || null,
    confirmDestructive: Boolean(opts.confirmDestructive),
  });

  let nextMap = mapAfterPushPrep;
  const serverCount = (serverResult.bookmarks || []).length;
  const pushedIds = new Set(payload.map((p) => p.id));
  const serverIds = new Set((serverResult.bookmarks || []).map((b) => b.id));
  // Folder rows have empty url — still on server list
  const pushFullyApplied = [...pushedIds].every((id) => serverIds.has(id));
  const removeLocalMissing =
    settings.removeLocalMissing !== false &&
    serverCount > 0 &&
    canReplaceSafely &&
    pushFullyApplied &&
    (serverResult.conflicts || []).length === 0;

  const apply = await applyServerBookmarks(serverResult.bookmarks || [], nextMap, {
    syncRoot: settings.syncRoot,
    removeLocalMissing,
  });

  nextMap = apply.idMap;
  await saveIdMap(nextMap);

  const result = buildResult({
    local,
    serverResult,
    apply,
    lastSyncAt: serverResult.lastSyncAt || new Date().toISOString(),
  });
  result._snapshot = snapshotFromServerBookmarks(serverResult.bookmarks || []);
  result.localChanged = payload.filter((p) => p._changed).length;
  return result;
}

async function runDownloadStrategy(settings, opts = {}) {
  const localBefore = await collectLocalBookmarks();
  const list = await listBookmarks(settings, { includeDeleted: false });
  const serverBookmarks = list?.bookmarks || [];
  const meta = await getMeta();

  if (serverBookmarks.length === 0 && localBefore.length > 0) {
    throw new ApiError(
      'Download aborted: server has 0 bookmarks but this browser has local ones. ' +
        'Refusing to erase local data. Check the server or use Merge/Upload deliberately.'
    );
  }

  // Failsafe: download wipes all managed local bookmarks first
  const localCount = localBefore.length;
  if (localCount >= 10) {
    assertLocalDestructiveOk(settings, {
      localCount,
      wouldRemove: localCount,
      side: 'local',
      lastSyncAt: meta.lastSyncAt,
      confirmDestructive: Boolean(opts.confirmDestructive),
    });
  }

  // True "replace local with server": wipe managed roots, reset maps, then recreate
  cancelPendingChangeBasedSync();
  const wiped = await clearManagedBookmarkRoots();
  await saveIdMap({ localToServer: {}, serverToLocal: {} });
  await saveSyncSnapshot({});

  const apply = await applyServerBookmarks(
    serverBookmarks,
    { localToServer: {}, serverToLocal: {} },
    {
      syncRoot: settings.syncRoot,
      removeLocalMissing: false, // already wiped
    }
  );
  await saveIdMap(apply.idMap);

  const lastSyncAt = new Date().toISOString();
  return {
    at: lastSyncAt,
    localCount: localBefore.length,
    server: {
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      deleted: 0,
      conflicts: 0,
      count: serverBookmarks.length,
    },
    localApply: {
      created: apply.created,
      updated: apply.updated,
      removed: wiped + apply.removed,
      skipped: apply.skipped,
      ops: (apply.ops || 0) + wiped,
    },
    lastSyncAt,
    conflicts: [],
    _snapshot: snapshotFromServerBookmarks(serverBookmarks),
  };
}

async function runUploadStrategy(settings, opts = {}) {
  const local = await collectLocalBookmarks();
  if (local.length === 0) {
    throw new ApiError(
      'Upload aborted: this browser has 0 bookmarks. Refusing to wipe the server library.'
    );
  }
  const idMap = await getIdMap();
  const { payload, idMap: mapAfterPushPrep } = toServerPayload(local, idMap, {
    bumpAll: true,
  });

  // Upload uses force=true (server failsafe skipped); still pre-check via list when possible
  if (settings.destructiveFailsafe && !opts.confirmDestructive) {
    try {
      const list = await listBookmarks(settings, { includeDeleted: false });
      const serverCount = list?.count ?? list?.bookmarks?.length ?? 0;
      const clientIds = new Set(payload.map((p) => p.id));
      const serverIds = (list?.bookmarks || []).map((b) => b.id);
      const wouldDelete = serverIds.filter((id) => !clientIds.has(id)).length;
      if (serverCount >= 10 && wouldDelete / serverCount >= (settings.destructiveFailsafePercent || 50) / 100) {
        const meta = await getMeta();
        throw new ApiError(
          formatDestructiveMessage({
            side: 'server',
            percent: (wouldDelete / serverCount) * 100,
            wouldRemove: wouldDelete,
            total: serverCount,
            lastSyncAt: meta.lastSyncAt,
          }),
          {
            code: 'destructive_refused',
            status: 409,
            body: {
              error: 'destructive_refused',
              wouldDelete,
              activeCount: serverCount,
              percent: Math.round((wouldDelete / serverCount) * 100),
              side: 'server',
            },
          }
        );
      }
    } catch (err) {
      if (err?.code === 'destructive_refused') throw err;
      debugLog('sync', 'upload pre-check list failed; continuing', {
        err: String(err?.message || err),
      });
    }
  }

  const serverResult = await syncBookmarks(settings, payload, {
    replace: true,
    force: true,
    lastSyncAt: null,
    // force skips server failsafe; confirmDestructive used for client-side check above
    confirmDestructive: Boolean(opts.confirmDestructive),
  });

  let nextMap = mapAfterPushPrep;
  const apply = await applyServerBookmarks(serverResult.bookmarks || [], nextMap, {
    syncRoot: settings.syncRoot,
    removeLocalMissing: opts.removeLocalMissing === true,
  });

  nextMap = apply.idMap;
  await saveIdMap(nextMap);

  const result = buildResult({
    local,
    serverResult,
    apply,
    lastSyncAt: serverResult.lastSyncAt || new Date().toISOString(),
  });
  result._snapshot = snapshotFromServerBookmarks(serverResult.bookmarks || []);
  return result;
}

function buildResult({ local, serverResult, apply, lastSyncAt }) {
  const urlCount = local.filter((b) => b.kind !== 'folder' && b.url).length;
  const folderCount = local.filter(
    (b) => b.kind === 'folder' || (b.tags || []).includes('__dir__')
  ).length;
  return {
    at: new Date().toISOString(),
    localCount: urlCount,
    localFolderCount: folderCount,
    server: {
      created: serverResult.created,
      updated: serverResult.updated,
      unchanged: serverResult.unchanged,
      skipped: serverResult.skipped,
      deleted: serverResult.deleted,
      conflicts: (serverResult.conflicts || []).length,
      count: serverResult.count,
    },
    localApply: {
      created: apply.created,
      updated: apply.updated,
      removed: apply.removed,
      skipped: apply.skipped,
      ops: apply.ops || 0,
    },
    lastSyncAt,
    conflicts: serverResult.conflicts || [],
  };
}
