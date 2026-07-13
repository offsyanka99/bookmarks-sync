const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

let db = null;

/**
 * Open (or return) the SQLite connection and ensure schema exists.
 * DB path comes from DB_PATH env (default: ./data/bookmarks.db).
 */
function getDb() {
  if (db) return db;

  const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'bookmarks.db');
  const dir = path.dirname(dbPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  migrate(db);
  return db;
}

function tableHasColumn(database, table, column) {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

function getSchemaVersion(database) {
  try {
    const row = database.prepare('SELECT value FROM sync_meta WHERE key = ?').get('schema_version');
    return row ? Number(row.value) || 0 : 0;
  } catch {
    return 0;
  }
}

function setSchemaVersion(database, version) {
  database
    .prepare(
      `INSERT INTO sync_meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(String(version));
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
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
      deleted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_bookmarks_folder ON bookmarks(folder);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_updated_at ON bookmarks(updated_at);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_deleted_at ON bookmarks(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_url ON bookmarks(url);

    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(username),
      UNIQUE(api_key)
    );

    CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
  `);

  // v2: multi-user — bookmarks.user_id
  if (!tableHasColumn(database, 'bookmarks', 'user_id')) {
    database.exec(`ALTER TABLE bookmarks ADD COLUMN user_id TEXT REFERENCES users(id)`);
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_bookmarks_user_id ON bookmarks(user_id);
  `);

  const version = getSchemaVersion(database);
  if (version < 2) {
    setSchemaVersion(database, 2);
  }
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb };
