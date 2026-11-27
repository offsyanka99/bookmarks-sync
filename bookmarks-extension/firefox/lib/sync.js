/**
 * End-to-end sync: local browser tree ↔ bookmarks-sync server.
 *
 * Strategies:
 * - merge: push changed locals + tombstones for local deletes; sticky server deletes;
 *   apply active set and remote tombstones (removeLocalMissing)
 * - download: pull server only and rewrite local to match (Sync now only)
 * - upload: force-push full local tree as source of truth (Sync now only)
 *
 * Startup, schedule, and bookmark-change runs always merge. Download and upload
 * replace a whole side and run only when the user clicks Sync now.
 */

import {
  getSettings,
  getIdMap,
  getMeta,
  saveMeta,
  getSyncSnapshot,
  clearSyncState,
  saveSyncRecords,
} from './storage.js';
import { formatDateTime, normalizeTimeFormat, DEFAULT_TIME_FORMAT } from './formatDateTime.js';
import {
  ensureHostPermission,
  syncBookmarks,
  getHealth,
  getInfo,
  getMe,
  listBookmarks,
  listAllBookmarks,
  ApiError,
} from './api.js';

/**
 * Persist server TIME_FORMAT from GET /info for UI date formatting.
 * @param {object|null|undefined} info
 * @returns {Promise<'12h'|'24h'>}
 */
export async function cacheServerTimeFormat(info) {
  const timeFormat = normalizeTimeFormat(info?.timeFormat);
  await saveMeta({ serverTimeFormat: timeFormat });
  return timeFormat;
}
import {
  collectLocalBookmarks,
  clearManagedBookmarkRoots,
  toServerPayload,
  applyServerBookmarks,
  removeLocalByServerIds,
  removeLocalIds,
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
  await cacheServerTimeFormat(info);

  let auth = null;
  if (settings.apiKey) {
    await reconcileAccount(settings);
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
  timeFormat = DEFAULT_TIME_FORMAT,
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
      msg += ` | Last synchronized: ${formatDateTime(lastSyncAt, lastSyncAt, timeFormat)}`;
    } catch (err) {
      debugLog('sync', 'format lastSyncAt failed', { err: String(err) });
      msg += ` | Last synchronized: ${lastSyncAt}`;
    }
  }
  return msg;
}

function assertLocalDestructiveOk(settings, { localCount, wouldRemove, side, lastSyncAt, confirmDestructive, timeFormat }) {
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
      timeFormat,
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

/**
 * Clear the local sync cursor when the API origin or the account id changes.
 * Regenerating a key for the same user keeps the state.
 */
export async function reconcileAccount(settings) {
  const me = await getMe(settings);
  const meta = await getMeta();
  const server = settings.apiBaseUrl;
  const userChanged = Boolean(meta.accountUserId) && meta.accountUserId !== me.id;
  const serverChanged = Boolean(meta.accountServer) && meta.accountServer !== server;
  if (userChanged || serverChanged) {
    await clearSyncState();
  }
  await saveMeta({ accountUserId: me.id, accountServer: server });
  return me;
}

function jsonBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return JSON.stringify(value).length;
  }
}

const AUTOMATIC_REASONS = new Set(['startup', 'schedule', 'change']);

/**
 * Manual Sync now uses the saved strategy. Automatic runs always merge so a
 * scheduled or change-based sync cannot wipe this browser or the server.
 * @param {string} savedStrategy
 * @param {{ reason?: string, strategy?: string }} [opts]
 * @returns {'merge'|'download'|'upload'}
 */
export function strategyForSync(savedStrategy, opts = {}) {
  const saved = ['merge', 'download', 'upload'].includes(savedStrategy) ? savedStrategy : 'merge';
  if (AUTOMATIC_REASONS.has(opts.reason)) return 'merge';
  if (opts.strategy === 'merge' || opts.strategy === 'download' || opts.strategy === 'upload') {
    return opts.strategy;
  }
  return saved;
}

