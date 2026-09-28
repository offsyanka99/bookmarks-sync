const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { canonicalIso } = require('./timeCanon');
const { hashApiKey, isApiKeyHash, apiKeyPrefix } = require('./crypto');

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

function createBookmarkIndexes(database) {
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_bookmarks_user_folder ON bookmarks(user_id, folder);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_user_updated ON bookmarks(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_user_deleted ON bookmarks(user_id, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_user_url ON bookmarks(user_id, url);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_user_seq ON bookmarks(user_id, seq);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_user_id ON bookmarks(user_id);
  `);
}

function primaryKeyColumns(database, table) {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);
}

function tableExists(database, table) {
  return Boolean(
    database
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table)
  );
}

function createUserChangeSeq(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_change_seq (
      user_id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL DEFAULT 0
    );
  `);
}

/**
 * Assign per-user seq values to rows that still have seq 0, and record the high water.
 * Rows written by the current code already carry a seq.
 */
function backfillChangeSeq(database) {
  if (!tableExists(database, 'bookmarks')) return;
  createUserChangeSeq(database);
  const users = database
    .prepare(`SELECT DISTINCT user_id FROM bookmarks WHERE user_id IS NOT NULL AND TRIM(user_id) != ''`)
    .all();
  const countNonZero = database.prepare(
    'SELECT COUNT(*) AS c FROM bookmarks WHERE user_id = ? AND seq > 0'
  );
  const maxSeq = database.prepare('SELECT MAX(seq) AS m FROM bookmarks WHERE user_id = ?');
  const listIds = database.prepare(
    `SELECT id FROM bookmarks WHERE user_id = ? ORDER BY updated_at ASC, id ASC`
  );
  const setSeq = database.prepare('UPDATE bookmarks SET seq = ? WHERE user_id = ? AND id = ?');
  const upsertHigh = database.prepare(
    `INSERT INTO user_change_seq (user_id, seq) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET seq = excluded.seq`
  );
  const readHigh = database.prepare('SELECT seq FROM user_change_seq WHERE user_id = ?');

  for (const { user_id: userId } of users) {
    const nonzero = countNonZero.get(userId).c;
    const highRow = readHigh.get(userId);
    const storedHigh = highRow ? Number(highRow.seq) || 0 : 0;
    if (nonzero > 0) {
      const max = Number(maxSeq.get(userId).m) || 0;
      if (storedHigh < max) upsertHigh.run(userId, max);
      continue;
    }
    const rows = listIds.all(userId);
    let n = 0;
    for (const row of rows) {
      n += 1;
      setSeq.run(n, userId, row.id);
    }
    upsertHigh.run(userId, Math.max(n, storedHigh));
  }
}

function hashStoredApiKeys(database) {
  if (!tableHasColumn(database, 'users', 'api_key_prefix')) {
    database.exec(`ALTER TABLE users ADD COLUMN api_key_prefix TEXT NOT NULL DEFAULT ''`);
  }
  const rows = database.prepare('SELECT id, api_key, api_key_prefix FROM users').all();
  const update = database.prepare(
    'UPDATE users SET api_key = ?, api_key_prefix = ? WHERE id = ?'
  );
  for (const row of rows) {
    if (!row.api_key || isApiKeyHash(row.api_key)) continue;
    update.run(hashApiKey(row.api_key), row.api_key_prefix || apiKeyPrefix(row.api_key), row.id);
  }
}

/**
 * Rebuild bookmarks so the primary key is (user_id, id) and seq/parent_id exist.
 * Rows with no owner are parked in bookmarks_orphans when no admin can claim them.
 */
function rebuildBookmarksTable(database) {
  if (tableHasColumn(database, 'bookmarks', 'user_id')) {
    const admin = database
      .prepare(`SELECT id FROM users WHERE is_admin = 1 ORDER BY created_at ASC LIMIT 1`)
      .get();
    if (admin) {
      database
        .prepare(
          `UPDATE bookmarks SET user_id = ? WHERE user_id IS NULL OR TRIM(user_id) = ''`
        )
        .run(admin.id);
    }
  }

  database.pragma('foreign_keys = OFF');
  const tx = database.transaction(() => {
    database.exec(`DROP TABLE IF EXISTS bookmarks_next;`);
    database.exec(`
      CREATE TABLE bookmarks_next (
        user_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL,
        folder TEXT NOT NULL DEFAULT '',
        parent_id TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        favicon TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, id)
      );
    `);

    const rows = database
      .prepare(`SELECT * FROM bookmarks WHERE user_id IS NOT NULL AND TRIM(user_id) != ''`)
      .all()
      .sort((a, b) => {
        const user = String(a.user_id).localeCompare(String(b.user_id));
        if (user !== 0) return user;
        const updated = String(a.updated_at || '').localeCompare(String(b.updated_at || ''));
        if (updated !== 0) return updated;
        return String(a.id).localeCompare(String(b.id));
      });

    const orphans = database
      .prepare(
        `SELECT * FROM bookmarks WHERE user_id IS NULL OR TRIM(user_id) = ''`
      )
      .all();
    if (orphans.length > 0) {
      database.exec(`DROP TABLE IF EXISTS bookmarks_orphans;`);
      database.exec(`CREATE TABLE bookmarks_orphans AS SELECT * FROM bookmarks WHERE 0`);
      const columns = Object.keys(orphans[0]);
      const insertOrphan = database.prepare(
        `INSERT INTO bookmarks_orphans (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      );
      for (const orphan of orphans) {
        insertOrphan.run(columns.map((column) => orphan[column]));
      }
    }

    const insert = database.prepare(
      `INSERT INTO bookmarks_next
        (user_id, id, title, url, folder, parent_id, tags, notes, favicon, position,
         created_at, updated_at, deleted_at, seq)
       VALUES
        (@user_id, @id, @title, @url, @folder, NULL, @tags, @notes, @favicon, @position,
         @created_at, @updated_at, @deleted_at, @seq)`
    );
    let lastUser = null;
    let seq = 0;
    for (const row of rows) {
      if (row.user_id !== lastUser) {
        lastUser = row.user_id;
        seq = 0;
      }
      seq += 1;
      const created = canonicalIso(row.created_at) || row.created_at;
      const updated = canonicalIso(row.updated_at) || row.updated_at || created;
      insert.run({
        user_id: row.user_id,
        id: row.id,
        title: row.title ?? '',
        url: row.url ?? '',
        folder: row.folder ?? '',
        tags: row.tags ?? '[]',
        notes: row.notes ?? '',
        favicon: row.favicon ?? null,
        position: Number.isFinite(Number(row.position)) ? Number(row.position) : 0,
        created_at: created,
        updated_at: updated,
        deleted_at: row.deleted_at ? canonicalIso(row.deleted_at) || row.deleted_at : null,
        seq,
      });
    }

    database.exec('DROP TABLE bookmarks;');
    database.exec('ALTER TABLE bookmarks_next RENAME TO bookmarks;');
    createBookmarkIndexes(database);

    const highs = database
      .prepare('SELECT user_id, MAX(seq) AS seq FROM bookmarks GROUP BY user_id')
      .all();
    const upsert = database.prepare(
      `INSERT INTO user_change_seq (user_id, seq) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET seq = excluded.seq`
    );
    for (const row of highs) upsert.run(row.user_id, row.seq || 0);
  });
  try {
    tx();
  } finally {
    database.pragma('foreign_keys = ON');
  }
}

function migrate(database) {
  database.exec(`
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
      api_key_prefix TEXT NOT NULL DEFAULT '',
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

  createUserChangeSeq(database);

  if (!tableExists(database, 'bookmarks')) {
    database.exec(`
      CREATE TABLE bookmarks (
        user_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL,
        folder TEXT NOT NULL DEFAULT '',
        parent_id TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        favicon TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, id)
      );
    `);
  } else {
    if (!tableHasColumn(database, 'bookmarks', 'user_id')) {
      database.exec('ALTER TABLE bookmarks ADD COLUMN user_id TEXT');
    }
    const pk = primaryKeyColumns(database, 'bookmarks');
    const composite = pk.includes('user_id') && pk.includes('id');
    if (!composite) {
      rebuildBookmarksTable(database);
    } else {
      if (!tableHasColumn(database, 'bookmarks', 'parent_id')) {
        database.exec('ALTER TABLE bookmarks ADD COLUMN parent_id TEXT');
      }
      if (!tableHasColumn(database, 'bookmarks', 'seq')) {
        database.exec('ALTER TABLE bookmarks ADD COLUMN seq INTEGER NOT NULL DEFAULT 0');
      }
    }
  }

  createBookmarkIndexes(database);
  backfillChangeSeq(database);
  hashStoredApiKeys(database);

  if (getSchemaVersion(database) < 4) {
    setSchemaVersion(database, 4);
  }
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Resolve the configured SQLite file path (same rules as getDb).
 */
function getDbPath() {
  return process.env.DB_PATH || path.join(process.cwd(), 'data', 'bookmarks.db');
}

/**
 * Factory-reset: back up the database, then delete it (and WAL/SHM sidecars)
 * and reopen a fresh empty DB. All users, bookmarks, and meta are gone.
 * The backup is kept beside the DB as bookmarks.db.bak-before-reset-<stamp>.
 *
 * @returns {Promise<string>} backup file path
 */
async function resetDatabase() {
  const dbPath = getDbPath();
  const database = getDb();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(
    path.dirname(dbPath),
    `bookmarks.db.bak-before-reset-${stamp}`
  );
  await database.backup(backupPath);
  closeDb();

  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (fs.existsSync(candidate)) {
        fs.unlinkSync(candidate);
      }
    } catch (err) {
      throw Object.assign(
        new Error(`Failed to remove database file ${candidate}: ${err.message}`),
        { code: 'RESET_FAILED', cause: err }
      );
    }
  }

  getDb();
  return backupPath;
}

module.exports = { getDb, closeDb, getDbPath, resetDatabase };
