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
  disambiguateFolderPaths,
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
 * Chromium rejects bookmarks.create / bookmarks.move when index is greater
 * than the parent's current child count. The message is "Index out of bounds."
 * An index equal to the child count appends.
 * @param {number} desiredIndex
 * @param {number} childCount
 */
export function clampBookmarkIndex(desiredIndex, childCount) {
  const count = Math.max(0, Number(childCount) || 0);
  const idx = Number(desiredIndex);
  const safe = Number.isFinite(idx) ? Math.max(0, Math.floor(idx)) : 0;
  return Math.min(safe, count);
}

function isIndexError(err) {
  return /index out of bounds/i.test(String(err?.message || err));
}

/**
 * Largest index Chromium will accept for a create under parentId.
 * @param {string} parentId
 * @param {number} desiredIndex
 */
async function clampCreateIndex(parentId, desiredIndex) {
  let count = 0;
  try {
    const kids = await chrome.bookmarks.getChildren(parentId);
    count = kids.length;
  } catch (err) {
    debugWarn('treeApply', 'child count failed', { parentId, err: String(err) });
    return 0;
  }
  return clampBookmarkIndex(desiredIndex, count);
}

/**
 * Create, and if the browser still rejects the index, append.
 * @param {chrome.bookmarks.CreateDetails} details
 */
async function createBookmark(details) {
  try {
    return await chrome.bookmarks.create(details);
  } catch (err) {
    if (details.index == null || !isIndexError(err)) throw err;
    debugWarn('treeApply', 'create index rejected, appending', {
      parentId: details.parentId,
      index: details.index,
      err: String(err),
    });
    const { index, ...rest } = details;
    return chrome.bookmarks.create(rest);
  }
}

/**
 * Move to another parent. Sibling order is applied later, after every child
 * exists. Passing a stored position as `index` during create throws on
 * Chromium: folders are created before urls, so a folder at position 2 is
 * inserted while the parent still has fewer than 2 children. The same
 * happens when positions have gaps.
 * @param {string} nodeId
 * @param {string} parentId
 * @param {{ parentId?: string }} node
 * @returns {Promise<boolean>} true if a move was performed
 */
async function moveToParentIfNeeded(nodeId, parentId, node) {
  if (String(node?.parentId) === String(parentId)) return false;
  try {
    await chrome.bookmarks.move(nodeId, { parentId });
    return true;
  } catch (err) {
    debugWarn('treeApply', 'move parent failed', {
      nodeId,
      parentId,
      err: String(err),
    });
    return false;
  }
}

/**
 * Place orderedIds at indexes 0..n-1. Nodes already in place are left alone
 * so a sync does not reshuffle the toolbar on every run.
 *
 * Only moves a node toward the front (lower index). Chrome and Firefox both
 * treat that index as the final slot. Moving toward the end differs between
 * them, and an index past the live child count is Chromium's
 * "Index out of bounds."
 * @param {string} parentId
 * @param {string[]} orderedIds
 * @param {() => Promise<void>} [onMove]
 * @returns {Promise<number>}
 */
async function orderChildren(parentId, orderedIds, onMove) {
  let kids;
  try {
    kids = await chrome.bookmarks.getChildren(parentId);
  } catch (err) {
    debugWarn('treeApply', 'reorder getChildren failed', {
      parentId,
      err: String(err),
    });
    return 0;
  }
  const ids = kids.map((k) => String(k.id));
  let moves = 0;

  for (let target = 0; target < orderedIds.length; target += 1) {
    const id = String(orderedIds[target]);
    let current = ids.indexOf(id);
    if (current < 0 || current === target) continue;

    // Node sits left of its slot. Park it at the end (index == length is
    // append) so the following move is toward the front.
    if (current < target) {
      const end = ids.length;
      try {
        await chrome.bookmarks.move(id, { parentId, index: end });
      } catch (err) {
        debugWarn('treeApply', 'reorder park failed', {
          id,
          parentId,
          end,
          err: String(err),
        });
        continue;
      }
      ids.splice(current, 1);
      ids.push(id);
      current = ids.length - 1;
      moves += 1;
      if (onMove) await onMove();
      if (current === target) continue;
    }

    try {
      await chrome.bookmarks.move(id, { parentId, index: target });
    } catch (err) {
      debugWarn('treeApply', 'reorder move failed', {
        id,
        parentId,
        target,
        err: String(err),
      });
      continue;
    }
    ids.splice(current, 1);
    ids.splice(Math.min(target, ids.length), 0, id);
    moves += 1;
    if (onMove) await onMove();
  }
  return moves;
}

/**
 * @param {{ localId: string, position: number, folderFirst: number, title: string, serverId: string }[]} items
 * @returns {string[]}
 */