/**
 * Keep merges and conflicts from every chunk. Bookmark and tombstone lists
 * come from the last response, which is the seq delta for the original cursor.
 * @param {object[]} responses
 */
export function combineSyncResponses(responses) {
  const acc = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    deleted: 0,
    merged: 0,
    merges: [],
    conflicts: [],
    bookmarks: [],
    tombstones: [],
    syncCursor: null,
    serverTime: null,
    lastSyncAt: null,
    fullResync: false,
    count: 0,
  };
  for (const chunk of responses || []) {
    if (!chunk) continue;
    acc.created += Number(chunk.created) || 0;
    acc.updated += Number(chunk.updated) || 0;
    acc.unchanged += Number(chunk.unchanged) || 0;
    acc.skipped += Number(chunk.skipped) || 0;
    acc.deleted += Number(chunk.deleted) || 0;
    acc.merged += Number(chunk.merged) || 0;
    if (Array.isArray(chunk.merges)) acc.merges.push(...chunk.merges);
    if (Array.isArray(chunk.conflicts)) acc.conflicts.push(...chunk.conflicts);
    acc.bookmarks = Array.isArray(chunk.bookmarks) ? chunk.bookmarks : [];
    acc.tombstones = Array.isArray(chunk.tombstones) ? chunk.tombstones : [];
    if (chunk.syncCursor != null) acc.syncCursor = chunk.syncCursor;
    acc.serverTime = chunk.serverTime || chunk.lastSyncAt || acc.serverTime;
    acc.lastSyncAt = chunk.lastSyncAt || chunk.serverTime || acc.lastSyncAt;
    acc.fullResync = Boolean(chunk.fullResync);
    if (chunk.count != null) acc.count = chunk.count;
  }
  return acc;
}

