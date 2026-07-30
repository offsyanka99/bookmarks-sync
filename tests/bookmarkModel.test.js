const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { applyTestEnv, cleanupTempDir } = require('./helpers');

describe('Bookmark model', () => {
  let User;
  let Bookmark;
  let closeDb;
  let userId;

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
    db.exec('DELETE FROM bookmarks; DELETE FROM users;');
    const user = User.create({ username: 'reader' });
    userId = user.id;
  });

  it('creates, lists, soft-deletes bookmarks', () => {
    const created = Bookmark.create(userId, {
      title: 'Example',
      url: 'https://example.com/',
      folder: 'Toolbar',
    });
    assert.equal(created.ok, true);
    assert.equal(created.bookmark.title, 'Example');

    const list = Bookmark.findAll(userId);
    assert.equal(list.length, 1);

    const del = Bookmark.softDelete(userId, created.bookmark.id, { force: true });
    assert.equal(del.ok, true);
    assert.equal(Bookmark.findAll(userId).length, 0);
    assert.equal(Bookmark.findAll(userId, { includeDeleted: true }).length, 1);
  });

  it('detects folder-scoped URL duplicates and dedupes', () => {
    const a = Bookmark.create(userId, {
      title: 'A',
      url: 'https://dup.test/page',
      folder: 'F',
      position: 1,
    });
    const b = Bookmark.create(userId, {
      title: 'B',
      url: 'https://dup.test/page',
      folder: 'F',
      position: 0,
      // force second row with different client id via direct insert path
    });
    // create() may merge/conflict on twin — insert second via raw path if needed
    if (!b.ok) {
      // Direct second insert with unique id when create blocks twins
      const db = require('../src/utils/db').getDb();
      const id = require('crypto').randomUUID();
      const ts = new Date().toISOString();
      db.prepare(
        `INSERT INTO bookmarks
          (id, user_id, title, url, folder, tags, notes, favicon, position, created_at, updated_at, deleted_at)
         VALUES (?, ?, 'B', 'https://dup.test/page', 'F', '[]', '', NULL, 0, ?, ?, NULL)`
      ).run(id, userId, ts, ts);
    }

    const dups = Bookmark.findDuplicates(userId);
    assert.ok(dups.groupCount >= 1);
    assert.ok(dups.extraCount >= 1);

    const result = Bookmark.dedupeByFolderUrl(userId);
    assert.equal(result.removedCount >= 1, true);
    assert.equal(Bookmark.findDuplicates(userId).groupCount, 0);
    assert.equal(Bookmark.findAll(userId).length, 1);
  });

  it('merges folder+url twins when mergeDuplicates is true', () => {
    const first = Bookmark.create(userId, {
      title: 'Old',
      url: 'https://merge.test/',
      folder: '',
    });
    assert.equal(first.ok, true);

    const second = Bookmark.create(
      userId,
      {
        id: require('crypto').randomUUID(),
        title: 'New',
        url: 'https://merge.test/',
        folder: '',
      },
      { mergeDuplicates: true }
    );
    assert.equal(second.ok, true);
    assert.equal(second.merged, true);
    assert.equal(second.bookmark.title, 'New');
    assert.equal(Bookmark.findAll(userId).length, 1);
  });
});
