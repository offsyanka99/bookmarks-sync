const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { applyTestEnv, cleanupTempDir } = require('./helpers');

describe('Bookmark.syncFromClient', () => {
  let User;
  let Bookmark;
  let closeDb;
  let userId;
  let otherId;

  before(() => {
    applyTestEnv();
    closeDb = require('../src/utils/db').closeDb;
    require('../src/utils/db').getDb();
    User = require('../src/models/User');
    Bookmark = require('../src/models/Bookmark');
  });

  after(() => {
    closeDb();
    cleanupTempDir();
  });

  beforeEach(() => {
    const db = require('../src/utils/db').getDb();
    db.exec('DELETE FROM bookmarks; DELETE FROM users; DELETE FROM user_change_seq;');
    userId = User.create({ username: 'u1' }).id;
    otherId = User.create({ username: 'u2' }).id;
  });

  const t0 = '2026-01-01T00:00:00.000Z';

  it('keeps a bookmark that was deleted and re-added in the same batch', () => {
    Bookmark.syncFromClient(userId, [
      { id: 'X', title: 'a', url: 'https://a.com/', folder: 'other:', updatedAt: t0 },
    ]);
    const now = new Date().toISOString();
    const result = Bookmark.syncFromClient(
      userId,
      [
        { id: 'Y', title: 'a', url: 'https://a.com/', folder: 'other:', updatedAt: now },
        { id: 'X', deletedAt: now, updatedAt: now },
      ],
      { lastSyncAt: t0, replace: true, knownIds: ['X'] }
    );
    assert.equal(result.bookmarks.length, 1);
    assert.equal(result.bookmarks[0].id, 'X');
    assert.equal(result.merges.length, 1);
    assert.equal(result.merges[0].clientId, 'Y');
    assert.equal(result.merges[0].serverId, 'X');
    assert.equal(result.tombstones.some((row) => row.id === 'X'), false);
  });

  it('does not let replace delete a row last-write-wins kept', () => {
    const t1 = '2026-01-02T00:00:00.000Z';
    const t2 = '2026-01-03T00:00:00.000Z';
    Bookmark.syncFromClient(userId, [
      { id: 'A', title: 'a', url: 'https://a.com/', folder: 'other:', updatedAt: t0 },
      { id: 'K', title: 'k', url: 'https://k.com/', folder: 'other:', updatedAt: t0 },
    ]);
    Bookmark.syncFromClient(userId, [
      { id: 'A', title: 'a-edited', url: 'https://a.com/', folder: 'other:', updatedAt: t2 },
      { id: 'K', title: 'k', url: 'https://k.com/', folder: 'other:', updatedAt: t0 },
    ]);
    const result = Bookmark.syncFromClient(
      userId,
      [
        { id: 'K', title: 'k', url: 'https://k.com/', folder: 'other:', updatedAt: t0 },
        { id: 'A', deletedAt: t1, updatedAt: t1 },
      ],
      { replace: true, lastSyncAt: t0, knownIds: ['A', 'K'] }
    );
    const ids = result.bookmarks.map((row) => row.id).sort();
    assert.deepEqual(ids, ['A', 'K']);
    assert.equal(result.bookmarks.find((row) => row.id === 'A').title, 'a-edited');
    assert.ok(result.conflicts.some((row) => row.id === 'A' && row.reason === 'server_newer'));
  });

  it('allows the same bookmark id on two users', () => {
    Bookmark.syncFromClient(userId, [
      { id: 'X', title: 'a', url: 'https://a.com/', folder: 'other:', updatedAt: t0 },
    ]);
    const second = Bookmark.syncFromClient(otherId, [
      { id: 'X', title: 'b', url: 'https://b.com/', folder: 'other:', updatedAt: t0 },
    ]);
    assert.equal(second.created, 1);
    assert.equal(Bookmark.findById(userId, 'X').title, 'a');
    assert.equal(Bookmark.findById(otherId, 'X').title, 'b');

    const created = Bookmark.create(otherId, { id: 'X', url: 'https://c.com/' });
    assert.equal(created.ok, false);
    assert.equal(created.reason, 'id_exists');
    assert.equal(created.server.id, 'X');
  });

  it('stores canonical UTC timestamps and advances a per-user seq', () => {
    const result = Bookmark.syncFromClient(userId, [
      {
        id: 'T',
        title: 't',
        url: 'https://t.com/',
        folder: 'other:',
        updatedAt: '2026-01-01T02:00:00+02:00',
      },
    ]);
    assert.equal(result.bookmarks[0].updatedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(result.bookmarks[0].seq, 1);
    assert.equal(result.syncCursor, 1);

    const next = Bookmark.syncFromClient(
      userId,
      [
        {
          id: 'T',
          title: 't2',
          url: 'https://t.com/',
          folder: 'other:',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
      { syncCursor: 1, changesOnly: true }
    );
    assert.equal(next.bookmarks.length, 1);
    assert.equal(next.bookmarks[0].title, 't2');
    assert.ok(next.bookmarks[0].seq > 1);
  });

  it('uses the seq cursor for the safe-delete window, not a future client clock', () => {
    Bookmark.syncFromClient(userId, [
      { id: 'A', title: 'a', url: 'https://a.com/', folder: 'other:', updatedAt: t0 },
      { id: 'K', title: 'k', url: 'https://k.com/', folder: 'other:', updatedAt: t0 },
    ]);
    const cursor = Bookmark.currentSeq(userId);
    Bookmark.syncFromClient(userId, [
      { id: 'Z', title: 'z', url: 'https://z.com/', folder: 'other:', updatedAt: t0 },
    ]);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const result = Bookmark.syncFromClient(
      userId,
      [
        { id: 'A', title: 'a', url: 'https://a.com/', folder: 'other:', updatedAt: t0 },
        { id: 'K', title: 'k', url: 'https://k.com/', folder: 'other:', updatedAt: t0 },
      ],
      { replace: true, lastSyncAt: future, syncCursor: cursor, knownIds: ['A', 'K'] }
    );
    assert.ok(result.bookmarks.some((row) => row.id === 'Z'));
  });

  it('does not delete omitted rows when the client sends only changes', () => {
    Bookmark.syncFromClient(userId, [
      { id: 'A', title: 'a', url: 'https://a.com/', folder: 'other:', updatedAt: t0 },
      { id: 'K', title: 'k', url: 'https://k.com/', folder: 'other:', updatedAt: t0 },
    ]);
    const cursor = Bookmark.currentSeq(userId);
    const result = Bookmark.syncFromClient(
      userId,
      [{ id: 'A', title: 'a2', url: 'https://a.com/', folder: 'other:', updatedAt: '2026-02-01T00:00:00.000Z' }],
      { changesOnly: true, replace: true, knownIds: ['A', 'K'], syncCursor: cursor }
    );
    assert.ok(Bookmark.findById(userId, 'K'));
    assert.equal(result.bookmarks.some((row) => row.id === 'K'), false);
    assert.equal(result.bookmarks.some((row) => row.id === 'A'), true);
  });

  it('pages the active list and purges old tombstones into a full resync', () => {
    const result = Bookmark.syncFromClient(
      userId,
      [
        { id: 'A', title: 'a', url: 'https://a.com/', folder: 'other:', updatedAt: t0 },
        { id: 'B', title: 'b', url: 'https://b.com/', folder: 'other:', updatedAt: t0 },
        { id: 'C', title: 'c', url: 'https://c.com/', folder: 'other:', updatedAt: t0 },
      ],
      { pageSize: 2 }
    );
    assert.equal(result.bookmarks.length, 2);
    assert.ok(result.nextBookmarkToken);
    const page2 = Bookmark.findChangedPage(userId, {
      pageSize: 2,
      pageToken: result.nextBookmarkToken,
    });
    assert.equal(page2.bookmarks.length, 1);
    assert.equal(page2.nextPageToken, null);

    Bookmark.syncFromClient(userId, [
      { id: 'OLD', title: 'old', url: 'https://old.example/', folder: 'other:', deletedAt: t0, updatedAt: t0 },
    ]);
    const db = require('../src/utils/db').getDb();
    db.prepare(`UPDATE bookmarks SET deleted_at = ? WHERE user_id = ? AND id = ?`).run(
      '2020-01-01T00:00:00.000Z',
      userId,
      'OLD'
    );
    const purged = Bookmark.purgeExpiredTombstones({ retentionDays: 30 });
    assert.equal(purged.deleted, 1);
    assert.equal(Bookmark.findById(userId, 'OLD', { includeDeleted: true }), null);
    const horizon = Bookmark.tombstoneHorizon(userId);
    assert.ok(horizon.seq > 0);
    const stale = Bookmark.syncFromClient(userId, [], {
      syncCursor: 0,
      changesOnly: true,
    });
    assert.equal(stale.fullResync, true);
    assert.ok(stale.bookmarks.length >= 3);
  });

  it('stores parentId on the row', () => {
    const result = Bookmark.syncFromClient(userId, [
      {
        id: 'F',
        title: 'Work',
        url: '',
        folder: 'other:',
        tags: ['__dir__'],
        updatedAt: t0,
      },
      {
        id: 'C',
        title: 'child',
        url: 'https://child.example/',
        folder: 'other:Work',
        parentId: 'F',
        updatedAt: t0,
      },
    ]);
    const child = result.bookmarks.find((row) => row.id === 'C');
    assert.equal(child.parentId, 'F');
  });

  it('clamps a far-future client timestamp so a later edit can win', () => {
    const first = Bookmark.syncFromClient(userId, [
      {
        id: 'FUT',
        title: 'future',
        url: 'https://future.example/',
        folder: 'other:',
        updatedAt: '2099-01-01T00:00:00.000Z',
      },
    ]);
    const stored = first.bookmarks.find((row) => row.id === 'FUT');
    assert.ok(stored);
    assert.ok(Date.parse(stored.updatedAt) < Date.parse('2030-01-01T00:00:00.000Z'));
    const later = new Date(Date.now() + 2000).toISOString();
    const next = Bookmark.syncFromClient(userId, [
      {
        id: 'FUT',
        title: 'honest',
        url: 'https://future.example/',
        folder: 'other:',
        updatedAt: later,
      },
    ]);
    assert.equal(next.bookmarks.find((row) => row.id === 'FUT').title, 'honest');
  });

  it('keeps notes, favicon, and tags when the client omits them', () => {
    Bookmark.syncFromClient(userId, [
      {
        id: 'N',
        title: 'n',
        url: 'https://n.example/',
        folder: 'other:',
        notes: 'keep me',
        favicon: 'https://n.example/favicon.ico',
        tags: ['star'],
        updatedAt: t0,
      },
    ]);
    const now = new Date().toISOString();
    const kept = Bookmark.syncFromClient(userId, [
      {
        id: 'N',
        title: 'n2',
        url: 'https://n.example/',
        folder: 'other:',
        updatedAt: now,
      },
    ]);
    const row = kept.bookmarks.find((item) => item.id === 'N');
    assert.equal(row.title, 'n2');
    assert.equal(row.notes, 'keep me');
    assert.equal(row.favicon, 'https://n.example/favicon.ico');
    assert.deepEqual(row.tags, ['star']);

    const cleared = Bookmark.syncFromClient(userId, [
      {
        id: 'N',
        title: 'n2',
        url: 'https://n.example/',
        folder: 'other:',
        notes: '',
        favicon: null,
        tags: [],
        updatedAt: new Date(Date.now() + 2000).toISOString(),
      },
    ]);
    const empty = cleared.bookmarks.find((item) => item.id === 'N');
    assert.equal(empty.notes, '');
    assert.equal(empty.favicon, null);
    assert.deepEqual(empty.tags, []);
  });

  it('skips an invalid sync row and still stores the valid one', () => {
    const result = Bookmark.syncFromClient(userId, [
      { id: 'ok', title: 'ok', url: 'https://ok.example/', folder: 'other:', updatedAt: t0 },
      { id: 'bad', title: 'bad', url: 12, folder: 'other:' },
      { id: 'wide', title: 'wide', url: `https://wide.example/${'u'.repeat(9000)}`, folder: 'other:' },
      { id: 'dir', title: 'Work', url: '', tags: ['__dir__'], folder: 'other:', updatedAt: t0 },
    ]);
    const ids = result.bookmarks.map((row) => row.id).sort();
    assert.deepEqual(ids, ['dir', 'ok']);
    assert.ok(result.skipped >= 2);
    assert.ok(result.conflicts.some((item) => item.reason === 'invalid' && item.id === 'bad'));
  });
});
