/**
 * Chrome bookmarks tree helpers.
 * Converts between the browser tree and the server bookmark shape.
 */

/** Chrome root folder titles we skip when building paths. */
const ROOT_TITLES = new Set([
  'Bookmarks bar',
  'Bookmarks Bar',
  'Other bookmarks',
  'Other Bookmarks',
  'Mobile bookmarks',
  'Mobile Bookmarks',
]);

/**
 * @typedef {{ id: string, title: string, url?: string, children?: BookmarkNode[], dateAdded?: number, dateGroupModified?: number, parentId?: string }} BookmarkNode
 */

/**
 * Flatten the entire tree into URL bookmarks with folder paths.
 * @returns {Promise<{ localId: string, title: string, url: string, folder: string, dateAdded?: number, dateGroupModified?: number }[]>}
 */
export async function collectLocalBookmarks() {
  const tree = await chrome.bookmarks.getTree();
  const out = [];

  function walk(nodes, pathParts) {
    for (const node of nodes || []) {
      if (node.url) {
        out.push({
          localId: String(node.id),
          title: node.title || '',
          url: node.url,
          folder: pathParts.join('/'),
          dateAdded: node.dateAdded,
          dateGroupModified: node.dateGroupModified,
        });
      } else if (node.children) {
        const isRootish =
          !node.parentId ||
          node.parentId === '0' ||
          ROOT_TITLES.has(node.title || '');
        const nextPath =
          isRootish || !node.title
            ? pathParts
            : [...pathParts, node.title];
        walk(node.children, nextPath);
      }
    }
  }

  walk(tree, []);
  return out;
}

/**
 * Find Chrome's toolbar / other bookmarks root ids.
 * @returns {Promise<{ toolbarId: string, otherId: string, rootId: string }>}
 */
export async function getRootIds() {
  const tree = await chrome.bookmarks.getTree();
  const root = tree[0];
  const children = root?.children || [];
  // Chrome: [0]=toolbar, [1]=other, [2]=mobile (varies by locale/title)
  let toolbarId = children[0]?.id;
  let otherId = children[1]?.id;

  for (const c of children) {
    const t = (c.title || '').toLowerCase();
    if (t.includes('bookmark') && t.includes('bar')) toolbarId = c.id;
    if (t.includes('other')) otherId = c.id;
  }

  return {
    rootId: root.id,
    toolbarId: String(toolbarId || '1'),
    otherId: String(otherId || '2'),
  };
}

/**
 * Ensure a folder path exists under parentId. Returns the leaf folder id.
 * @param {string} parentId
 * @param {string} folderPath e.g. "Work/Dev"
 * @param {Map<string, string>} cache pathKey -> folderId
 */
export async function ensureFolderPath(parentId, folderPath, cache = new Map()) {
  const parts = String(folderPath || '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);

  let currentId = String(parentId);
  let built = '';

  for (const part of parts) {
    built = built ? `${built}/${part}` : part;
    const cacheKey = `${parentId}::${built}`;
    if (cache.has(cacheKey)) {
      currentId = cache.get(cacheKey);
      continue;
    }

    const children = await chrome.bookmarks.getChildren(currentId);
    let folder = children.find((c) => !c.url && c.title === part);
    if (!folder) {
      folder = await chrome.bookmarks.create({
        parentId: currentId,
        title: part,
      });
    }
    currentId = String(folder.id);
    cache.set(cacheKey, currentId);
  }

  return currentId;
}

/**
 * Map browser ms timestamps to ISO strings.
 */
export function msToIso(ms) {
  if (!ms || !Number.isFinite(Number(ms))) return new Date().toISOString();
  return new Date(Number(ms)).toISOString();
}

/**
 * Build server-shaped bookmarks from local tree + id map.
 * Assigns new UUIDs for unmapped local bookmarks.
 */
export function toServerPayload(localBookmarks, idMap) {
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

    const updatedAt = msToIso(b.dateGroupModified || b.dateAdded);
    const createdAt = msToIso(b.dateAdded);

    payload.push({
      id: serverId,
      title: b.title,
      url: b.url,
      folder: b.folder || '',
      tags: [],
      notes: '',
      position: 0,
      createdAt,
      updatedAt,
      deletedAt: null,
      // client-only hint (ignored by server)
      _localId: b.localId,
    });
  }

  return {
    payload,
    idMap: { localToServer, serverToLocal },
  };
}

