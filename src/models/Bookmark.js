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

/** Parse ISO timestamps for comparison; invalid → 0 */
function tsMs(iso) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
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

    // If client supplies an id that already exists for this user → conflict
    if (data.id) {
      const existing = this.findById(userId, data.id, { includeDeleted: true });
      if (existing) {
        return {
          ok: false,
          code: 'CONFLICT',
          reason: 'id_exists',
          server: existing,
        };
      }
    }

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

    try {
      db.prepare(
        `INSERT INTO bookmarks
          (id, user_id, title, url, folder, tags, notes, favicon, position, created_at, updated_at, deleted_at)
         VALUES
          (@id, @user_id, @title, @url, @folder, @tags, @notes, @favicon, @position, @created_at, @updated_at, @deleted_at)`
      ).run(record);
    } catch (err) {
      if (err && String(err.code || '').includes('CONSTRAINT')) {
        const server = this.findById(userId, id, { includeDeleted: true });
        return {
          ok: false,
          code: 'CONFLICT',
          reason: 'id_exists',
          server,
        };
      }
      throw err;
    }

    return {
      ok: true,
      bookmark: this.findById(userId, id, { includeDeleted: true }),
    };
  }

  /**
   * Optimistic update: client must send updatedAt matching server unless force=true.
   * @returns {{ ok: true, bookmark } | { ok: false, code, ... }}
   */
  static update(userId, id, data, { force = false } = {}) {
    const existing = this.findById(userId, id, { includeDeleted: true });
    if (!existing) {
      return { ok: false, code: 'NOT_FOUND' };
    }

    if (!force) {
      const clientUpdatedAt = data.updatedAt;
      if (!clientUpdatedAt) {
        return {
          ok: false,
          code: 'MISSING_UPDATED_AT',
          message:
            'Body must include updatedAt from the last GET (or use force=true to overwrite)',
          server: existing,
        };
      }
      if (String(clientUpdatedAt) !== String(existing.updatedAt)) {
        return {
          ok: false,
          code: 'CONFLICT',
          reason: 'updated_at_mismatch',
          message: 'Bookmark was modified on the server',
          server: existing,
          clientUpdatedAt: String(clientUpdatedAt),
        };
      }
    }

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

    return {
      ok: true,
      bookmark: this.findById(userId, id, { includeDeleted: true }),
    };
  }

  /**
   * Soft-delete with optional optimistic lock on updatedAt.
   */
  static softDelete(userId, id, { updatedAt = null, force = false } = {}) {
    const existing = this.findById(userId, id);
    if (!existing) {
      return { ok: false, code: 'NOT_FOUND' };
    }

    if (!force) {
      if (!updatedAt) {
        return {
          ok: false,
          code: 'MISSING_UPDATED_AT',
          message:
            'Provide updatedAt query/body from the last GET (or use force=true)',
          server: existing,
        };
      }
      if (String(updatedAt) !== String(existing.updatedAt)) {
        return {
          ok: false,
          code: 'CONFLICT',
          reason: 'updated_at_mismatch',
          message: 'Bookmark was modified on the server',
          server: existing,
          clientUpdatedAt: String(updatedAt),
        };
      }
    }

    const db = getDb();
    const ts = nowIso();
    db.prepare(
      `UPDATE bookmarks SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`
    ).run(ts, ts, id, userId);

    return {
      ok: true,
      bookmark: this.findById(userId, id, { includeDeleted: true }),
    };
  }

  static hardDelete(userId, id, { updatedAt = null, force = false } = {}) {
    userId = requireUserId(userId);
    const existing = this.findById(userId, id, { includeDeleted: true });
    if (!existing) {
      return { ok: false, code: 'NOT_FOUND' };
    }

    if (!force) {
      if (!updatedAt) {
        return {
          ok: false,
          code: 'MISSING_UPDATED_AT',
          message:
            'Provide updatedAt query/body from the last GET (or use force=true)',
          server: existing,
        };
      }
      if (String(updatedAt) !== String(existing.updatedAt)) {
        return {
          ok: false,
          code: 'CONFLICT',
          reason: 'updated_at_mismatch',
          message: 'Bookmark was modified on the server',
          server: existing,
          clientUpdatedAt: String(updatedAt),
        };
      }
    }

    const db = getDb();
    db.prepare('DELETE FROM bookmarks WHERE id = ? AND user_id = ?').run(id, userId);
    return { ok: true };
  }

  /**
   * Sync from client:
   * - create if missing
   * - update if client updatedAt is newer than server
   * - skip if server is newer (reported in conflicts)
   * - equal updatedAt → unchanged
   * - replace: soft-delete local-only ids (safer if lastSyncAt provided)
   */
  static syncFromClient(
    userId,
    bookmarks,
    { replace = false, lastSyncAt = null, force = false } = {}
  ) {
    userId = requireUserId(userId);
    const db = getDb();
    const ts = nowIso();

    const insert = db.prepare(
      `INSERT INTO bookmarks
        (id, user_id, title, url, folder, tags, notes, favicon, position, created_at, updated_at, deleted_at)
       VALUES
        (@id, @user_id, @title, @url, @folder, @tags, @notes, @favicon, @position, @created_at, @updated_at, @deleted_at)`
    );

    const updateRow = db.prepare(
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
    );

    const softDeleteMissingAggressive = db.prepare(
      `UPDATE bookmarks SET deleted_at = @ts, updated_at = @ts
       WHERE user_id = @userId AND deleted_at IS NULL
         AND id NOT IN (SELECT value FROM json_each(@ids))`
    );

    // Only soft-delete rows that have not been updated after the client's last sync
    const softDeleteMissingSafe = db.prepare(
      `UPDATE bookmarks SET deleted_at = @ts, updated_at = @ts
       WHERE user_id = @userId AND deleted_at IS NULL
         AND id NOT IN (SELECT value FROM json_each(@ids))
         AND updated_at <= @lastSyncAt`
    );

    const stats = {
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      deleted: 0,
    };
    const conflicts = [];

    const run = db.transaction((items) => {
      const ids = [];

      for (const item of items) {
        if (!item.url && !item.id) continue;

        const id = item.id || uuidv4();
        ids.push(id);

        const clientUpdatedAt = item.updatedAt || ts;
        const payload = {
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
          updated_at: clientUpdatedAt,
          deleted_at: item.deletedAt ?? null,
        };

        const existing = this.findById(userId, id, { includeDeleted: true });

        if (!existing) {
          insert.run({
            ...payload,
            created_at: item.createdAt || ts,
            updated_at: clientUpdatedAt,
          });
          stats.created += 1;
          continue;
        }

        // Wrong owner edge case (same id globally — should not happen with UUIDs)
        if (existing.userId !== userId) {
          conflicts.push({
            id,
            reason: 'not_owned',
            server: existing,
            client: item,
          });
          stats.skipped += 1;
          continue;
        }

        if (force) {
          updateRow.run(payload);
          stats.updated += 1;
          continue;
        }

        const clientMs = tsMs(clientUpdatedAt);
        const serverMs = tsMs(existing.updatedAt);

        if (clientMs > serverMs) {
          updateRow.run(payload);
          stats.updated += 1;
        } else if (clientMs < serverMs) {
          conflicts.push({
            id,
            reason: 'server_newer',
            server: existing,
            client: {
              id,
              title: item.title,
              url: item.url,
              updatedAt: clientUpdatedAt,
            },
          });
          stats.skipped += 1;
        } else {
          // Same timestamp — leave server row as-is
          stats.unchanged += 1;
        }
      }

      if (replace && ids.length >= 0) {
        const idsJson = JSON.stringify(ids);
        let result;
        if (force || !lastSyncAt) {
          // Aggressive: client set is source of truth for membership
          result = softDeleteMissingAggressive.run({ ts, userId, ids: idsJson });
        } else {
          // Safe: do not delete rows updated on server after client last synced
          result = softDeleteMissingSafe.run({
            ts,
            userId,
            ids: idsJson,
            lastSyncAt,
          });
        }
        stats.deleted = result.changes || 0;
      }

      return ids.length;
    });

    const processed = run(Array.isArray(bookmarks) ? bookmarks : []);

    return {
      processed,
      created: stats.created,
      updated: stats.updated,
      unchanged: stats.unchanged,
      skipped: stats.skipped,
      deleted: stats.deleted,
      conflicts,
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
