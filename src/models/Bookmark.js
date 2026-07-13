const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../utils/db');

function nowIso() {
  return new Date().toISOString();
}

function parseTags(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function serializeTags(tags) {
  if (!tags) return '[]';
  if (typeof tags === 'string') return tags;
  return JSON.stringify(Array.isArray(tags) ? tags : []);
}

function rowToBookmark(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    url: row.url,
    folder: row.folder,
    tags: parseTags(row.tags),
    notes: row.notes,
    favicon: row.favicon,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

const SELECT_COLS = `
  id, user_id, title, url, folder, tags, notes, favicon, position,
  created_at, updated_at, deleted_at
`;

function requireUserId(userId) {
  if (!userId) {
    throw new Error('userId is required for bookmark operations');
  }
  return userId;
}

class Bookmark {
  static findAll(userId, { includeDeleted = false, folder = null } = {}) {
    userId = requireUserId(userId);
    const db = getDb();
    const conditions = ['user_id = @userId'];
    const params = { userId };

    if (!includeDeleted) {
      conditions.push('deleted_at IS NULL');
    }
    if (folder !== null && folder !== undefined) {
      conditions.push('folder = @folder');
      params.folder = folder;
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const rows = db
      .prepare(
        `SELECT ${SELECT_COLS} FROM bookmarks ${where}
         ORDER BY folder ASC, position ASC, title ASC`
      )
      .all(params);

    return rows.map(rowToBookmark);
  }

  static findById(userId, id, { includeDeleted = false } = {}) {
    userId = requireUserId(userId);
    const db = getDb();
    const row = includeDeleted
      ? db
          .prepare(`SELECT ${SELECT_COLS} FROM bookmarks WHERE id = ? AND user_id = ?`)
          .get(id, userId)
      : db
          .prepare(
            `SELECT ${SELECT_COLS} FROM bookmarks WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
          )
          .get(id, userId);
    return rowToBookmark(row);
  }

  static create(userId, data) {
    userId = requireUserId(userId);
    const db = getDb();
    const id = data.id || uuidv4();
    const ts = nowIso();

    const record = {
      id,
      user_id: userId,
      title: data.title ?? '',
      url: data.url,
      folder: data.folder ?? '',
      tags: serializeTags(data.tags),
      notes: data.notes ?? '',
      favicon: data.favicon ?? null,
      position: Number.isFinite(data.position) ? data.position : 0,
      created_at: data.createdAt || ts,
      updated_at: data.updatedAt || ts,
      deleted_at: data.deletedAt ?? null,
    };

    db.prepare(
      `INSERT INTO bookmarks
        (id, user_id, title, url, folder, tags, notes, favicon, position, created_at, updated_at, deleted_at)
       VALUES
        (@id, @user_id, @title, @url, @folder, @tags, @notes, @favicon, @position, @created_at, @updated_at, @deleted_at)`
    ).run(record);

    return this.findById(userId, id, { includeDeleted: true });
  }

  static update(userId, id, data) {
    const existing = this.findById(userId, id, { includeDeleted: true });
    if (!existing) return null;

    const db = getDb();
    const updated = {
      id,
      user_id: userId,
      title: data.title !== undefined ? data.title : existing.title,
      url: data.url !== undefined ? data.url : existing.url,
      folder: data.folder !== undefined ? data.folder : existing.folder,
      tags: data.tags !== undefined ? serializeTags(data.tags) : serializeTags(existing.tags),
      notes: data.notes !== undefined ? data.notes : existing.notes,
      favicon: data.favicon !== undefined ? data.favicon : existing.favicon,
      position:
        data.position !== undefined && Number.isFinite(data.position)
          ? data.position
          : existing.position,
      updated_at: nowIso(),
      deleted_at: data.deletedAt !== undefined ? data.deletedAt : existing.deletedAt,
    };

    db.prepare(
      `UPDATE bookmarks SET
        title = @title,
        url = @url,
        folder = @folder,
        tags = @tags,
        notes = @notes,
        favicon = @favicon,
        position = @position,
        updated_at = @updated_at,
        deleted_at = @deleted_at
       WHERE id = @id AND user_id = @user_id`
    ).run(updated);

    return this.findById(userId, id, { includeDeleted: true });
  }

  static softDelete(userId, id) {
    const existing = this.findById(userId, id);
    if (!existing) return null;

    const db = getDb();
    const ts = nowIso();
    db.prepare(
      `UPDATE bookmarks SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`
    ).run(ts, ts, id, userId);

    return this.findById(userId, id, { includeDeleted: true });
  }

  static hardDelete(userId, id) {
    userId = requireUserId(userId);
    const db = getDb();
    const result = db
      .prepare('DELETE FROM bookmarks WHERE id = ? AND user_id = ?')
      .run(id, userId);
    return result.changes > 0;
  }

  /**
   * Upsert a full set of bookmarks for one user (client sync push).
   */
  static syncFromClient(userId, bookmarks, { replace = false } = {}) {
    userId = requireUserId(userId);
    const db = getDb();
    const ts = nowIso();

    const upsert = db.prepare(
      `INSERT INTO bookmarks
        (id, user_id, title, url, folder, tags, notes, favicon, position, created_at, updated_at, deleted_at)
       VALUES
        (@id, @user_id, @title, @url, @folder, @tags, @notes, @favicon, @position, @created_at, @updated_at, @deleted_at)
       ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        url = excluded.url,
        folder = excluded.folder,
        tags = excluded.tags,
        notes = excluded.notes,
        favicon = excluded.favicon,
        position = excluded.position,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
       WHERE bookmarks.user_id = excluded.user_id`
    );

    const softDeleteMissing = db.prepare(
      `UPDATE bookmarks SET deleted_at = @ts, updated_at = @ts
       WHERE user_id = @userId AND deleted_at IS NULL
         AND id NOT IN (SELECT value FROM json_each(@ids))`
    );

    const run = db.transaction((items) => {
      const ids = [];
      for (const item of items) {
        if (!item.url && !item.id) continue;
        const id = item.id || uuidv4();
        ids.push(id);
        upsert.run({
          id,
          user_id: userId,
          title: item.title ?? '',
          url: item.url ?? '',
          folder: item.folder ?? '',
          tags: serializeTags(item.tags),
          notes: item.notes ?? '',
          favicon: item.favicon ?? null,
          position: Number.isFinite(item.position) ? item.position : 0,
          created_at: item.createdAt || ts,
          updated_at: item.updatedAt || ts,
          deleted_at: item.deletedAt ?? null,
        });
      }

      if (replace) {
        softDeleteMissing.run({ ts, userId, ids: JSON.stringify(ids) });
      }

      return ids.length;
    });

    const count = run(bookmarks);
    return {
      synced: count,
      bookmarks: this.findAll(userId, { includeDeleted: false }),
    };
  }

  static count(userId, { includeDeleted = false } = {}) {
    if (userId) {
      const db = getDb();
      if (includeDeleted) {
        return db.prepare('SELECT COUNT(*) AS c FROM bookmarks WHERE user_id = ?').get(userId).c;
      }
      return db
        .prepare('SELECT COUNT(*) AS c FROM bookmarks WHERE user_id = ? AND deleted_at IS NULL')
        .get(userId).c;
    }
    // Global count (info endpoint)
    const db = getDb();
    if (includeDeleted) {
      return db.prepare('SELECT COUNT(*) AS c FROM bookmarks').get().c;
    }
    return db.prepare('SELECT COUNT(*) AS c FROM bookmarks WHERE deleted_at IS NULL').get().c;
  }

  static countForUser(userId) {
    return this.count(userId, { includeDeleted: false });
  }

  static getMeta(key) {
    const db = getDb();
    const row = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  static setMeta(key, value) {
    const db = getDb();
    db.prepare(
      `INSERT INTO sync_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, String(value));
  }
}

module.exports = Bookmark;
