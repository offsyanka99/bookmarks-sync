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
  decodePath,
  encodePath,
  isDirEntry,
  itemSignature,
  urlsMatch,
  normalizeUrl,
  parentIdForRoot,
  parentDepth,
  msToIso,
  isMenuMirrorTitle,
  MENU_MIRROR_TITLE,
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
      parentId: b.parentLocalId ? localToServer[b.parentLocalId] || null : null,
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
    const liveByFolderUrl = new Map();
    for (const entry of payload) {
      if (!entry.url || entry._kind === 'folder') continue;
      const key = `${entry.folder || ''}\0${normalizeUrl(entry.url)}`;
      if (!liveByFolderUrl.has(key)) liveByFolderUrl.set(key, entry);
    }
    for (const serverId of Object.keys(snapshot)) {
      if (!serverId || liveIds.has(serverId)) continue;
      const prev = snapshot[serverId];
      if (prev && prev.url) {
        const key = `${prev.folder || ''}\0${normalizeUrl(prev.url)}`;
        const live = liveByFolderUrl.get(key);
        // A new local node with the deleted bookmark's folder+url is a re-add.
        // Keep the old server id and do not emit a tombstone.
        if (live && !snapshot[live.id]) {
          const freshId = live.id;
          const localId = live._localId;
          live.id = serverId;
          delete serverToLocal[freshId];
          if (localId) {
            localToServer[localId] = serverId;
            serverToLocal[serverId] = localId;
          }
          liveIds.add(serverId);
          continue;
        }
      }
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
      folder: b.folder || '',
      url: isDirEntry(b) ? '' : b.url || '',
      parentId: b.parentId || null,
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
 * Remove local nodes by browser id (duplicate rows that would share a server id).
 * @param {string[]} localIds
 * @returns {Promise<number>}
 */
export async function removeLocalIds(localIds) {
  let removed = 0;
  for (const localId of [...new Set((localIds || []).filter(Boolean).map(String))]) {
    try {
      const nodes = await chrome.bookmarks.get(localId);
      const node = nodes?.[0];
      if (node && !node.url) await chrome.bookmarks.removeTree(localId);
      else await chrome.bookmarks.remove(localId);
      removed += 1;
    } catch (err) {
      debugWarn('treeApply', 'duplicate remove failed', { localId, err: String(err) });
      try {
        await chrome.bookmarks.removeTree(localId);
        removed += 1;
      } catch (err2) {
        debugWarn('treeApply', 'duplicate removeTree failed', {
          localId,
          err: String(err2),
        });
      }
    }
  }
  return removed;
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

  const byServerId = new Map(active.filter((b) => b?.id).map((b) => [String(b.id), b]));
  const depthMemo = new Map();
  function chainDepth(item) {
    if (!item) return 0;
    const key = item.id ? String(item.id) : '';
    if (key && depthMemo.has(key)) return depthMemo.get(key);
    let depth = 0;
    let current = item;
    const seen = new Set();
    while (current?.parentId && byServerId.has(String(current.parentId)) && !seen.has(current.id)) {
      seen.add(current.id);
      depth += 1;
      current = byServerId.get(String(current.parentId));
    }
    if (!item.parentId) depth = parentDepth(item.folder);
    else if (!byServerId.has(String(item.parentId))) {
      depth = parentDepth(item.folder);
    }
    if (key) depthMemo.set(key, depth);
    return depth;
  }

  // Parents before children; then sibling position
  active.sort((a, b) => {
    const depthA = chainDepth(a);
    const depthB = chainDepth(b);
    if (depthA !== depthB) return depthA - depthB;
    const da = decodeFolder(a.folder);
    const db = decodeFolder(b.folder);
    if (da.root !== db.root) return da.root.localeCompare(db.root);
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

  let menuMirrorId = null;

  /** Browser root, or the Chromium "Bookmarks Menu" folder under Other Bookmarks. */
  async function rootLocalId(kind) {
    if (kind === 'menu') {
      if (roots.menuId) return roots.menuId;
      if (menuMirrorId) return menuMirrorId;
      const kids = await chrome.bookmarks.getChildren(roots.otherId);
      let folder = kids.find((child) => !child.url && isMenuMirrorTitle(child.title));
      if (!folder) {
        folder = await chrome.bookmarks.create({
          parentId: roots.otherId,
          title: MENU_MIRROR_TITLE,
        });
        created += 1;
        ops += 1;
        await maybeYield(ops, yieldEvery);
      }
      menuMirrorId = String(folder.id);
      return menuMirrorId;
    }
    return parentIdForRoot(kind, roots, defaultRootId);
  }

  /**
   * Ensure folder path segments exist under a logical root.
   * Segment text is unescaped, so a title containing "/" stays one folder.
   * @param {string} root
   * @param {string} relativePath
   * @returns {Promise<string>} local parent id
   */
  async function ensurePath(root, relativePath) {
    const parentKey = encodeFolder(root, relativePath);
    if (pathToLocalId.has(parentKey)) return pathToLocalId.get(parentKey);

    let cur = await rootLocalId(root);
    const builtParts = [];
    const parts = decodePath(relativePath);
    for (const part of parts) {
      const segment = part || '(untitled)';
      builtParts.push(segment);
      const k = encodeFolder(root, encodePath(builtParts));
      if (pathToLocalId.has(k)) {
        cur = pathToLocalId.get(k);
        continue;
      }
      const kids = await chrome.bookmarks.getChildren(cur);
      let folder = kids.find((c) => !c.url && c.title === segment);
      if (!folder) {
        folder = await chrome.bookmarks.create({
          parentId: cur,
          title: segment,
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

  async function resolveParent(sb) {
    if (sb?.parentId && serverToLocal[sb.parentId]) return serverToLocal[sb.parentId];
    const { root, path } = decodeFolder(sb?.folder || '');
    return ensurePath(root, path);
  }

  // First pass: ensure all directory nodes exist and are mapped
  for (const sb of active) {
    if (!isDirEntry(sb)) continue;

    const { root, path: parentPath } = decodeFolder(sb.folder);
    const parentId = await resolveParent(sb);

    const desiredIndex = Math.max(0, Number(sb.position) || 0);
    const childParts = decodePath(parentPath);
    childParts.push(sb.title || '(untitled)');
    const selfKey = encodeFolder(root, encodePath(childParts));

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

    const parentId = await resolveParent(sb);

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
