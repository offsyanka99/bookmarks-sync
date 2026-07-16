const Bookmark = require('../models/Bookmark');
const { logger } = require('../utils/logger');

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

function isForce(req) {
  return (
    req.query.force === 'true' ||
    req.body?.force === true ||
    req.body?.force === 'true'
  );
}

function sendResultError(res, result) {
  if (result.code === 'NOT_FOUND') {
    return res.status(404).json({ error: 'Bookmark not found' });
  }
  if (result.code === 'MISSING_UPDATED_AT') {
    return res.status(400).json({
      error: 'missing_updated_at',
      message: result.message,
      server: result.server,
    });
  }
  if (result.code === 'CONFLICT') {
    return res.status(409).json({
      error: 'conflict',
      reason: result.reason,
      message: result.message || 'Bookmark conflict',
      server: result.server,
      clientUpdatedAt: result.clientUpdatedAt,
    });
  }
  return res.status(500).json({ error: 'Unexpected result' });
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
      logger.info('bookmarks list', {
        userId: userId(req),
        username: req.user?.username,
        client: req.get('x-bookmarks-sync-client') || 'unknown',
        clientBrowser: req.get('x-bookmarks-sync-browser') || null,
        count: bookmarks.length,
        includeDeleted,
      });
      res.json({ count: bookmarks.length, bookmarks });
    } catch (err) {
      logger.error('list bookmarks failed', { err: err.message, stack: err.stack });
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
      logger.error('get bookmark failed', { err: err.message, stack: err.stack });
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

      const mergeDuplicates =
        req.query.merge === 'true' ||
        req.body?.merge === true ||
        req.body?.merge === 'true';

      const result = Bookmark.create(userId(req), req.body, { mergeDuplicates });
      if (!result.ok) {
        if (result.code === 'CONFLICT') {
          logger.info('create bookmark conflict', { userId: userId(req), reason: result.reason });
        }
        return sendResultError(res, result);
      }
      logger.debug('bookmark created', {
        userId: userId(req),
        id: result.bookmark.id,
        merged: Boolean(result.merged),
      });
      const status = result.merged ? 200 : 201;
      res.status(status).json({
        ...result.bookmark,
        ...(result.merged
          ? { merged: true, clientId: result.clientId || null }
          : {}),
      });
    } catch (err) {
      logger.error('create bookmark failed', { err: err.message, stack: err.stack });
      res.status(500).json({ error: 'Failed to create bookmark' });
    }
  },

  /**
   * GET /api/bookmarks/duplicates — folder-scoped URL twins for this user.
   */
  listDuplicates(req, res) {
    try {
      const report = Bookmark.findDuplicates(userId(req));
      res.json({
        groupCount: report.groupCount,
        extraCount: report.extraCount,
        groups: report.groups.map((g) => ({
          folder: g.folder,
          url: g.url,
          count: g.count,
          keepId: g.keepId,
          bookmarks: g.bookmarks,
        })),
      });
    } catch (err) {
      logger.error('list duplicates failed', { err: err.message, stack: err.stack });
      res.status(500).json({ error: 'Failed to list duplicates' });
    }
  },

  /**
   * POST /api/bookmarks/dedupe — soft-delete extras in each folder+url group.
   * Body: { dryRun?: boolean }
   */
  dedupe(req, res) {
    try {
      const dryRun =
        req.body?.dryRun === true ||
        req.body?.dryRun === 'true' ||
        req.query.dryRun === 'true';
      const result = Bookmark.dedupeByFolderUrl(userId(req), { dryRun });
      logger.info('bookmarks dedupe', {
        userId: userId(req),
        username: req.user?.username,
        dryRun: result.dryRun,
        groupCount: result.groupCount,
        removedCount: result.removedCount,
      });
      res.json(result);
    } catch (err) {
      logger.error('dedupe bookmarks failed', { err: err.message, stack: err.stack });
      res.status(500).json({ error: 'Failed to dedupe bookmarks' });
    }
  },

  update(req, res) {
    try {
      if (!checkPayloadSize(req, res)) return;

      const errors = validateBookmarkBody(req.body, { partial: true });
      if (errors.length) {
        return res.status(400).json({ error: errors.join('; ') });
      }

      const result = Bookmark.update(userId(req), req.params.id, req.body, {
        force: isForce(req),
      });
      if (!result.ok) {
        if (result.code === 'CONFLICT') {
          logger.info('update bookmark conflict', {
            userId: userId(req),
            id: req.params.id,
          });
        }
        return sendResultError(res, result);
      }
      res.json(result.bookmark);
    } catch (err) {
      logger.error('update bookmark failed', { err: err.message, stack: err.stack });
      res.status(500).json({ error: 'Failed to update bookmark' });
    }
  },

  remove(req, res) {
    try {
      const force = isForce(req);
      const updatedAt =
        req.query.updatedAt ||
        req.body?.updatedAt ||
        null;

      if (req.query.hard === 'true') {
        const result = Bookmark.hardDelete(userId(req), req.params.id, {
          updatedAt,
          force,
        });
        if (!result.ok) {
          return sendResultError(res, result);
        }
        return res.status(204).send();
      }

      const result = Bookmark.softDelete(userId(req), req.params.id, {
        updatedAt,
        force,
      });
      if (!result.ok) {
        return sendResultError(res, result);
      }
      res.json(result.bookmark);
    } catch (err) {
      logger.error('delete bookmark failed', { err: err.message, stack: err.stack });
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
      const force = Boolean(req.body.force);
      const lastSyncAt = req.body.lastSyncAt || null;
      const confirmDestructive = Boolean(req.body.confirmDestructive);

      // Failsafe: refuse replace that would soft-delete more than half of the library
      // unless the client explicitly confirms (manual override).
      const failsafePct = Number(process.env.SYNC_DESTRUCTIVE_PERCENT);
      const threshold = Number.isFinite(failsafePct) && failsafePct > 0 ? failsafePct : 50;
      if (replace && list.length > 0 && !confirmDestructive && !force) {
        const activeCount = Bookmark.count(userId(req), { includeDeleted: false });
        const clientIds = list.map((b) => b?.id).filter(Boolean);
        const wouldDelete = Bookmark.countActiveNotInIds(userId(req), clientIds);
        const percent = activeCount > 0 ? (wouldDelete / activeCount) * 100 : 0;
        // Only trip when the library is large enough to matter
        if (activeCount >= 10 && percent >= threshold) {
          const pct = Math.round(percent);
          const message =
            `The current sync run would delete ${pct}% of your bookmarks on the server ` +
            `(${wouldDelete} of ${activeCount}). Refusing to execute. ` +
            `Disable this failsafe in the extension settings or confirm a manual sync if you want to proceed. ` +
            `If you didn't cause this, use Download to replace this device with the server state.`;
          logger.warn('bookmarks sync refused (destructive failsafe)', {
            userId: userId(req),
            username: req.user?.username,
            client: req.get('x-bookmarks-sync-client') || 'unknown',
            wouldDelete,
            activeCount,
            percent: pct,
            threshold,
          });
          return res.status(409).json({
            error: 'destructive_refused',
            message,
            wouldDelete,
            activeCount,
            percent: pct,
            threshold,
            side: 'server',
          });
        }
      }

      const mergeDuplicates = req.body.mergeDuplicates !== false;

      const result = Bookmark.syncFromClient(userId(req), list, {
        replace,
        lastSyncAt,
        force,
        mergeDuplicates,
      });
      const lastSync = new Date().toISOString();
      Bookmark.setMeta(`last_sync_at:${userId(req)}`, lastSync);

      logger.info('bookmarks sync', {
        userId: userId(req),
        username: req.user?.username,
        client: req.get('x-bookmarks-sync-client') || 'unknown',
        clientBrowser: req.get('x-bookmarks-sync-browser') || null,
        clientVersion: req.get('x-bookmarks-sync-version') || null,
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        deleted: result.deleted,
        merged: result.merged,
        conflicts: result.conflicts.length,
        replace,
        force,
        bookmarkCount: list.length,
      });

      res.json({
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        skipped: result.skipped,
        deleted: result.deleted,
        merged: result.merged,
        merges: result.merges,
        processed: result.processed,
        conflicts: result.conflicts,
        count: result.bookmarks.length,
        bookmarks: result.bookmarks,
        lastSyncAt: lastSync,
      });
    } catch (err) {
      logger.error('sync bookmarks failed', { err: err.message, stack: err.stack });
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
      logger.error('export bookmarks failed', { err: err.message, stack: err.stack });
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
      const force = Boolean(req.body?.force);
      const lastSyncAt = req.body?.lastSyncAt || null;

      const mergeDuplicates = req.body?.mergeDuplicates !== false;

      const result = Bookmark.syncFromClient(userId(req), list, {
        replace,
        lastSyncAt,
        force,
        mergeDuplicates,
      });
      Bookmark.setMeta(`last_import_at:${userId(req)}`, new Date().toISOString());

      logger.info('bookmarks import', {
        userId: userId(req),
        created: result.created,
        updated: result.updated,
        merged: result.merged,
        conflicts: result.conflicts.length,
      });

      res.json({
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        skipped: result.skipped,
        deleted: result.deleted,
        merged: result.merged,
        merges: result.merges,
        conflicts: result.conflicts,
        count: result.bookmarks.length,
        bookmarks: result.bookmarks,
      });
    } catch (err) {
      logger.error('import bookmarks failed', { err: err.message, stack: err.stack });
      res.status(500).json({ error: 'Failed to import bookmarks' });
    }
  },
};

module.exports = bookmarkController;