/** Split a payload so each request stays under the server body limit. */
export function chunkSyncItems(items, maxBytes) {
  const budget = Math.max(64 * 1024, Math.floor(Number(maxBytes) * 0.75) || 1048576);
  const chunks = [];
  let current = [];
  let size = 2;
  for (const item of items) {
    const bytes = jsonBytes(item) + 1;
    if (current.length > 0 && size + bytes > budget) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(item);
    size += bytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
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

  const strategy = strategyForSync(settings.strategy, opts);
  const confirmDestructive = Boolean(opts.confirmDestructive);

  await reconcileAccount(settings);
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

    const snapshot = result._snapshot;
    const idMapToSave = result._idMap;
    delete result._snapshot;
    delete result._idMap;
    await saveSyncRecords({
      idMap: idMapToSave,
      syncSnapshot: snapshot,
      meta: {
        lastSyncAt: result.lastSyncAt,
        syncCursor: result.syncCursor ?? null,
        lastResult: result,
        lastError: null,
        lastSyncStatus: 'ok',
      },
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

/**
 * Server ids that still have a *live* newer version — do not remove those locally.
 * server_deleted / tombstone conflicts must NOT protect the local copy.
 * @param {object[]} conflicts
 * @returns {Set<string>}
 */
function protectServerIdsFromConflicts(conflicts) {
  const protect = new Set();
  for (const c of conflicts || []) {
    if (!c || c.reason !== 'server_newer') continue;
    const server = c.server;
    if (server?.deletedAt) continue;
    const id = server?.id || c.id;
    if (id) protect.add(String(id));
  }
  return protect;
}

async function runMergeStrategy(settings, opts = {}) {
  const local = await collectLocalBookmarks();
  const idMap = await getIdMap();
  const meta = await getMeta();
  const snapshot = await getSyncSnapshot();

  const mapSize = Object.keys(idMap.localToServer || {}).length;
  // Only bump updatedAt for items whose signature changed vs last successful sync.
  // Emit tombstones for snapshot ids no longer present locally.
  const {
    payload,
    idMap: mapAfterPushPrep,
  } = toServerPayload(local, idMap, {
    snapshot,
    bumpAll: false,
    emitTombstones: true,
  });

  const livePayload = payload.filter((p) => !p._tombstone && !p.deletedAt);
  const tombstonePayload = payload.filter((p) => p._tombstone || p.deletedAt);
  const changedPayload = payload.filter((p) => p._changed || p._tombstone || p.deletedAt);

  const canReplaceSafely =
    Boolean(meta.syncCursor || meta.lastSyncAt) && mapSize > 0 && local.length > 0;
  const maxBytes = await readMaxSyncBytes(settings);
  const chunks = chunkSyncItems(changedPayload, maxBytes);
  if (chunks.length === 0) chunks.push([]);
  const cursor = Number(meta.syncCursor) > 0 ? Math.floor(Number(meta.syncCursor)) : null;
  const responses = [];
  for (const chunk of chunks) {
    responses.push(
      await syncBookmarks(settings, chunk, {
        replace: false,
        force: Boolean(opts.force),
        lastSyncAt: meta.lastSyncAt || null,
        syncCursor: cursor,
        changesOnly: true,
        pageSize: 400,
        confirmDestructive: Boolean(opts.confirmDestructive),
      })
    );
  }
  const serverResult = combineSyncResponses(responses);

  const overlay = (serverResult.conflicts || [])
    .filter((c) => c?.reason === 'server_newer' && c.server && !c.server.deletedAt)
    .map((c) => c.server);
  const seenIds = new Set((serverResult.bookmarks || []).map((b) => b.id));
  for (const row of overlay) {
    if (row?.id && !seenIds.has(row.id)) serverResult.bookmarks.push(row);
  }

  let nextMap = mapAfterPushPrep;
  const hadCursor = cursor != null;
  const fullSet = !hadCursor || Boolean(serverResult.fullResync);
  const serverCount = (serverResult.bookmarks || []).length;
  const serverIds = new Set((serverResult.bookmarks || []).map((b) => b.id));
  const mergeClientToServer = new Map(
    (serverResult.merges || [])
      .filter((m) => m?.clientId && m?.serverId)
      .map((m) => [String(m.clientId), String(m.serverId)])
  );
  // Ids confirmed deleted on server (sticky delete / returned tombstones)
  const deletedOnServer = new Set(
    (serverResult.tombstones || []).map((t) => t?.id).filter(Boolean).map(String)
  );
  const invalidIds = new Set();
  for (const c of serverResult.conflicts || []) {
    if (c?.reason === 'server_deleted') {
      const id = c.server?.id || c.id;
      if (id) deletedOnServer.add(String(id));
    }
    if (c?.reason === 'invalid' && c.id) invalidIds.add(String(c.id));
  }
  // Live rows should appear on the active server list, or be acknowledged as server-deleted.
  // Account for folder+url merges remapping client UUIDs → existing server ids.
  const sentLive = changedPayload.filter((p) => !p._tombstone && !p.deletedAt);
  const livePushApplied = sentLive.every((p) => {
    const id = String(p.id);
    const resolved = mergeClientToServer.get(id) || id;
    return (
      serverIds.has(resolved) ||
      deletedOnServer.has(resolved) ||
      deletedOnServer.has(id) ||
      invalidIds.has(id)
    );
  });
  const protectServerIds = protectServerIdsFromConflicts(serverResult.conflicts);

  // A delta response is not a full membership list. Reconcile only on a full
  // set (first sync) or when the server asks for a resync after tombstone purge.
  const removeLocalMissing = serverResult.fullResync
    ? settings.removeLocalMissing !== false
    : fullSet &&
      settings.removeLocalMissing !== false &&
      canReplaceSafely &&
      livePushApplied &&
      (serverCount > 0 ||
        tombstonePayload.length > 0 ||
        deletedOnServer.size > 0 ||
        (serverResult.tombstones || []).length > 0);

  const mergedIds = applyServerMerges(nextMap, serverResult.merges);
  nextMap = {
    localToServer: mergedIds.localToServer,
    serverToLocal: mergedIds.serverToLocal,
  };
  if (mergedIds.duplicateLocalIds.length > 0) {
    await removeLocalIds(mergedIds.duplicateLocalIds);
  }

  // Explicit tombstones from the server (soft-deletes since lastSyncAt / this run)
  const remoteTombstoneIds = (serverResult.tombstones || [])
    .map((t) => t?.id)
    .filter(Boolean)
    .filter((id) => !protectServerIds.has(String(id)));
  // A changes-only response omits untouched rows, so absence is not a delete.
  // Drop a sent tombstone locally only when the server kept the delete.
  const echoedTombstones = new Set(
    (serverResult.tombstones || []).map((t) => String(t?.id || '')).filter(Boolean)
  );
  for (const t of tombstonePayload) {
    if (!t?.id || protectServerIds.has(String(t.id))) continue;
    if (echoedTombstones.has(String(t.id))) remoteTombstoneIds.push(t.id);
    else if (fullSet && !serverIds.has(t.id)) remoteTombstoneIds.push(t.id);
  }
  // server_deleted conflicts: server kept the soft-delete — drop local copy
  for (const c of serverResult.conflicts || []) {
    if (c?.reason === 'server_deleted' && (c.server?.id || c.id)) {
      remoteTombstoneIds.push(c.server?.id || c.id);
    }
  }

  let tombstoneRemoved = 0;
  let tombstoneOps = 0;
  if (remoteTombstoneIds.length > 0) {
    const tr = await removeLocalByServerIds(remoteTombstoneIds, nextMap);
    nextMap = tr.idMap;
    tombstoneRemoved = tr.removed;
    tombstoneOps = tr.ops;
  }

  const apply = await applyServerBookmarks(serverResult.bookmarks || [], nextMap, {
    syncRoot: settings.syncRoot,
    removeLocalMissing,
    protectServerIds,
    matchByUrl: settings.matchByUrl !== false,
  });

  nextMap = apply.idMap;
  apply.removed = (apply.removed || 0) + tombstoneRemoved;
  apply.ops = (apply.ops || 0) + tombstoneOps;

  const result = buildResult({
    local,
    serverResult,
    apply,
    lastSyncAt: serverResult.serverTime || serverResult.lastSyncAt || new Date().toISOString(),
  });
  result.syncCursor = serverResult.syncCursor ?? null;
  result._idMap = nextMap;
  result._snapshot = fullSet
    ? snapshotFromServerBookmarks(serverResult.bookmarks || [])
    : mergeSnapshot(snapshot, serverResult.bookmarks, serverResult.tombstones);
  result.localChanged = livePayload.filter((p) => p._changed).length;
  result.tombstonesSent = tombstonePayload.filter((t) => t?.id).length;
  result.server.merged = serverResult.merged || 0;
  result.server.tombstones = (serverResult.tombstones || []).length;
  return result;
}

function mergeSnapshot(previous, serverBookmarks, tombstones) {
  const next = { ...(previous || {}) };
  for (const tomb of tombstones || []) {
    const id = typeof tomb === 'string' ? tomb : tomb?.id;
    if (id) delete next[id];
  }
  Object.assign(next, snapshotFromServerBookmarks(serverBookmarks));
  return next;
}

/**
 * Remap local→server ids when the server merged a client UUID into an existing row.
 * A second local node that would share the kept server id is dropped from the map
 * and returned so the caller can delete that duplicate.
 * @param {{ localToServer: object, serverToLocal: object }} idMap
 * @param {{ clientId: string, serverId: string }[]|undefined} merges
 */
export function applyServerMerges(idMap, merges) {
  const localToServer = { ...(idMap?.localToServer || {}) };
  const serverToLocal = { ...(idMap?.serverToLocal || {}) };
  const duplicateLocalIds = [];
  if (!Array.isArray(merges) || merges.length === 0) {
    return { localToServer, serverToLocal, duplicateLocalIds };
  }

  for (const m of merges) {
    if (!m?.clientId || !m?.serverId || m.clientId === m.serverId) continue;
    const locals = new Set();
    if (serverToLocal[m.clientId]) locals.add(String(serverToLocal[m.clientId]));
    for (const [lid, sid] of Object.entries(localToServer)) {
      if (sid === m.clientId) locals.add(lid);
    }
    const existingLocal = serverToLocal[m.serverId] ? String(serverToLocal[m.serverId]) : null;
    if (existingLocal && [...locals].some((lid) => lid !== existingLocal)) {
      for (const lid of locals) {
        if (lid === existingLocal) continue;
        duplicateLocalIds.push(lid);
        delete localToServer[lid];
      }
      delete serverToLocal[m.clientId];
      continue;
    }
    for (const lid of locals) {
      localToServer[lid] = m.serverId;
      serverToLocal[m.serverId] = lid;
    }
    delete serverToLocal[m.clientId];
  }

  return { localToServer, serverToLocal, duplicateLocalIds };
}

async function runDownloadStrategy(settings, opts = {}) {
  const localBefore = await collectLocalBookmarks();
  const list = await listAllBookmarks(settings);
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
      timeFormat: meta.serverTimeFormat,
    });
  }

  // True "replace local with server": wipe managed roots, reset maps, then recreate.
  // Clear the cursor in the same write as the empty map. A failed apply used to
  // leave an empty map with the old cursor, so the next merge uploaded leftovers
  // and asked only for a delta.
  cancelPendingChangeBasedSync();
  await saveSyncRecords({
    idMap: { localToServer: {}, serverToLocal: {} },
    syncSnapshot: {},
    meta: { syncCursor: null, lastSyncAt: null },
  });
  const wiped = await clearManagedBookmarkRoots();

  const apply = await applyServerBookmarks(
    serverBookmarks,
    { localToServer: {}, serverToLocal: {} },
    {
      syncRoot: settings.syncRoot,
      removeLocalMissing: false, // already wiped
      matchByUrl: false, // clean tree; no local siblings to match
    }
  );
  const lastSyncAt = list?.serverTime || new Date().toISOString();
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
    syncCursor: list?.syncCursor ?? null,
    conflicts: [],
    _idMap: apply.idMap,
    _snapshot: snapshotFromServerBookmarks(serverBookmarks),
  };
}

