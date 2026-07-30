/**
 * Collect local bookmark tree + clear managed roots.
 */

import {
  DIR_TAG,
  encodeFolder,
  classifyRootNode,
  kindFromFixedRootId,
  isFixedBrowserRootId,
} from './folderCodec.js';
import { debugWarn } from './debugLog.js';

export async function getRootIds() {
  const tree = await chrome.bookmarks.getTree();
  const root = tree[0];
  const children = root?.children || [];

  let toolbarId = children[0]?.id;
  let otherId = children[1]?.id;
  let menuId = null;
  let mobileId = null;

  // Only the tree's direct children are browser roots (title match allowed here).
  for (const c of children) {
    const kind = classifyRootNode(c, { allowTitleMatch: true });
    if (kind === 'toolbar') toolbarId = c.id;
    if (kind === 'other') otherId = c.id;
    if (kind === 'menu') menuId = c.id;
    if (kind === 'mobile') mobileId = c.id;
  }

  return {
    rootId: String(root.id),
    toolbarId: String(toolbarId || '1'),
    otherId: String(otherId || '2'),
    menuId: menuId != null ? String(menuId) : null,
    mobileId: mobileId != null ? String(mobileId) : null,
  };
}

/**
 * Remove all user bookmarks under Bar / Other / Menu / Mobile roots.
 * @returns {Promise<number>}
 */
export async function clearManagedBookmarkRoots() {
  const roots = await getRootIds();
  const rootIds = [roots.toolbarId, roots.otherId, roots.menuId, roots.mobileId].filter(
    Boolean
  );
  let removed = 0;
  for (const rootId of rootIds) {
    let children;
    try {
      children = await chrome.bookmarks.getChildren(rootId);
    } catch (err) {
      debugWarn('treeCollect', 'getChildren failed', { rootId, err: String(err) });
      continue;
    }
    for (const child of children) {
      try {
        if (child.url) {
          await chrome.bookmarks.remove(child.id);
        } else {
          await chrome.bookmarks.removeTree(child.id);
        }
        removed += 1;
      } catch (err) {
        debugWarn('treeCollect', 'remove child failed', {
          id: child.id,
          err: String(err),
        });
      }
    }
  }
  return removed;
}

/**
 * Collect folders + URL bookmarks with mixed sibling positions.
 *
 * Logical roots (toolbar/other/menu/mobile) are identified by fixed browser ids
 * or top-level title match only — never by nested folder titles. That keeps
 * Brave's "Bookmarks bar" and Firefox's "Bookmarks Toolbar" as the same
 * `toolbar:` root without treating user folders as new roots.
 */
export async function collectLocalBookmarks() {
  const tree = await chrome.bookmarks.getTree();
  const treeRootId = tree[0] ? String(tree[0].id) : '0';
  const out = [];

  function walk(nodes, pathParts, rootKind, underManagedRoot) {
    let pos = 0;
    for (const node of nodes || []) {
      if (node.url) {
        out.push({
          localId: String(node.id),
          kind: 'url',
          title: node.title || '',
          url: node.url,
          folder: encodeFolder(rootKind || 'other', pathParts.join('/')),
          position: pos,
          tags: [],
          dateAdded: node.dateAdded,
          dateGroupModified: node.dateGroupModified,
        });
        pos += 1;
      } else if (node.children) {
        const parentId = node.parentId != null ? String(node.parentId) : '';
        const isTopLevel = !parentId || parentId === '0' || parentId === treeRootId;

        // Fixed browser root ids always re-root (toolbar_____ / Chromium "1", …).
        // Title match only at the tree's top level — never for nested folders.
        let classified = kindFromFixedRootId(node.id);
        if (!classified && isTopLevel) {
          classified = classifyRootNode(node, { allowTitleMatch: true });
        }

        if (classified) {
          walk(node.children, [], classified, true);
          continue;
        }

        // Skip non-bookmark pseudo-nodes at the tree root without treating
        // them as user folders (e.g. rare containers). Nested fixed roots only.
        if (isTopLevel && !underManagedRoot && isFixedBrowserRootId(node.id)) {
          walk(node.children, pathParts, rootKind || 'other', underManagedRoot);
          continue;
        }

        const parentFolder = encodeFolder(rootKind || 'other', pathParts.join('/'));
        out.push({
          localId: String(node.id),
          kind: 'folder',
          title: node.title || 'Folder',
          url: '',
          folder: parentFolder,
          position: pos,
          tags: [DIR_TAG],
          dateAdded: node.dateAdded,
          dateGroupModified: node.dateGroupModified,
        });
        pos += 1;
        walk(
          node.children,
          [...pathParts, node.title || 'Folder'],
          rootKind || 'other',
          underManagedRoot
        );
      }
    }
  }

  // Top-level: allow title match so Brave "Bookmarks bar" / Firefox "Bookmarks Toolbar" map correctly.
  walk(tree[0]?.children || tree, [], 'other', false);
  return out;
}
