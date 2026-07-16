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
 * @param {object[]} localBookmarks
 * @param {object} idMap
 * @param {{ snapshot?: Record<string, { sig: string, updatedAt: string }>, bumpAll?: boolean }} [opts]
 */
export function toServerPayload(localBookmarks, idMap, opts = {}) {
  const snapshot = opts.snapshot || {};
  const bumpAll = opts.bumpAll === true;
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
    const changed = bumpAll || !prev || prev.sig !== sig;
    entry.updatedAt = changed ? nowIso : prev.updatedAt || nowIso;
    entry._changed = changed;
    entry._sig = sig;

    payload.push(entry);
  }

  return {
    payload,
    idMap: { localToServer, serverToLocal },
  };
}

/**
 * Build snapshot from server bookmark list after a successful sync.
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
 * Apply server list (folders + urls) preserving mixed order.
 *
 * @param {object[]} serverBookmarks
 * @param {object} idMap
 * @param {{
 *   syncRoot?: string,
 *   removeLocalMissing?: boolean,
 *   matchByUrl?: boolean,
 *   yieldEvery?: number,
 * }} options
 */
export async function applyServerBookmarks(serverBookmarks, idMap, options = {}) {
  const yieldEvery =
    Number.isFinite(Number(options.yieldEvery)) && Number(options.yieldEvery) > 0
      ? Number(options.yieldEvery)
      : DEFAULT_YIELD_EVERY;
  const matchByUrl = options.matchByUrl !== false;

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

  // First pass: ensure all directory nodes exist and are mapped
  for (const sb of active) {
    if (!isDirEntry(sb)) continue;

    const { root, path: parentPath } = decodeFolder(sb.folder);
    const parentKey = encodeFolder(root, parentPath);
    let parentId = pathToLocalId.get(parentKey);
    if (!parentId) {
      parentId = parentIdForRoot(root, roots, defaultRootId);
      const parts = parentPath.split('/').filter(Boolean);
      let cur = parentIdForRoot(root, roots, defaultRootId);
      let built = '';
      for (const part of parts) {
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
      parentId = cur;
      pathToLocalId.set(parentKey, cur);
    }

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
      const needsMove = String(node.parentId) !== String(parentId);
      if (needsTitle) {
        await chrome.bookmarks.update(node.id, { title: sb.title || 'Folder' });
        ops += 1;
      }
      try {
        await chrome.bookmarks.move(node.id, { parentId, index: desiredIndex });
        ops += 1;
      } catch (err) {
        debugWarn('treeApply', 'folder move with index failed', {
          id: node.id,
          err: String(err),
        });
        if (needsMove) {
          try {
            await chrome.bookmarks.move(node.id, { parentId });
            ops += 1;
          } catch (err2) {
            debugWarn('treeApply', 'folder move failed', {
              id: node.id,
              err: String(err2),
            });
          }
        }
      }
      if (needsTitle || needsMove) updated += 1;
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
    let parentId = pathToLocalId.get(encodeFolder(root, path));
    if (!parentId) {
      const rootId = parentIdForRoot(root, roots, defaultRootId);
      const parts = path.split('/').filter(Boolean);
      let cur = rootId;
      let built = '';
      for (const part of parts) {
        built = built ? `${built}/${part}` : part;
        const k = encodeFolder(root, built);
        if (pathToLocalId.has(k)) {
          cur = pathToLocalId.get(k);
          continue;
        }
        const kids = await chrome.bookmarks.getChildren(cur);
        let folder = kids.find((c) => !c.url && c.title === part);
        if (!folder) {
          folder = await chrome.bookmarks.create({ parentId: cur, title: part });
          ops += 1;
          await maybeYield(ops, yieldEvery);
        }
        cur = String(folder.id);
        pathToLocalId.set(k, cur);
      }
      parentId = cur;
      pathToLocalId.set(encodeFolder(root, path), cur);
    }

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
      const needsMove = String(node.parentId) !== String(parentId);
      if (needsUpdate) {
        await chrome.bookmarks.update(node.id, {
          title: sb.title || sb.url,
          url: sb.url,
        });
        ops += 1;
      }
      try {
        await chrome.bookmarks.move(node.id, { parentId, index: desiredIndex });
        ops += 1;
      } catch (err) {
        debugWarn('treeApply', 'url move with index failed', {
          id: node.id,
          err: String(err),
        });
        if (needsMove) {
          try {
            await chrome.bookmarks.move(node.id, { parentId });
            ops += 1;
          } catch (err2) {
            debugWarn('treeApply', 'url move failed', {
              id: node.id,
              err: String(err2),
            });
          }
        }
      }
      if (needsUpdate || needsMove) updated += 1;
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
