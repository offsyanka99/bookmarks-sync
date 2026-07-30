const { randomUUID } = require('crypto');
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

/**
 * Normalize URL for duplicate detection (folder-scoped).
 * Uses WHATWG URL when possible so equivalent forms compare equal.
 */
function normalizeUrl(url) {
  if (url == null) return '';
  const raw = String(url).trim();
  if (!raw) return '';
  try {
    return new URL(raw).href;
  } catch {
    return raw;
  }
}

/** True when this row is a real URL bookmark (not a folder / __dir__ placeholder). */
function isUrlBookmarkLike({ url, tags } = {}) {
  const tagsArr = parseTags(tags);
  if (tagsArr.includes('__dir__')) return false;
  const u = url == null ? '' : String(url).trim();
  if (!u) return false;
  if (u.startsWith('folder:')) return false;
  return true;
}

/**
 * Prefer keeper: newest updatedAt, then lowest position, then oldest createdAt, then id.
 * @param {object} a
 * @param {object} b
 * @returns {number} negative if a should rank before b
 */
function compareKeeperRank(a, b) {
  const ua = tsMs(a.updatedAt);
  const ub = tsMs(b.updatedAt);
  if (ua !== ub) return ub - ua; // newer first
  const pa = Number(a.position) || 0;
  const pb = Number(b.position) || 0;
  if (pa !== pb) return pa - pb; // lower position first
  const ca = tsMs(a.createdAt);
  const cb = tsMs(b.createdAt);
  if (ca !== cb) return ca - cb; // older first
  return String(a.id).localeCompare(String(b.id));
}

