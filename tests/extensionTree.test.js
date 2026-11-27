const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

describe('extension folder identity', () => {
  let folderCodec;
  let treeApply;
  let sync;

  before(async () => {
    const root = path.join(__dirname, '..', 'bookmarks-extension', 'chrome', 'lib');
    folderCodec = await import(pathToFileURL(path.join(root, 'folderCodec.js')).href);
    treeApply = await import(pathToFileURL(path.join(root, 'treeApply.js')).href);
    sync = await import(pathToFileURL(path.join(root, 'sync.js')).href);
  });

  it('keeps a slash inside a folder title as one segment', () => {
    const encoded = folderCodec.encodePath(['A/B', 'C']);
    assert.equal(encoded.includes('A/B'), false);
    assert.deepEqual(folderCodec.decodePath(encoded), ['A/B', 'C']);
    assert.equal(folderCodec.decodePath('Work/Notes').join('/'), 'Work/Notes');
  });

  it('reuses the old server id when the same URL is re-added', () => {
    const local = [
      {
        localId: 'local-new',
        parentLocalId: null,
        kind: 'url',
        title: 'a',
        url: 'https://a.com/',
        folder: 'other:',
        position: 0,
        tags: [],
        dateAdded: Date.parse('2026-02-01T00:00:00.000Z'),
      },
    ];
    const snapshot = {
      X: {
        sig: 'old',
        updatedAt: '2026-01-01T00:00:00.000Z',
        folder: 'other:',
        url: 'https://a.com/',
      },
    };
    const { payload, idMap } = treeApply.toServerPayload(
      local,
      { localToServer: {}, serverToLocal: {} },
      { snapshot, emitTombstones: true }
    );
    assert.equal(payload.some((row) => row.deletedAt && row.id === 'X'), false);
    assert.equal(payload[0].id, 'X');
    assert.equal(idMap.localToServer['local-new'], 'X');
  });

  it('does not map two local nodes onto one server id', () => {
    const merged = sync.applyServerMerges(
      {
        localToServer: { a: 'X', b: 'Y' },
        serverToLocal: { X: 'a', Y: 'b' },
      },
      [{ clientId: 'Y', serverId: 'X' }]
    );
    const owners = Object.values(merged.localToServer);
    assert.equal(owners.filter((id) => id === 'X').length, 1);
    assert.deepEqual(merged.duplicateLocalIds, ['b']);
    assert.equal(merged.localToServer.a, 'X');
    assert.equal(merged.localToServer.b, undefined);
  });

  it('clamps a bookmark index to the live child count', () => {
    assert.equal(treeApply.clampBookmarkIndex(5, 1), 1);
    assert.equal(treeApply.clampBookmarkIndex(0, 0), 0);
    assert.equal(treeApply.clampBookmarkIndex(2, 4), 2);
    assert.equal(treeApply.clampBookmarkIndex(-3, 4), 0);
    assert.equal(treeApply.clampBookmarkIndex(Number.NaN, 3), 0);
  });

  it('downloads a mixed tree without Index out of bounds', async () => {
    const fake = installFakeBookmarks();
    await assert.rejects(
      () => fake.bookmarks.create({ parentId: '2', title: 'Too soon', index: 1 }),
      /Index out of bounds/
    );

    const server = [
      link('tb-link', 'Toolbar link', 'https://toolbar.example/', 'toolbar:', 0, null),
      folder('tb-folder', 'Toolbar folder', 'toolbar:', 1, null),
      folder('work', 'Work', 'other:', 0, null),
      link('link', 'Link', 'https://link.example/', 'other:', 2, null),
      link('child', 'Child', 'https://child.example/', 'other:Work', 0, 'work'),
      folder('personal', 'Personal', 'other:', 5, null),
    ];

    const first = await treeApply.applyServerBookmarks(
      server,
      { localToServer: {}, serverToLocal: {} },
      { syncRoot: 'other', removeLocalMissing: false, matchByUrl: false }
    );

    assert.deepEqual(fake.titles('1'), ['Toolbar link', 'Toolbar folder']);
    assert.deepEqual(fake.titles('2'), ['Work', 'Link', 'Personal']);
    const workId = first.idMap.serverToLocal.work;
    assert.deepEqual(fake.titles(workId), ['Child']);
    assert.equal(first.created, 6);

    const second = await treeApply.applyServerBookmarks(server, first.idMap, {
      syncRoot: 'other',
      removeLocalMissing: false,
      matchByUrl: true,
    });
    assert.equal(second.created, 0);
    assert.equal(second.updated, 0);
    assert.deepEqual(fake.titles('2'), ['Work', 'Link', 'Personal']);
    assert.deepEqual(fake.titles(workId), ['Child']);
  });

  it('reorders an existing folder to server positions', async () => {
    const fake = installFakeBookmarks();
    const personalNode = await fake.bookmarks.create({ parentId: '2', title: 'Personal' });
    const linkNode = await fake.bookmarks.create({
      parentId: '2',
      title: 'Link',
      url: 'https://link.example/',
    });
    const workNode = await fake.bookmarks.create({ parentId: '2', title: 'Work' });
    assert.deepEqual(fake.titles('2'), ['Personal', 'Link', 'Work']);

    await treeApply.applyServerBookmarks(
      [
        link('link', 'Link', 'https://link.example/', 'other:', 0, null),
        folder('work', 'Work', 'other:', 1, null),
        folder('personal', 'Personal', 'other:', 2, null),
      ],
      {
        localToServer: {
          [linkNode.id]: 'link',
          [workNode.id]: 'work',
          [personalNode.id]: 'personal',
        },
        serverToLocal: {
          link: linkNode.id,
          work: workNode.id,
          personal: personalNode.id,
        },
      },
      { syncRoot: 'other', removeLocalMissing: false, matchByUrl: false }
    );

    assert.deepEqual(fake.titles('2'), ['Link', 'Work', 'Personal']);
  });
});

