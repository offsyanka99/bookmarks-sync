/**
 * Browser bookmarks tree helpers (Chrome, Brave, Firefox).
 *
 * Split across modules; this file re-exports the public API used by sync.js.
 *
 * Folder encoding: "toolbar:" | "toolbar:Work" | "other:..." | "menu:..." | "mobile:..."
 * Directory rows: tags ["__dir__"], url "".
 * URL rows: normal http(s) url; position among mixed siblings.
 */

export {
  DIR_TAG,
  ROOT_TITLES,
  ROOT_KINDS,
  encodeFolder,
  decodeFolder,
  isDirEntry,
  itemSignature,
  normalizeUrl,
  urlsMatch,
  classifyRootNode,
  parentIdForRoot,
  parentDepth,
  msToIso,
} from './folderCodec.js';

export {
  getRootIds,
  clearManagedBookmarkRoots,
  collectLocalBookmarks,
} from './treeCollect.js';

export {
  toServerPayload,
  snapshotFromServerBookmarks,
  applyServerBookmarks,
} from './treeApply.js';
