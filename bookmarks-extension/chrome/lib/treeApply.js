/**
 * Apply server bookmark list to the local browser tree + payload helpers.
 *
 * Yields to the event loop every `yieldEvery` mutations so MV3 service workers
 * stay responsive on large libraries.
 */

import {
  DIR_TAG,
  encodeFolder,
  decodeFolder,
  isDirEntry,
  itemSignature,
  urlsMatch,
  parentIdForRoot,
  parentDepth,
  msToIso,
  isRootLikeTitle,
} from './folderCodec.js';
import { getRootIds } from './treeCollect.js';
import { debugWarn } from './debugLog.js';

/** Default: yield after this many bookmark API mutations. */
const DEFAULT_YIELD_EVERY = 25;

/**
 * @param {number} ops
 * @param {number} yieldEvery
 */
async function maybeYield(ops, yieldEvery) {
  if (yieldEvery > 0 && ops > 0 && ops % yieldEvery === 0) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * Index of node among its parent's children, or -1.
 * @param {string} parentId
 * @param {string} nodeId
 */
async function siblingIndex(parentId, nodeId) {
  try {
    const kids = await chrome.bookmarks.getChildren(parentId);
    return kids.findIndex((k) => String(k.id) === String(nodeId));
  } catch {
    return -1;
  }
}

/**
 * Move only when parent or index actually differs.
 * Blind re-index on every sync thrashing Firefox's Bookmarks Toolbar order.
 * @param {string} nodeId
 * @param {string} parentId
 * @param {number} desiredIndex
 * @param {{ parentId?: string }} node
 * @returns {Promise<boolean>} true if a move was performed
 */
async function moveIfNeeded(nodeId, parentId, desiredIndex, node) {
  const needsParent = String(node?.parentId) !== String(parentId);
  let idx = -1;
  if (!needsParent) {
    idx = await siblingIndex(parentId, nodeId);
    if (idx === desiredIndex) return false;
  }
  try {
    await chrome.bookmarks.move(nodeId, {
      parentId,
      index: Math.max(0, desiredIndex),
    });
    return true;
  } catch (err) {
    debugWarn('treeApply', 'move with index failed', {
      nodeId,
      parentId,
      desiredIndex,
      err: String(err),
    });
    if (needsParent) {
      try {
        await chrome.bookmarks.move(nodeId, { parentId });
        return true;
      } catch (err2) {
        debugWarn('treeApply', 'move parent-only failed', {
          nodeId,
          parentId,
          err: String(err2),
        });
      }
    }
    return false;
  }
}

/**
 * @param {object[]} localBookmarks
 * @param {object} idMap
 * @param {{
 *   snapshot?: Record<string, { sig: string, updatedAt: string }>,
 *   bumpAll?: boolean,
 *   emitTombstones?: boolean,
 * }} [opts]
 */
export function toServerPayload(localBookmarks, idMap, opts = {}) {
  const snapshot = opts.snapshot || {};
  const bumpAll = opts.bumpAll === true;
  const emitTombstones = opts.emitTombstones !== false;
  const nowIso = new Date().toISOString();
  const localToServer = { ...idMap.localToServer };
  const serverToLocal = { ...idMap.serverToLocal };
  const payload = [];

  for (const b of localBookmarks) {
    let serverId = localToServer[b.localId];
    if (!serverId) {
      serverId = crypto.randomUUID();
      localToServer[b.localId] = serverId;
      serverToLocal[serverId] = b.localId;
    }

    const isFolder = b.kind === 'folder' || (b.tags || []).includes(DIR_TAG);
    const entry = {
      id: serverId,
      title: b.title || (isFolder ? 'Folder' : ''),
      url: isFolder ? '' : b.url || '',
      folder: b.folder || encodeFolder('other', ''),
      tags: isFolder ? [DIR_TAG] : Array.isArray(b.tags) ? b.tags : [],
      notes: '',
      position: Number.isFinite(Number(b.position)) ? Number(b.position) : 0,
      createdAt: msToIso(b.dateAdded),
      deletedAt: null,
      _localId: b.localId,
      _kind: isFolder ? 'folder' : 'url',
    };

    const sig = itemSignature(entry);
    const prev = snapshot[serverId];
    // Only bump updatedAt for real local edits. Missing snapshot entries for *new*
    // local ids still bump (first push). Do not treat minor unknown state as "now"
    // when we already have a previous updatedAt from the id map path — snapshot miss
    // on a previously synced id should still bump once so the server sees the edit.
    const changed = bumpAll || !prev || prev.sig !== sig;
    entry.updatedAt = changed ? nowIso : prev.updatedAt || nowIso;
    entry._changed = changed;
    entry._sig = sig;

    payload.push(entry);
  }

  // Tombstones: ids present in the last successful snapshot but no longer local.
  // These propagate deletes to the server without relying on replace heuristics alone.
  if (emitTombstones) {
    const liveIds = new Set(payload.map((p) => p.id));
    for (const serverId of Object.keys(snapshot)) {
      if (!serverId || liveIds.has(serverId)) continue;
      payload.push({
        id: serverId,
        title: '',
        url: '',
        folder: '',
        tags: [],
        notes: '',
        position: 0,
        deletedAt: nowIso,
        updatedAt: nowIso,
        _tombstone: true,
        _changed: true,
      });
    }
  }

  return {
    payload,
    idMap: { localToServer, serverToLocal },
    knownIds: Object.keys(snapshot),
  };
}

/**
 * Build snapshot from server bookmark list after a successful sync.
 * Active rows only; tombstones are not kept (delete already applied locally).
 */
export function snapshotFromServerBookmarks(serverBookmarks) {
  /** @type {Record<string, { sig: string, updatedAt: string }>} */
  const snap = {};
  for (const b of serverBookmarks || []) {
    if (!b?.id || b.deletedAt) continue;
    snap[b.id] = {
      sig: itemSignature(b),
      updatedAt: b.updatedAt || new Date().toISOString(),
    };
  }
  return snap;
}

/**
 * Remove local nodes mapped to the given server ids (tombstones / remote deletes).
 * @param {string[]} serverIds
 * @param {{ localToServer: object, serverToLocal: object }} idMap
 * @param {number} [yieldEvery]
 * @returns {Promise<{ removed: number, ops: number, idMap: object }>}
 */
export async function removeLocalByServerIds(serverIds, idMap, yieldEvery = DEFAULT_YIELD_EVERY) {
  const localToServer = { ...idMap.localToServer };
  const serverToLocal = { ...idMap.serverToLocal };
  let removed = 0;
  let ops = 0;
  const ids = [...new Set((serverIds || []).filter(Boolean).map(String))];

  for (const serverId of ids) {
    const localId = serverToLocal[serverId];
    if (!localId) continue;
    try {
      const nodes = await chrome.bookmarks.get(localId);
      const n = nodes?.[0];
      if (n && !n.url) {
        await chrome.bookmarks.removeTree(localId);
      } else {
        await chrome.bookmarks.remove(localId);
      }
      removed += 1;
      ops += 1;
    } catch (err) {
      debugWarn('treeApply', 'tombstone remove failed, trying removeTree', {
        localId,
        serverId,
        err: String(err),
      });
      try {
        await chrome.bookmarks.removeTree(localId);
        removed += 1;
        ops += 1;
      } catch (err2) {
        debugWarn('treeApply', 'tombstone removeTree failed', {
          localId,
          serverId,
          err: String(err2),
        });
      }
    }
    delete localToServer[localId];
    if (serverToLocal[serverId] === localId) delete serverToLocal[serverId];
    await maybeYield(ops, yieldEvery);
  }

  return {
    removed,
    ops,
    idMap: { localToServer, serverToLocal },
  };
}

/**
 * Apply server list (folders + urls) preserving mixed order.
 *
 * @param {object[]} serverBookmarks
 * @param {object} idMap
 * @param {{
 *   syncRoot?: string,
 *   removeLocalMissing?: boolean,
 *   protectServerIds?: Iterable<string>,
 *   matchByUrl?: boolean,
 *   yieldEvery?: number,
 * }} options
 * protectServerIds: server ids that must not be removed locally (live server_newer conflicts).
 */
export async function applyServerBookmarks(serverBookmarks, idMap, options = {}) {
  const yieldEvery =
    Number.isFinite(Number(options.yieldEvery)) && Number(options.yieldEvery) > 0
      ? Number(options.yieldEvery)
      : DEFAULT_YIELD_EVERY;
  const matchByUrl = options.matchByUrl !== false;
  const protectServerIds = new Set(
    [...(options.protectServerIds || [])].filter(Boolean).map(String)
  );

  const roots = await getRootIds();
  const defaultRootKind = options.syncRoot === 'toolbar' ? 'toolbar' : 'other';
  const defaultRootId = parentIdForRoot(defaultRootKind, roots, roots.otherId);

  const localToServer = { ...idMap.localToServer };
  const serverToLocal = { ...idMap.serverToLocal };

  const active = (serverBookmarks || []).filter(
    (b) => b && !b.deletedAt && (b.url || isDirEntry(b))
  );

  // Parents before children; then sibling position
  active.sort((a, b) => {
    const da = decodeFolder(a.folder);
    const db = decodeFolder(b.folder);
    if (da.root !== db.root) return da.root.localeCompare(db.root);
    const depthA = parentDepth(a.folder);
    const depthB = parentDepth(b.folder);
    if (depthA !== depthB) return depthA - depthB;
    if (da.path !== db.path) return da.path.localeCompare(db.path);
    const pa = Number(a.position) || 0;
    const pb = Number(b.position) || 0;
    if (pa !== pb) return pa - pb;
    const fa = isDirEntry(a) ? 0 : 1;
    const fb = isDirEntry(b) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });

  const activeServerIds = new Set(active.map((b) => b.id));

  /** @type {Map<string, string>} */
  const pathToLocalId = new Map();
  pathToLocalId.set('toolbar:', roots.toolbarId);
  pathToLocalId.set('other:', roots.otherId);
  if (roots.menuId) pathToLocalId.set('menu:', roots.menuId);
  if (roots.mobileId) pathToLocalId.set('mobile:', roots.mobileId);

  let created = 0;
  let updated = 0;
  let removed = 0;
  let skipped = 0;
  let ops = 0;

  /**
   * Ensure folder path segments exist under a logical root.
   * Never create segments whose title is a browser root label
   * ("Bookmarks bar" / "Bookmarks Toolbar") — map them to the real root instead.
   * @param {string} root
   * @param {string} relativePath
   * @returns {Promise<string>} local parent id
   */
  async function ensurePath(root, relativePath) {
    const parentKey = encodeFolder(root, relativePath);
    if (pathToLocalId.has(parentKey)) return pathToLocalId.get(parentKey);

    let cur = parentIdForRoot(root, roots, defaultRootId);
    let built = '';
    const parts = String(relativePath || '')
      .split('/')
      .filter(Boolean);
    for (const part of parts) {
      // Root-like segment → stay on the managed root (do not nest "Bookmarks bar")
      if (isRootLikeTitle(part)) {
        pathToLocalId.set(encodeFolder(root, built ? `${built}/${part}` : part), cur);
        continue;
      }
      built = built ? `${built}/${part}` : part;
      const k = encodeFolder(root, built);
      if (pathToLocalId.has(k)) {
        cur = pathToLocalId.get(k);
        continue;
      }
      const kids = await chrome.bookmarks.getChildren(cur);
      let folder = kids.find((c) => !c.url && c.title === part);
      if (!folder) {
        folder = await chrome.bookmarks.create({
          parentId: cur,
          title: part,
          index: 0,
        });
        created += 1;
        ops += 1;
        await maybeYield(ops, yieldEvery);
      }
      cur = String(folder.id);
      pathToLocalId.set(k, cur);
    }
    pathToLocalId.set(parentKey, cur);
    return cur;
  }

  // First pass: ensure all directory nodes exist and are mapped
  for (const sb of active) {
    if (!isDirEntry(sb)) continue;

    const { root, path: parentPath } = decodeFolder(sb.folder);

    // Server row that is itself a browser-root label → map path to real root, do not nest.
    // Do NOT put the real toolbar/other id into localToServer (removeLocalMissing would
    // try to delete the browser root).
    if (isRootLikeTitle(sb.title)) {
      const rootId = parentIdForRoot(root, roots, defaultRootId);
      const selfKey = encodeFolder(
        root,
        parentPath ? `${parentPath}/${sb.title}` : sb.title || ''
      );
      pathToLocalId.set(selfKey, rootId);
      skipped += 1;
      continue;
    }

    const parentId = await ensurePath(root, parentPath);

    const desiredIndex = Math.max(0, Number(sb.position) || 0);
    const childPath = parentPath ? `${parentPath}/${sb.title}` : sb.title;
    const selfKey = encodeFolder(root, childPath);

    let node = null;
    const localId = serverToLocal[sb.id];
    if (localId) {
      try {
        node = (await chrome.bookmarks.get(localId))?.[0] || null;
      } catch (err) {
        debugWarn('treeApply', 'get folder by map failed', {
          localId,
          err: String(err),
        });
        node = null;
      }
    }
    if (!node) {
      const kids = await chrome.bookmarks.getChildren(parentId);
      node = kids.find((c) => !c.url && c.title === sb.title) || null;
    }

    if (!node) {
      node = await chrome.bookmarks.create({
        parentId,
        title: sb.title || 'Folder',
        index: desiredIndex,
      });
      created += 1;
      ops += 1;
      await maybeYield(ops, yieldEvery);
    } else {
      const needsTitle = (node.title || '') !== (sb.title || '');
      if (needsTitle) {
        await chrome.bookmarks.update(node.id, { title: sb.title || 'Folder' });
        ops += 1;
      }
      const moved = await moveIfNeeded(node.id, parentId, desiredIndex, node);
      if (moved) ops += 1;
      if (needsTitle || moved) updated += 1;
      else skipped += 1;
      await maybeYield(ops, yieldEvery);
    }

    const idStr = String(node.id);
    localToServer[idStr] = sb.id;
    serverToLocal[sb.id] = idStr;
    pathToLocalId.set(selfKey, idStr);
  }

  // Second pass: URL bookmarks
  for (const sb of active) {
    if (isDirEntry(sb)) continue;
    if (!sb.url) {
      skipped += 1;
      continue;
    }

    const { root, path } = decodeFolder(sb.folder);
    const parentId = await ensurePath(root, path);

    const desiredIndex = Math.max(0, Number(sb.position) || 0);
    let node = null;
    const localId = serverToLocal[sb.id];
    if (localId) {
      try {
        node = (await chrome.bookmarks.get(localId))?.[0] || null;
      } catch (err) {
        debugWarn('treeApply', 'get url by map failed', {
          localId,
          err: String(err),
        });
        node = null;
        delete serverToLocal[sb.id];
        if (localToServer[localId] === sb.id) delete localToServer[localId];
      }
    }

    // Fallback: reuse an existing local sibling with the same URL (avoid duplicates)
    if (!node && matchByUrl && sb.url) {
      try {
        const kids = await chrome.bookmarks.getChildren(parentId);
        const hit = kids.find((c) => c.url && urlsMatch(c.url, sb.url));
        if (hit) {
          node = hit;
          const prevServer = localToServer[String(hit.id)];
          if (prevServer && prevServer !== sb.id && serverToLocal[prevServer] === String(hit.id)) {
            delete serverToLocal[prevServer];
          }
        }
      } catch (err) {
        debugWarn('treeApply', 'url match-by-url scan failed', {
          parentId,
          err: String(err),
        });
      }
    }

    if (!node) {
      node = await chrome.bookmarks.create({
        parentId,
        title: sb.title || sb.url,
        url: sb.url,
        index: desiredIndex,
      });
      created += 1;
      ops += 1;
      await maybeYield(ops, yieldEvery);
    } else {
      const needsUpdate =
        (node.title || '') !== (sb.title || node.title || '') ||
        (node.url || '') !== (sb.url || '');
      if (needsUpdate) {
        await chrome.bookmarks.update(node.id, {
          title: sb.title || sb.url,
          url: sb.url,
        });
        ops += 1;
      }
      const moved = await moveIfNeeded(node.id, parentId, desiredIndex, node);
      if (moved) ops += 1;
      if (needsUpdate || moved) updated += 1;
      else skipped += 1;
      await maybeYield(ops, yieldEvery);
    }

    const idStr = String(node.id);
    localToServer[idStr] = sb.id;
    serverToLocal[sb.id] = idStr;
  }

  if (options.removeLocalMissing) {
    const toRemove = [];
    for (const localId of Object.keys(localToServer)) {
      const serverId = localToServer[localId];
      if (activeServerIds.has(serverId)) continue;
      // Keep local copy when server reported a newer *live* version of this id
      if (protectServerIds.has(String(serverId))) continue;
      toRemove.push(localId);
    }
    for (const localId of toRemove) {
      const serverId = localToServer[localId];
      try {
        const nodes = await chrome.bookmarks.get(localId);
        const n = nodes?.[0];
        if (n && !n.url) {
          await chrome.bookmarks.removeTree(localId);
        } else {
          await chrome.bookmarks.remove(localId);
        }
        removed += 1;
        ops += 1;
      } catch (err) {
        debugWarn('treeApply', 'remove failed, trying removeTree', {
          localId,
          err: String(err),
        });
        try {
          await chrome.bookmarks.removeTree(localId);
          removed += 1;
          ops += 1;
        } catch (err2) {
          debugWarn('treeApply', 'removeTree failed', {
            localId,
            err: String(err2),
          });
        }
      }
      delete localToServer[localId];
      if (serverToLocal[serverId] === localId) delete serverToLocal[serverId];
      await maybeYield(ops, yieldEvery);
    }
  }

  return {
    created,
    updated,
    removed,
    skipped,
    ops,
    idMap: { localToServer, serverToLocal },
  };
}