/**
 * Walk parents to see whether a node lives under the toolbar or "other".
 * @param {string} nodeId
 * @param {{ toolbarId: string, otherId: string }} roots
 */
async function resolveAnchorRoot(nodeId, roots) {
  let id = String(nodeId);
  for (let i = 0; i < 40; i += 1) {
    if (id === roots.toolbarId) return roots.toolbarId;
    if (id === roots.otherId) return roots.otherId;
    let nodes;
    try {
      nodes = await chrome.bookmarks.get(id);
    } catch {
      break;
    }
    const n = nodes?.[0];
    if (!n?.parentId) break;
    id = String(n.parentId);
  }
  return null;
}

/**
 * Apply server bookmark list to the local browser tree.
 *
 * - Existing mapped bookmarks: update title/url in place; move only when
 *   the folder path changes (kept under the same toolbar/other root).
 * - New server bookmarks: create under settings.syncRoot + folder path.
 * - Optionally remove local bookmarks whose server id disappeared.
 *
 * @param {object[]} serverBookmarks
 * @param {{ localToServer: Record<string,string>, serverToLocal: Record<string,string> }} idMap
 * @param {{ syncRoot: string, removeLocalMissing: boolean }} options
 */
export async function applyServerBookmarks(serverBookmarks, idMap, options) {
  const roots = await getRootIds();
  const defaultRoot =
    options.syncRoot === 'toolbar' ? roots.toolbarId : roots.otherId;

  const folderCache = new Map();
  const localToServer = { ...idMap.localToServer };
  const serverToLocal = { ...idMap.serverToLocal };

  const activeServerIds = new Set(
    (serverBookmarks || [])
      .filter((b) => b && b.url && !b.deletedAt)
      .map((b) => b.id)
  );

  let created = 0;
  let updated = 0;
  let removed = 0;
  let skipped = 0;

  for (const sb of serverBookmarks || []) {
    if (!sb?.url || sb.deletedAt) {
      skipped += 1;
      continue;
    }

    const localId = serverToLocal[sb.id];
    let node = null;
    if (localId) {
      try {
        const nodes = await chrome.bookmarks.get(localId);
        node = nodes?.[0] || null;
      } catch {
        node = null;
        delete serverToLocal[sb.id];
        if (localToServer[localId] === sb.id) delete localToServer[localId];
      }
    }

    if (!node) {
      const targetParentId = await ensureFolderPath(
        defaultRoot,
        sb.folder || '',
        folderCache
      );
      const createdNode = await chrome.bookmarks.create({
        parentId: targetParentId,
        title: sb.title || sb.url,
        url: sb.url,
      });
      const newLocalId = String(createdNode.id);
      localToServer[newLocalId] = sb.id;
      serverToLocal[sb.id] = newLocalId;
      created += 1;
      continue;
    }

    const needsUpdate =
      (node.title || '') !== (sb.title || node.title || '') ||
      (node.url || '') !== (sb.url || '');

    // Keep existing bookmarks under their current bar/other root
    const anchor =
      (await resolveAnchorRoot(node.parentId, roots)) || defaultRoot;
    const targetParentId = await ensureFolderPath(
      anchor,
      sb.folder || '',
      folderCache
    );
    const needsMove = String(node.parentId) !== String(targetParentId);

    if (needsUpdate) {
      await chrome.bookmarks.update(node.id, {
        title: sb.title || sb.url,
        url: sb.url,
      });
    }
    if (needsMove) {
      await chrome.bookmarks.move(node.id, { parentId: targetParentId });
    }

    if (needsUpdate || needsMove) updated += 1;
    else skipped += 1;

    localToServer[String(node.id)] = sb.id;
    serverToLocal[sb.id] = String(node.id);
  }

  if (options.removeLocalMissing) {
    for (const localId of Object.keys(localToServer)) {
      const serverId = localToServer[localId];
      if (activeServerIds.has(serverId)) continue;
      try {
        await chrome.bookmarks.remove(localId);
        removed += 1;
      } catch {
        // already gone
      }
      delete localToServer[localId];
      if (serverToLocal[serverId] === localId) delete serverToLocal[serverId];
    }
  }

  return {
    created,
    updated,
    removed,
    skipped,
    idMap: { localToServer, serverToLocal },
  };
}