async function readMaxSyncBytes(settings) {
  let maxBytes = 1048576;
  try {
    const info = await getInfo(settings);
    if (Number(info?.maxSyncSizeBytes) > 0) maxBytes = Number(info.maxSyncSizeBytes);
  } catch (err) {
    debugLog('sync', 'info size limit unavailable', { err: String(err?.message || err) });
  }
  return maxBytes;
}

/**
 * One request uses replace+force. A library over the body limit is upserted in
 * chunks, then server rows that are not in the local tree are tombstoned.
 * @param {object} settings
 * @param {object[]} payload
 * @param {{ maxBytes: number, confirmDestructive?: boolean, knownIds?: string[]|null }} opts
 */
async function pushUpload(settings, payload, opts) {
  const chunks = chunkSyncItems(payload, opts.maxBytes);
  if (chunks.length <= 1) {
    return syncBookmarks(settings, payload, {
      replace: true,
      force: true,
      lastSyncAt: null,
      pageSize: 400,
      confirmDestructive: Boolean(opts.confirmDestructive),
      knownIds: opts.knownIds || null,
    });
  }

  let cursor = null;
  try {
    const head = await listBookmarks(settings, { pageSize: 1 });
    if (Number(head?.syncCursor) > 0) cursor = Math.floor(Number(head.syncCursor));
  } catch (err) {
    debugLog('sync', 'upload cursor unavailable', { err: String(err?.message || err) });
  }

  const responses = [];
  for (const chunk of chunks) {
    const response = await syncBookmarks(settings, chunk, {
      replace: false,
      force: true,
      changesOnly: true,
      syncCursor: cursor,
      lastSyncAt: null,
      pageSize: 400,
      confirmDestructive: Boolean(opts.confirmDestructive),
    });
    responses.push(response);
    if (response?.syncCursor != null) cursor = response.syncCursor;
  }

  const combined = combineSyncResponses(responses);
  const mergeClientToServer = new Map(
    (combined.merges || [])
      .filter((m) => m?.clientId && m?.serverId)
      .map((m) => [String(m.clientId), String(m.serverId)])
  );
  const kept = new Set();
  for (const row of payload) {
    if (!row?.id || row.deletedAt || row._tombstone) continue;
    kept.add(mergeClientToServer.get(String(row.id)) || String(row.id));
  }

  const listed = await listAllBookmarks(settings);
  const now = new Date().toISOString();
  const tombs = (listed?.bookmarks || [])
    .filter((row) => row?.id && !kept.has(String(row.id)))
    .map((row) => ({
      id: String(row.id),
      deletedAt: now,
      updatedAt: now,
    }));
  for (const chunk of chunkSyncItems(tombs, opts.maxBytes)) {
    const response = await syncBookmarks(settings, chunk, {
      replace: false,
      force: true,
      changesOnly: true,
      syncCursor: cursor,
      pageSize: 400,
      confirmDestructive: Boolean(opts.confirmDestructive),
    });
    responses.push(response);
    if (response?.syncCursor != null) cursor = response.syncCursor;
  }

  const finalList = await listAllBookmarks(settings);
  const result = combineSyncResponses(responses);
  result.bookmarks = finalList?.bookmarks || [];
  result.tombstones = [];
  result.syncCursor = finalList?.syncCursor ?? result.syncCursor;
  result.serverTime = finalList?.serverTime || result.serverTime;
  result.lastSyncAt = result.serverTime;
  result.count = result.bookmarks.length;
  return result;
}

