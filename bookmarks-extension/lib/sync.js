/**
 * End-to-end sync: local browser tree ↔ bookmarks-sync server.
 *
 * Strategies:
 * - merge: push local (last-write / lastSyncAt) then apply server result
 * - download: pull server only and rewrite local to match
 * - upload: force-push local as source of truth on the server
 */

import { getSettings, getIdMap, saveIdMap, getMeta, saveMeta } from './storage.js';
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
  toServerPayload,
  applyServerBookmarks,
} from './bookmarks.js';

/** Set by background while applying remote changes so change-hooks can ignore noise. */
let suppressLocalChangeHooks = false;

export function setSuppressLocalChangeHooks(value) {
  suppressLocalChangeHooks = Boolean(value);
}

export function isSuppressingLocalChangeHooks() {
  return suppressLocalChangeHooks;
}

/**
 * Test API reachability + auth.
 */
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
 * @param {{ force?: boolean, replace?: boolean, strategy?: string, reason?: string }} [opts]
 */
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

  await saveMeta({ lastSyncStatus: 'running', lastError: null });
  setSuppressLocalChangeHooks(true);

  try {
    let result;
    if (strategy === 'download') {
      result = await runDownloadStrategy(settings);
    } else if (strategy === 'upload') {
      result = await runUploadStrategy(settings, opts);
    } else {
      result = await runMergeStrategy(settings, opts);
    }

    result.strategy = strategy;
    result.reason = opts.reason || 'manual';

    await saveMeta({
      lastSyncAt: result.lastSyncAt,
      lastResult: result,
      lastError: null,
      lastSyncStatus: 'ok',
    });

    return result;
  } catch (err) {
    const message = err?.message || String(err);
    await saveMeta({
      lastSyncStatus: 'error',
      lastError: message,
    });
    throw err;
  } finally {
    // Absorb bookmark events fired by our own writes
    setTimeout(() => setSuppressLocalChangeHooks(false), 2000);
  }
}

/** Recommended: merge local with server (timestamp + lastSyncAt). */
async function runMergeStrategy(settings, opts = {}) {
  const local = await collectLocalBookmarks();
  const idMap = await getIdMap();
  const meta = await getMeta();

  const { payload, idMap: mapAfterPushPrep } = toServerPayload(local, idMap);

  const replace = opts.replace !== false;
  const serverResult = await syncBookmarks(settings, payload, {
    replace,
    force: Boolean(opts.force),
    lastSyncAt: meta.lastSyncAt || null,
  });

  let nextMap = mapAfterPushPrep;
  const apply = await applyServerBookmarks(serverResult.bookmarks || [], nextMap, {
    syncRoot: settings.syncRoot,
    removeLocalMissing: settings.removeLocalMissing !== false,
  });

  nextMap = apply.idMap;
  await saveIdMap(nextMap);

  return buildResult({
    local,
    serverResult,
    apply,
    lastSyncAt: serverResult.lastSyncAt || new Date().toISOString(),
  });
}

/** Server wins: do not push local; apply server list and drop extras. */
async function runDownloadStrategy(settings) {
  const local = await collectLocalBookmarks();
  const idMap = await getIdMap();
  const list = await listBookmarks(settings, { includeDeleted: false });
  const serverBookmarks = list?.bookmarks || [];

  const apply = await applyServerBookmarks(serverBookmarks, idMap, {
    syncRoot: settings.syncRoot,
    removeLocalMissing: true,
  });
  await saveIdMap(apply.idMap);

  const lastSyncAt = new Date().toISOString();
  return {
    at: lastSyncAt,
    localCount: local.length,
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
      removed: apply.removed,
      skipped: apply.skipped,
    },
    lastSyncAt,
    conflicts: [],
  };
}

/** Local wins: force upload + aggressive replace; then align browser to response. */
async function runUploadStrategy(settings, opts = {}) {
  const local = await collectLocalBookmarks();
  const idMap = await getIdMap();
  const { payload, idMap: mapAfterPushPrep } = toServerPayload(local, idMap);

  // force + replace, no lastSyncAt → server membership follows this client fully
  const serverResult = await syncBookmarks(settings, payload, {
    replace: true,
    force: true,
    lastSyncAt: null,
  });

  let nextMap = mapAfterPushPrep;
  // Still apply response so mappings stay consistent; prefer keeping local structure
  const apply = await applyServerBookmarks(serverResult.bookmarks || [], nextMap, {
    syncRoot: settings.syncRoot,
    removeLocalMissing: opts.removeLocalMissing === true,
  });

  nextMap = apply.idMap;
  await saveIdMap(nextMap);

  return buildResult({
    local,
    serverResult,
    apply,
    lastSyncAt: serverResult.lastSyncAt || new Date().toISOString(),
  });
}

function buildResult({ local, serverResult, apply, lastSyncAt }) {
  return {
    at: new Date().toISOString(),
    localCount: local.length,
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
    },
    lastSyncAt,
    conflicts: serverResult.conflicts || [],
  };
}
