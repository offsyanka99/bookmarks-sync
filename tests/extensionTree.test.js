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
});