function folder(id, title, folderPath, position, parentId) {
  return {
    id,
    title,
    url: '',
    folder: folderPath,
    tags: ['__dir__'],
    position,
    parentId,
    deletedAt: null,
  };
}

function link(id, title, url, folderPath, position, parentId) {
  return {
    id,
    title,
    url,
    folder: folderPath,
    tags: [],
    position,
    parentId,
    deletedAt: null,
  };
}

/**
 * Chromium bookmarks.create/move throw "Index out of bounds." when
 * index > child count. index === child count appends. Same-parent moves
 * toward a higher index are adjusted as if the node was removed first.
 */
function installFakeBookmarks() {
  let nextId = 10;
  /** @type {Map<string, { id: string, parentId?: string, title: string, url?: string, children?: object[] }>} */
  const nodes = new Map();

  function add(node) {
    nodes.set(node.id, node);
    return node;
  }

  const root = add({ id: '0', title: '', children: [] });
  const toolbar = add({ id: '1', parentId: '0', title: 'Bookmarks bar', children: [] });
  const other = add({ id: '2', parentId: '0', title: 'Other bookmarks', children: [] });
  const mobile = add({ id: '3', parentId: '0', title: 'Mobile bookmarks', children: [] });
  root.children.push(toolbar, other, mobile);

  function must(id) {
    const node = nodes.get(String(id));
    if (!node) throw new Error("Can't find bookmark for id.");
    return node;
  }

  function view(node) {
    const out = {
      id: node.id,
      parentId: node.parentId,
      title: node.title || '',
    };
    if (node.url) out.url = node.url;
    return out;
  }

  function nest(node) {
    const out = view(node);
    if (!node.url) out.children = (node.children || []).map(nest);
    return out;
  }

  const bookmarks = {
    async getTree() {
      return [nest(root)];
    },
    async get(id) {
      return [view(must(id))];
    },
    async getChildren(parentId) {
      const parent = must(parentId);
      if (parent.url || !parent.children) {
        throw new Error("Parameter 'parentId' does not specify a folder.");
      }
      return parent.children.map(view);
    },
    async create(details) {
      const parent = must(details.parentId);
      if (parent.url || !parent.children) {
        throw new Error("Parameter 'parentId' does not specify a folder.");
      }
      const index = details.index == null ? parent.children.length : details.index;
      if (index < 0 || index > parent.children.length) {
        throw new Error('Index out of bounds.');
      }
      const node = add({
        id: String(nextId),
        parentId: parent.id,
        title: details.title || '',
        children: details.url ? undefined : [],
        url: details.url || undefined,
      });
      nextId += 1;
      if (node.url) delete node.children;
      parent.children.splice(index, 0, node);
      return view(node);
    },
    async move(id, destination) {
      const node = must(id);
      const oldParent = must(node.parentId);
      const oldIndex = oldParent.children.findIndex((child) => child.id === node.id);
      const dest = must(destination.parentId);
      if (dest.url || !dest.children) {
        throw new Error("Parameter 'parentId' does not specify a folder.");
      }
      let index = destination.index == null ? dest.children.length : destination.index;
      if (index < 0 || index > dest.children.length) {
        throw new Error('Index out of bounds.');
      }
      oldParent.children.splice(oldIndex, 1);
      if (oldParent === dest && index > oldIndex) index -= 1;
      dest.children.splice(index, 0, node);
      node.parentId = dest.id;
      return view(node);
    },
    async update(id, changes) {
      const node = must(id);
      if (changes.title != null) node.title = changes.title;
      if (changes.url != null) node.url = changes.url;
      return view(node);
    },
    async remove(id) {
      const node = must(id);
      const parent = must(node.parentId);
      parent.children = parent.children.filter((child) => child.id !== node.id);
      nodes.delete(node.id);
    },
    async removeTree(id) {
      const node = must(id);
      const stack = [node];
      while (stack.length) {
        const current = stack.pop();
        for (const child of current.children || []) stack.push(child);
        nodes.delete(current.id);
      }
      const parent = nodes.get(node.parentId);
      if (parent?.children) {
        parent.children = parent.children.filter((child) => child.id !== node.id);
      }
    },
  };

  globalThis.chrome = { bookmarks };
  return {
    bookmarks,
    titles(parentId) {
      return (nodes.get(String(parentId))?.children || []).map((child) => child.title);
    },
  };
}