function duplicateKey(folder, url) {
  return `${String(folder ?? '')}\0${normalizeUrl(url)}`;
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
         ORDER BY folder ASC, position ASC, title ASC, id ASC`
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

  /**
   * Find an active URL bookmark with the same folder + normalized URL.
   * Folder rows and empty URLs are ignored.
   * @param {string} userId
   * @param {string} folder
   * @param {string} url
   * @param {{ excludeId?: string }} [opts]
   */
  static findActiveByFolderUrl(userId, folder, url, { excludeId = null } = {}) {
    userId = requireUserId(userId);
    if (!isUrlBookmarkLike({ url, tags: [] })) return null;

    const folderKey = folder ?? '';
    const target = normalizeUrl(url);
    if (!target) return null;

    // Narrow by folder + non-empty url, then normalize in JS (SQLite has no URL() ).
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT ${SELECT_COLS} FROM bookmarks
         WHERE user_id = ?
           AND deleted_at IS NULL
           AND folder = ?
           AND url IS NOT NULL
           AND TRIM(url) != ''
           AND (tags IS NULL OR tags NOT LIKE '%"__dir__"%')
         ORDER BY updated_at DESC, position ASC, created_at ASC, id ASC`
      )
      .all(userId, folderKey);

    for (const row of rows) {
      if (excludeId && row.id === excludeId) continue;
      if (!isUrlBookmarkLike(rowToBookmark(row))) continue;
      if (normalizeUrl(row.url) === target) {
        return rowToBookmark(row);
      }
    }
    return null;
  }

  /**
   * List folder-scoped URL duplicates for a user.
   * A group is the same (folder, normalizedUrl) with count ≥ 2.
   * @returns {{ groups: object[], groupCount: number, extraCount: number }}
   */
  static findDuplicates(userId) {
    userId = requireUserId(userId);
    const all = this.findAll(userId, { includeDeleted: false });
    /** @type {Map<string, object[]>} */
    const map = new Map();

    for (const b of all) {
      if (!isUrlBookmarkLike(b)) continue;
      const key = duplicateKey(b.folder, b.url);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(b);
    }

    const groups = [];
    let extraCount = 0;
    for (const items of map.values()) {
      if (items.length < 2) continue;
      items.sort(compareKeeperRank);
      extraCount += items.length - 1;
      groups.push({
        folder: items[0].folder ?? '',
        url: normalizeUrl(items[0].url),
        count: items.length,
        keepId: items[0].id,
        bookmarks: items,
      });
    }

    groups.sort((a, b) => {
      if (a.folder !== b.folder) return String(a.folder).localeCompare(String(b.folder));
      return String(a.url).localeCompare(String(b.url));
    });

    return {
      groups,
      groupCount: groups.length,
      extraCount,
    };
  }

  /**
   * Soft-delete extras in each folder+url group (keep best-ranked row).
   * @param {string} userId
   * @param {{ dryRun?: boolean }} [opts]
   */
  static dedupeByFolderUrl(userId, { dryRun = false } = {}) {
    userId = requireUserId(userId);
    const { groups, groupCount, extraCount } = this.findDuplicates(userId);
    const removed = [];
    const kept = [];

    const run = () => {
      for (const g of groups) {
        const [keeper, ...extras] = g.bookmarks;
        kept.push({ id: keeper.id, folder: g.folder, url: g.url });
        for (const extra of extras) {
          if (!dryRun) {
            const result = this.softDelete(userId, extra.id, { force: true });
            if (result.ok) {
              removed.push({
                id: extra.id,
                folder: g.folder,
                url: g.url,
                title: extra.title,
                keptId: keeper.id,
              });
            }
          } else {
            removed.push({
              id: extra.id,
              folder: g.folder,
              url: g.url,
              title: extra.title,
              keptId: keeper.id,
            });
          }
        }
      }
    };

    if (dryRun) {
      run();
    } else {
      const db = getDb();
      db.transaction(run)();
    }

    return {
      dryRun: Boolean(dryRun),
      groupCount,
      extraCount,
      removedCount: removed.length,
      kept,
      removed,
    };
  }

  static create(userId, data, { mergeDuplicates = false } = {}) {
    userId = requireUserId(userId);
    const db = getDb();
    const id = data.id || randomUUID();
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

    const folder = data.folder ?? '';
    const url = data.url ?? '';
    const tags = data.tags;
    // Folder-scoped URL twin: merge (update existing) or conflict
    if (isUrlBookmarkLike({ url, tags })) {
      const twin = this.findActiveByFolderUrl(userId, folder, url);
      if (twin) {
        if (mergeDuplicates) {
          const result = this.update(
            userId,
            twin.id,
            {
              title: data.title !== undefined ? data.title : twin.title,
              url: data.url !== undefined ? data.url : twin.url,
              folder: data.folder !== undefined ? data.folder : twin.folder,
              tags: data.tags !== undefined ? data.tags : twin.tags,
              notes: data.notes !== undefined ? data.notes : twin.notes,
              favicon: data.favicon !== undefined ? data.favicon : twin.favicon,
              position:
                data.position !== undefined && Number.isFinite(data.position)
                  ? data.position
                  : twin.position,
              updatedAt: twin.updatedAt,
            },
            { force: true }
          );
          if (result.ok) {
            return {
              ok: true,
              merged: true,
              clientId: data.id || null,
              bookmark: result.bookmark,
            };
          }
        }
        return {
          ok: false,
          code: 'CONFLICT',
          reason: 'duplicate_url',
          message:
            'An active bookmark with the same folder and URL already exists. ' +
            'Pass merge=true to update it, or change folder/url.',
          server: twin,
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
   * Soft-deleted rows for a user, optionally only those updated at/after `since`.
   * Used so other clients can apply remote deletes (tombstones).
   * @param {string} userId
   * @param {{ since?: string|null }} [opts]
   */
  static findDeleted(userId, { since = null } = {}) {
    userId = requireUserId(userId);
    const db = getDb();
    if (since) {
      const rows = db
        .prepare(
          `SELECT ${SELECT_COLS} FROM bookmarks
           WHERE user_id = ? AND deleted_at IS NOT NULL AND updated_at >= ?
           ORDER BY updated_at DESC, id ASC`
        )
        .all(userId, since);
      return rows.map(rowToBookmark);
    }
    const rows = db
      .prepare(
        `SELECT ${SELECT_COLS} FROM bookmarks
         WHERE user_id = ? AND deleted_at IS NOT NULL
         ORDER BY updated_at DESC, id ASC`
      )
      .all(userId);
    return rows.map(rowToBookmark);
  }

  /**
   * Sync from client:
   * - create if missing (or merge into same folder+url twin when ids differ)
   * - update if client updatedAt is newer than server
   * - skip if server is newer (reported in conflicts)
   * - equal updatedAt → unchanged
   * - tombstones (deletedAt set): soft-delete when client time wins (LWW)
   * - sticky soft-delete: live payload cannot resurrect unless force=true
   * - replace: soft-delete server ids missing from live payload
   *   (knownIds always eligible; otherwise only rows with updated_at <= lastSyncAt)
   */
  static syncFromClient(
    userId,
    bookmarks,
    {
      replace = false,
      lastSyncAt = null,
      force = false,
      mergeDuplicates = true,
      knownIds = null,
    } = {}
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

    // Client previously knew these ids and omitted them from the live set → delete
    // even if another device bumped updated_at after this client's lastSyncAt.
    const softDeleteMissingKnown = db.prepare(
      `UPDATE bookmarks SET deleted_at = @ts, updated_at = @ts
       WHERE user_id = @userId AND deleted_at IS NULL
         AND id NOT IN (SELECT value FROM json_each(@ids))
         AND id IN (SELECT value FROM json_each(@knownIds))`
    );

    const stats = {
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      deleted: 0,
      merged: 0,
    };
    const conflicts = [];
    /** @type {{ clientId: string, serverId: string, folder: string, url: string }[]} */
    const merges = [];
    /** @type {Set<string>} server ids soft-deleted or confirmed deleted this run */
    const tombstoneIdsTouched = new Set();

    /**
     * Apply update rules against an existing row (by resolved id).
     * Mutates payload.id to the resolved server id.
     * @returns {'live'|'deleted'|'skipped'}
     */
    const applyAgainstExisting = (existing, payload, item, clientUpdatedAt) => {
      payload.id = existing.id;

      if (existing.userId !== userId) {
        conflicts.push({
          id: existing.id,
          reason: 'not_owned',
          server: existing,
          client: item,
        });
        stats.skipped += 1;
        return 'skipped';
      }

      const clientDeletedAt = payload.deleted_at || item.deletedAt || null;
      const isTombstone = Boolean(clientDeletedAt);

      // --- Tombstone: soft-delete when client revision wins (LWW on updated_at) ---
      if (isTombstone && !force) {
        const clientMs = Math.max(tsMs(clientDeletedAt), tsMs(clientUpdatedAt));
        const serverMs = tsMs(existing.updatedAt);
        // Already soft-deleted and client is not newer
        if (existing.deletedAt && clientMs <= serverMs) {
          stats.unchanged += 1;
          tombstoneIdsTouched.add(existing.id);
          return 'deleted';
        }
        // Client wins (delete wins ties against live rows)
        if (clientMs >= serverMs) {
          const delTs = clientDeletedAt || ts;
          updateRow.run({
            ...payload,
            updated_at: delTs,
            deleted_at: delTs,
          });
          stats.deleted += 1;
          tombstoneIdsTouched.add(existing.id);
          return 'deleted';
        }
        // Server has a newer live revision — keep it
        conflicts.push({
          id: existing.id,
          reason: 'server_newer',
          server: existing,
          client: {
            id: item.id || existing.id,
            deletedAt: clientDeletedAt,
            updatedAt: clientUpdatedAt,
          },
        });
        stats.skipped += 1;
        return existing.deletedAt ? 'deleted' : 'skipped';
      }

      // --- Sticky soft-delete: live payload must not resurrect (unless force) ---
      if (existing.deletedAt && !isTombstone && !force) {
        conflicts.push({
          id: existing.id,
          reason: 'server_deleted',
          server: existing,
          client: {
            id: item.id || existing.id,
            title: item.title,
            url: item.url,
            folder: item.folder,
            position: item.position,
            updatedAt: clientUpdatedAt,
          },
        });
        stats.skipped += 1;
        tombstoneIdsTouched.add(existing.id);
        return 'deleted';
      }

      if (force) {
        updateRow.run(payload);
        stats.updated += 1;
        return payload.deleted_at ? 'deleted' : 'live';
      }

      const clientMs = tsMs(clientUpdatedAt);
      const serverMs = tsMs(existing.updatedAt);

      const contentChanged =
        String(existing.title || '') !== String(payload.title || '') ||
        String(existing.url || '') !== String(payload.url || '') ||
        String(existing.folder || '') !== String(payload.folder || '') ||
        Number(existing.position) !== Number(payload.position) ||
        String(existing.notes || '') !== String(payload.notes || '') ||
        serializeTags(existing.tags) !== String(payload.tags || '[]') ||
        String(existing.favicon || '') !== String(payload.favicon || '');

      if (clientMs > serverMs) {
        updateRow.run(payload);
        stats.updated += 1;
        return payload.deleted_at ? 'deleted' : 'live';
      }
      if (clientMs < serverMs) {
        conflicts.push({
          id: existing.id,
          reason: 'server_newer',
          server: existing,
          client: {
            id: item.id || existing.id,
            title: item.title,
            url: item.url,
            folder: item.folder,
            position: item.position,
            updatedAt: clientUpdatedAt,
          },
        });
        stats.skipped += 1;
        return existing.deletedAt ? 'deleted' : 'live';
      }
      if (contentChanged) {
        // Same timestamp but order/folder/title/url differ — still apply (reorder case)
        updateRow.run({ ...payload, updated_at: ts });
        stats.updated += 1;
        return payload.deleted_at ? 'deleted' : 'live';
      }
      stats.unchanged += 1;
      return existing.deletedAt || payload.deleted_at ? 'deleted' : 'live';
    };

    const run = db.transaction((items) => {
      /** All resolved ids touched this run (live + tombstone). */
      const seenIds = [];
      /** Resolved ids that should remain active after this sync. */
      const liveIds = [];
      // Within one payload, track folder+url → first server id so batch dups collapse
      /** @type {Map<string, string>} */
      const batchUrlIndex = new Map();

      for (const item of items) {
        // Allow folder rows (empty url + __dir__ tag) and normal URL bookmarks
        const tagsArr = Array.isArray(item.tags)
          ? item.tags
          : typeof item.tags === 'string'
            ? (() => {
                try {
                  const p = JSON.parse(item.tags);
                  return Array.isArray(p) ? p : [];
                } catch {
                  return [];
                }
              })()
            : [];
        const clientDeletedAt = item.deletedAt ?? null;
        const isTombstone = Boolean(clientDeletedAt);
        const isDir =
          !isTombstone &&
          (tagsArr.includes('__dir__') || item.url === '' || item.url == null);

        // Tombstones only need an id; live rows need url/title as before
        if (isTombstone) {
          if (!item.id) continue;
        } else {
          if (!item.url && !item.id && !isDir) continue;
          if (isDir && !item.title && !item.id) continue;
        }

        let id = item.id || randomUUID();
        const clientUpdatedAt = item.updatedAt || clientDeletedAt || ts;
        const payload = {
          id,
          user_id: userId,
          title: item.title ?? '',
          url: item.url ?? '',
          folder: item.folder ?? '',
          tags: serializeTags(
            isDir ? [...new Set([...tagsArr, '__dir__'])] : tagsArr
          ),
          notes: item.notes ?? '',
          favicon: item.favicon ?? null,
          position: Number.isFinite(item.position) ? item.position : 0,
          created_at: item.createdAt || ts,
          updated_at: clientUpdatedAt,
          deleted_at: clientDeletedAt,
        };

        let existing = this.findById(userId, id, { includeDeleted: true });

        // Tombstone for unknown id: record soft-deleted row so membership stays consistent
        if (!existing && isTombstone) {
          const delTs = clientDeletedAt || ts;
          insert.run({
            ...payload,
            created_at: item.createdAt || delTs,
            updated_at: delTs,
            deleted_at: delTs,
          });
          stats.deleted += 1;
          tombstoneIdsTouched.add(id);
          seenIds.push(id);
          continue;
        }

        // Folder-scoped URL merge: client id is new but same folder+url already exists
        // (skip for tombstones — they match by id only)
        if (
          !existing &&
          !isTombstone &&
          mergeDuplicates &&
          !isDir &&
          isUrlBookmarkLike({ url: payload.url, tags: tagsArr })
        ) {
          const key = duplicateKey(payload.folder, payload.url);
          let twinId = batchUrlIndex.get(key);
          let twin = twinId
            ? this.findById(userId, twinId, { includeDeleted: true })
            : this.findActiveByFolderUrl(userId, payload.folder, payload.url);

          if (twin) {
            merges.push({
              clientId: id,
              serverId: twin.id,
              folder: payload.folder,
              url: normalizeUrl(payload.url),
            });
            stats.merged += 1;
            const outcome = applyAgainstExisting(twin, payload, item, clientUpdatedAt);
            seenIds.push(twin.id);
            if (outcome === 'live') liveIds.push(twin.id);
            batchUrlIndex.set(key, twin.id);
            continue;
          }
          batchUrlIndex.set(key, id);
        } else if (
          existing &&
          !isTombstone &&
          mergeDuplicates &&
          !isDir &&
          isUrlBookmarkLike({ url: payload.url, tags: tagsArr })
        ) {
          batchUrlIndex.set(duplicateKey(payload.folder, payload.url), existing.id);
        }

        if (!existing) {
          insert.run({
            ...payload,
            created_at: item.createdAt || ts,
            updated_at: clientUpdatedAt,
          });
          if (isTombstone) {
            stats.deleted += 1;
            tombstoneIdsTouched.add(id);
            seenIds.push(id);
          } else {
            stats.created += 1;
            seenIds.push(id);
            liveIds.push(id);
          }
          continue;
        }

        const outcome = applyAgainstExisting(existing, payload, item, clientUpdatedAt);
        seenIds.push(existing.id);
        if (outcome === 'live') liveIds.push(existing.id);
      }

      // Replace membership: soft-delete active server rows not in the live client set.
      // Never run when the client sent no live rows (would wipe the library); upload uses force.
      // Tombstones / sticky deletes are already applied above.
      if (replace && liveIds.length > 0) {
        const uniqueLive = [...new Set(liveIds)];
        const idsJson = JSON.stringify(uniqueLive);
        let deletedCount = 0;

        const known = Array.isArray(knownIds)
          ? [...new Set(knownIds.filter(Boolean).map(String))]
          : [];
        if (known.length > 0) {
          const knownResult = softDeleteMissingKnown.run({
            ts,
            userId,
            ids: idsJson,
            knownIds: JSON.stringify(known),
          });
          deletedCount += knownResult.changes || 0;
        }

        let result;
        if (force) {
          result = softDeleteMissingAggressive.run({ ts, userId, ids: idsJson });
        } else if (lastSyncAt) {
          // Safe: do not delete rows updated on server after client last synced
          // (unless already removed via knownIds above)
          result = softDeleteMissingSafe.run({
            ts,
            userId,
            ids: idsJson,
            lastSyncAt,
          });
        } else {
          result = softDeleteMissingAggressive.run({ ts, userId, ids: idsJson });
        }
        deletedCount += result.changes || 0;
        stats.deleted += deletedCount;
      }

      return seenIds.length;
    });

    const processed = run(Array.isArray(bookmarks) ? bookmarks : []);

    // Tombstones for peers: soft-deletes since lastSyncAt, plus any touched this run
    let tombstones = this.findDeleted(userId, { since: lastSyncAt || null });
    if (!lastSyncAt && tombstoneIdsTouched.size > 0) {
      const allDeleted = this.findDeleted(userId, { since: null });
      tombstones = allDeleted.filter((b) => tombstoneIdsTouched.has(b.id));
    } else if (tombstoneIdsTouched.size > 0) {
      const byId = new Map(tombstones.map((b) => [b.id, b]));
      for (const id of tombstoneIdsTouched) {
        if (!byId.has(id)) {
          const row = this.findById(userId, id, { includeDeleted: true });
          if (row?.deletedAt) {
            byId.set(id, row);
          }
        }
      }
      tombstones = [...byId.values()];
    }

    return {
      processed,
      created: stats.created,
      updated: stats.updated,
      unchanged: stats.unchanged,
      skipped: stats.skipped,
      deleted: stats.deleted,
      merged: stats.merged,
      merges,
      conflicts,
      bookmarks: this.findAll(userId, { includeDeleted: false }),
      tombstones,
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

  /**
   * Admin table count: URL bookmarks only (exclude folder rows with __dir__ / empty url).
   */
  static countForUser(userId) {
    userId = requireUserId(userId);
    const db = getDb();
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM bookmarks
         WHERE user_id = ?
           AND deleted_at IS NULL
           AND url IS NOT NULL
           AND TRIM(url) != ''
           AND (tags IS NULL OR tags NOT LIKE '%"__dir__"%')`
      )
      .get(userId);
    return row?.c || 0;
  }

  /**
   * How many active rows would soft-delete if replace kept only clientIds.
   * @param {string} userId
   * @param {Iterable<string>} clientIds
   */
  static countActiveNotInIds(userId, clientIds) {
    userId = requireUserId(userId);
    const db = getDb();
    const ids = [...new Set([...clientIds].filter(Boolean))];
    if (ids.length === 0) {
      return this.count(userId, { includeDeleted: false });
    }
    // SQLite has parameter limits; chunk large ID lists
    const active = this.count(userId, { includeDeleted: false });
    if (active === 0) return 0;

    let kept = 0;
    const chunkSize = 400;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const row = db
        .prepare(
          `SELECT COUNT(*) AS c FROM bookmarks
           WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`
        )
        .get(userId, ...chunk);
      kept += row?.c || 0;
    }
    // kept may overcount if same id in multiple chunks — ids are unique so OK
    return Math.max(0, active - kept);
  }

  /**
   * Permanently delete all bookmarks for a user (active + soft-deleted).
   * @returns {number} rows removed
   */
  static deleteAllForUser(userId) {
    userId = requireUserId(userId);
    const db = getDb();
    const result = db.prepare('DELETE FROM bookmarks WHERE user_id = ?').run(userId);
    return result.changes || 0;
  }

  /**
   * Export payload for admin download / backups.
   */
  static exportForUser(userId, { includeDeleted = false } = {}) {
    const bookmarks = this.findAll(userId, { includeDeleted });
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      userId,
      count: bookmarks.length,
      bookmarks,
    };
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
module.exports.normalizeUrl = normalizeUrl;
module.exports.isUrlBookmarkLike = isUrlBookmarkLike;
