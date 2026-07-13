const Bookmark = require('../models/Bookmark');

function isValidUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const u = new URL(url);
    return ['http:', 'https:', 'ftp:', 'file:', 'chrome:', 'about:', 'edge:'].includes(
      u.protocol
    );
  } catch {
    return url.length > 0 && url.length < 8192;
  }
}

function validateBookmarkBody(body, { partial = false } = {}) {
  const errors = [];

  if (!partial || body.url !== undefined) {
    if (!isValidUrl(body.url)) {
      errors.push('url is required and must be a valid URL string');
    }
  }

  if (body.title !== undefined && typeof body.title !== 'string') {
    errors.push('title must be a string');
  }
  if (body.folder !== undefined && typeof body.folder !== 'string') {
    errors.push('folder must be a string');
  }
  if (body.tags !== undefined && !Array.isArray(body.tags) && typeof body.tags !== 'string') {
    errors.push('tags must be an array of strings');
  }
  if (body.notes !== undefined && typeof body.notes !== 'string') {
    errors.push('notes must be a string');
  }
  if (body.position !== undefined && !Number.isFinite(Number(body.position))) {
    errors.push('position must be a number');
  }

  return errors;
}

function checkPayloadSize(req, res) {
  const max = Number(process.env.MAX_SYNC_SIZE_BYTES) || 1048576;
  const length = Number(req.get('content-length') || 0);
  if (length > max) {
    res.status(413).json({
      error: `Payload too large (max ${max} bytes)`,
    });
    return false;
  }
  return true;
}

function userId(req) {
  return req.user.id;
}

const bookmarkController = {
  list(req, res) {
    try {
      const folder = req.query.folder !== undefined ? String(req.query.folder) : null;
      const includeDeleted = req.query.includeDeleted === 'true';
      const bookmarks = Bookmark.findAll(userId(req), {
        includeDeleted,
        folder: folder !== null ? folder : null,
      });
      res.json({ count: bookmarks.length, bookmarks });
    } catch (err) {
      console.error('list bookmarks:', err);
      res.status(500).json({ error: 'Failed to list bookmarks' });
    }
  },

  getById(req, res) {
    try {
      const bookmark = Bookmark.findById(userId(req), req.params.id);
      if (!bookmark) {
        return res.status(404).json({ error: 'Bookmark not found' });
      }
      res.json(bookmark);
    } catch (err) {
      console.error('get bookmark:', err);
      res.status(500).json({ error: 'Failed to get bookmark' });
    }
  },

  create(req, res) {
    try {
      if (!checkPayloadSize(req, res)) return;

      const errors = validateBookmarkBody(req.body);
      if (errors.length) {
        return res.status(400).json({ error: errors.join('; ') });
      }

      const bookmark = Bookmark.create(userId(req), req.body);
      res.status(201).json(bookmark);
    } catch (err) {
      if (err && err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        return res.status(409).json({ error: 'Bookmark with this id already exists' });
      }
      console.error('create bookmark:', err);
      res.status(500).json({ error: 'Failed to create bookmark' });
    }
  },

  update(req, res) {
    try {
      if (!checkPayloadSize(req, res)) return;

      const errors = validateBookmarkBody(req.body, { partial: true });
      if (errors.length) {
        return res.status(400).json({ error: errors.join('; ') });
      }

      const bookmark = Bookmark.update(userId(req), req.params.id, req.body);
      if (!bookmark) {
        return res.status(404).json({ error: 'Bookmark not found' });
      }
      res.json(bookmark);
    } catch (err) {
      console.error('update bookmark:', err);
      res.status(500).json({ error: 'Failed to update bookmark' });
    }
  },

  remove(req, res) {
    try {
      if (req.query.hard === 'true') {
        const ok = Bookmark.hardDelete(userId(req), req.params.id);
        if (!ok) {
          return res.status(404).json({ error: 'Bookmark not found' });
        }
        return res.status(204).send();
      }

      const bookmark = Bookmark.softDelete(userId(req), req.params.id);
      if (!bookmark) {
        return res.status(404).json({ error: 'Bookmark not found' });
      }
      res.json(bookmark);
    } catch (err) {
      console.error('delete bookmark:', err);
      res.status(500).json({ error: 'Failed to delete bookmark' });
    }
  },

  sync(req, res) {
    try {
      if (!checkPayloadSize(req, res)) return;

      if (process.env.ALLOW_NEW_SYNCS === 'false') {
        return res.status(403).json({ error: 'Sync is disabled on this service' });
      }

      const list = req.body?.bookmarks;
      if (!Array.isArray(list)) {
        return res.status(400).json({ error: 'body.bookmarks must be an array' });
      }

      const replace = Boolean(req.body.replace);
      const result = Bookmark.syncFromClient(userId(req), list, { replace });
      Bookmark.setMeta(`last_sync_at:${userId(req)}`, new Date().toISOString());

      res.json({
        synced: result.synced,
        count: result.bookmarks.length,
        bookmarks: result.bookmarks,
        lastSyncAt: Bookmark.getMeta(`last_sync_at:${userId(req)}`),
      });
    } catch (err) {
      console.error('sync bookmarks:', err);
      res.status(500).json({ error: 'Failed to sync bookmarks' });
    }
  },

  exportAll(req, res) {
    try {
      const includeDeleted = req.query.includeDeleted === 'true';
      const bookmarks = Bookmark.findAll(userId(req), { includeDeleted });
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        count: bookmarks.length,
        bookmarks,
      };
      res.setHeader('Content-Disposition', 'attachment; filename="bookmarks-export.json"');
      res.json(payload);
    } catch (err) {
      console.error('export bookmarks:', err);
      res.status(500).json({ error: 'Failed to export bookmarks' });
    }
  },

  importAll(req, res) {
    try {
      if (!checkPayloadSize(req, res)) return;

      const list = req.body?.bookmarks ?? req.body;
      if (!Array.isArray(list)) {
        return res.status(400).json({
          error: 'Expected { bookmarks: [...] } or a raw array of bookmarks',
        });
      }

      const replace = Boolean(req.body?.replace);
      const result = Bookmark.syncFromClient(userId(req), list, { replace });
      Bookmark.setMeta(`last_import_at:${userId(req)}`, new Date().toISOString());

      res.json({
        imported: result.synced,
        count: result.bookmarks.length,
        bookmarks: result.bookmarks,
      });
    } catch (err) {
      console.error('import bookmarks:', err);
      res.status(500).json({ error: 'Failed to import bookmarks' });
    }
  },
};

module.exports = bookmarkController;