function orderedLocalIds(items) {
  const sorted = [...items].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    if (a.folderFirst !== b.folderFirst) return a.folderFirst - b.folderFirst;
    const title = a.title.localeCompare(b.title);
    if (title) return title;
    return a.serverId.localeCompare(b.serverId);
  });
  const seen = new Set();
  const ids = [];
  for (const item of sorted) {
    if (!item.localId || seen.has(item.localId)) continue;
    seen.add(item.localId);
    ids.push(item.localId);
  }
  return ids;
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
  const localToServer = { ...(idMap?.localToServer || {}) };
  const serverToLocal = { ...(idMap?.serverToLocal || {}) };
  const payload = [];

  for (const b of localBookmarks || []) {
    if (!b?.localId || localToServer[b.localId]) continue;
    const serverId = crypto.randomUUID();
    localToServer[b.localId] = serverId;
    serverToLocal[serverId] = b.localId;
  }

  // Same-titled sibling folders need distinct paths before signatures and merges.
  const prepared = disambiguateFolderPaths(localBookmarks || [], localToServer);

  for (const b of prepared) {
    let serverId = b?.localId ? localToServer[b.localId] : null;
    if (!serverId) {
      serverId = crypto.randomUUID();
      if (b?.localId) {
        localToServer[b.localId] = serverId;
        serverToLocal[serverId] = b.localId;
      }
    }

    const isFolder = b.kind === 'folder' || (b.tags || []).includes(DIR_TAG);
    const prev = snapshot[serverId];
    const tagsKnown = Array.isArray(prev?.tags);
    const tags = tagsKnown
      ? isFolder
        ? [...new Set([DIR_TAG, ...prev.tags])]
        : prev.tags.filter((tag) => tag !== DIR_TAG)
      : isFolder
        ? [DIR_TAG]
        : [];
    const entry = {
      id: serverId,
      title: b.title || (isFolder ? 'Folder' : ''),
      url: isFolder ? '' : b.url || '',
      folder: b.folder || encodeFolder('other', ''),
      tags,
      position: Number.isFinite(Number(b.position)) ? Number(b.position) : 0,
      parentId: b.parentLocalId ? localToServer[b.parentLocalId] || null : null,
      createdAt: msToIso(b.dateAdded),
      deletedAt: null,
      _localId: b.localId,
      _kind: isFolder ? 'folder' : 'url',
    };
    // Echo server-owned fields when we have them. Omitting the key lets a
    // 1.3.2 server keep notes, favicon, and tags this extension does not edit.
    if (typeof prev?.notes === 'string') entry.notes = prev.notes;
    if (prev && Object.prototype.hasOwnProperty.call(prev, 'favicon')) {
      entry.favicon = prev.favicon || null;
    }

    const sig = itemSignature(entry);
    // Only bump updatedAt for real local edits. Missing snapshot entries for *new*
    // local ids still bump (first push). Do not treat minor unknown state as "now"
    // when we already have a previous updatedAt from the id map path — snapshot miss
    // on a previously synced id should still bump once so the server sees the edit.
    const changed = bumpAll || !prev || prev.sig !== sig;
    entry.updatedAt = changed ? nowIso : prev.updatedAt || nowIso;
    entry._changed = changed;
    entry._sig = sig;
    if (!tagsKnown && !isFolder) delete entry.tags;

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
      notes: typeof b.notes === 'string' ? b.notes : '',
      favicon: b.favicon || null,
      tags: Array.isArray(b.tags) ? b.tags : [],
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

  /** @type {Map<string, { localId: string, position: number, folderFirst: number, title: string, serverId: string }[]>} */
  const placements = new Map();

  function notePlacement(parentId, localId, sb) {
    const key = String(parentId);
    if (!placements.has(key)) placements.set(key, []);
    placements.get(key).push({
      localId: String(localId),
      position: Math.max(0, Number(sb.position) || 0),
      folderFirst: isDirEntry(sb) ? 0 : 1,
      title: String(sb.title || ''),
      serverId: String(sb.id || ''),
    });
  }

  async function countMove() {
    ops += 1;
    await maybeYield(ops, yieldEvery);
  }

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

  // First pass: ensure all directory nodes exist and are mapped.
  // One rejected bookmark must not abort the rest of the tree.
  for (const sb of active) {
    if (!isDirEntry(sb)) continue;
    try {
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
      const index = await clampCreateIndex(parentId, desiredIndex);
      node = await createBookmark({
        parentId,
        title: sb.title || 'Folder',
        index,
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
      const moved = await moveToParentIfNeeded(node.id, parentId, node);
      if (moved) ops += 1;
      if (needsTitle || moved) updated += 1;
      else skipped += 1;
      await maybeYield(ops, yieldEvery);
    }

    const idStr = String(node.id);
    localToServer[idStr] = sb.id;
    serverToLocal[sb.id] = idStr;
    pathToLocalId.set(selfKey, idStr);
    notePlacement(parentId, idStr, sb);
    } catch (err) {
      skipped += 1;
      debugWarn('treeApply', 'apply folder failed', {
        id: sb?.id,
        title: sb?.title,
        err: String(err?.message || err),
      });
    }
  }

  // Second pass: URL bookmarks
  for (const sb of active) {
    if (isDirEntry(sb)) continue;
    if (!sb.url) {
      skipped += 1;
      continue;
    }
    try {

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
      const index = await clampCreateIndex(parentId, desiredIndex);
      node = await createBookmark({
        parentId,
        title: sb.title || sb.url,
        url: sb.url,
        index,
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
      const moved = await moveToParentIfNeeded(node.id, parentId, node);
      if (moved) ops += 1;
      if (needsUpdate || moved) updated += 1;
      else skipped += 1;
      await maybeYield(ops, yieldEvery);
    }

    const idStr = String(node.id);
    localToServer[idStr] = sb.id;
    serverToLocal[sb.id] = idStr;
    notePlacement(parentId, idStr, sb);
    } catch (err) {
      skipped += 1;
      debugWarn('treeApply', 'apply bookmark failed', {
        id: sb?.id,
        url: sb?.url,
        err: String(err?.message || err),
      });
    }
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

  // Stored positions are sibling slots, often sparse and mixed with urls.
  // Create clamps them so Chromium does not throw; this pass writes the
  // real order once every child exists.
  for (const [parentId, items] of placements) {
    const moves = await orderChildren(parentId, orderedLocalIds(items), countMove);
    updated += moves;
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
