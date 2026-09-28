const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const Database = require('better-sqlite3');
const { applyTestEnv, cleanupTempDir } = require('./helpers');

describe('schema migration', () => {
  let closeDb;

  after(() => {
    if (closeDb) closeDb();
    cleanupTempDir();
  });

  it('rebuilds a global bookmark id into a per-user primary key and hashes API keys', () => {
    const { dbPath } = applyTestEnv();
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE bookmarks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL,
        folder TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        favicon TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        user_id TEXT
      );
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        api_key TEXT NOT NULL UNIQUE,
        is_admin INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(username)
      );
      CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const now = '2026-01-01T00:00:00.000Z';
    raw.prepare(
      `INSERT INTO users (id, username, password_hash, display_name, api_key, is_admin, is_active, created_at, updated_at)
       VALUES ('user-a', 'alpha', 'x', 'Alpha', 'bms_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, 1, ?, ?)`
    ).run(now, now);
    raw.prepare(
      `INSERT INTO users (id, username, password_hash, display_name, api_key, is_admin, is_active, created_at, updated_at)
       VALUES ('user-b', 'beta', 'x', 'Beta', 'bms_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 0, 1, ?, ?)`
    ).run(now, now);
    raw.prepare(
      `INSERT INTO bookmarks (id, user_id, title, url, folder, created_at, updated_at)
       VALUES ('shared-id', 'user-a', 'A', 'https://a.example/', 'other:', ?, ?)`
    ).run(now, now);
    raw.close();

    const dbModule = require('../src/utils/db');
    closeDb = dbModule.closeDb;
    const db = dbModule.getDb();
    const pk = db
      .prepare('PRAGMA table_info(bookmarks)')
      .all()
      .filter((column) => column.pk > 0)
      .map((column) => column.name)
      .sort();
    assert.deepEqual(pk, ['id', 'user_id']);

    db.prepare(
      `INSERT INTO bookmarks
        (user_id, id, title, url, folder, tags, notes, position, created_at, updated_at, seq)
       VALUES ('user-b', 'shared-id', 'B', 'https://b.example/', 'other:', '[]', '', 0, ?, ?, 1)`
    ).run(now, now);
    const rows = db.prepare(`SELECT user_id, id, title FROM bookmarks ORDER BY user_id`).all();
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.user_id),
      ['user-a', 'user-b']
    );

    const User = require('../src/models/User');
    const alpha = User.findByApiKey(
      'bms_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
    assert.equal(alpha.username, 'alpha');
    assert.equal(alpha.apiKey, undefined);
    assert.ok(String(alpha.apiKeyPrefix || '').startsWith('bms_aaaaaaa'));
    const stored = db.prepare(`SELECT api_key FROM users WHERE id = 'user-a'`).get();
    assert.match(stored.api_key, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(dbPath), true);
  });
});