async function runUploadStrategy(settings, opts = {}) {
  const local = await collectLocalBookmarks();
  if (local.length === 0) {
    throw new ApiError(
      'Upload aborted: this browser has 0 bookmarks. Refusing to wipe the server library.'
    );
  }
  const idMap = await getIdMap();
  // Upload is a full live-tree replace; no tombstones (force wipe handles membership).
  const { payload, idMap: mapAfterPushPrep, knownIds } = toServerPayload(local, idMap, {
    bumpAll: true,
    emitTombstones: false,
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
            timeFormat: meta.serverTimeFormat,
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
      throw new ApiError(
        `Upload aborted: could not read the server library to check how many bookmarks would be deleted. ${err?.message || err}`
      );
    }
  }

  const maxBytes = await readMaxSyncBytes(settings);
  const serverResult = await pushUpload(settings, payload, {
    maxBytes,
    confirmDestructive: Boolean(opts.confirmDestructive),
    knownIds: knownIds || null,
  });

  const mergedIds = applyServerMerges(mapAfterPushPrep, serverResult.merges);
  let nextMap = {
    localToServer: mergedIds.localToServer,
    serverToLocal: mergedIds.serverToLocal,
  };
  if (mergedIds.duplicateLocalIds.length > 0) {
    await removeLocalIds(mergedIds.duplicateLocalIds);
  }
  const apply = await applyServerBookmarks(serverResult.bookmarks || [], nextMap, {
    syncRoot: settings.syncRoot,
    removeLocalMissing: opts.removeLocalMissing === true,
    matchByUrl: settings.matchByUrl !== false,
  });

  nextMap = apply.idMap;

  const result = buildResult({
    local,
    serverResult,
    apply,
    lastSyncAt: serverResult.serverTime || serverResult.lastSyncAt || new Date().toISOString(),
  });
  result.syncCursor = serverResult.syncCursor ?? null;
  result._idMap = nextMap;
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
      merged: serverResult.merged || 0,
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
    merges: serverResult.merges || [],
  };
}
