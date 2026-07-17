const User = require('../models/User');
const Bookmark = require('../models/Bookmark');
const { loginPage } = require('../views/login');
const { setupPage, setupCompletePage } = require('../views/setup');
const { usersPage } = require('../views/users');
const { needsSetup } = require('../utils/bootstrap');
const { resetDatabase } = require('../utils/db');
const {
  getAdminPasswordError,
  resolveBootstrapAdminUsername,
} = require('../utils/securityConfig');
const {
  logger,
  getLogConfig,
  saveLevelToDb,
  loadLevelFromDb,
} = require('../utils/logger');
const { createRateLimiter } = require('../utils/rateLimit');
const { zipStore } = require('../utils/zipStore');
const { resolveTimeFormat } = require('../utils/timeFormat');

function takeFlash(req) {
  const flash = req.session.flash || null;
  delete req.session.flash;
  return flash;
}

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

/** Failed + successful login attempts share a per-IP budget to slow brute force. */
const loginRateLimiter = createRateLimiter({
  windowMs: Number(process.env.LOGIN_RATE_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_MAX) || 20,
  message: 'Too many login attempts. Please wait and try again.',
  keyFn: (req) => `login:${req.ip || req.socket?.remoteAddress || 'unknown'}`,
});

/** First-run setup shares a similar per-IP budget. */
const setupRateLimiter = createRateLimiter({
  windowMs: Number(process.env.LOGIN_RATE_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_MAX) || 20,
  message: 'Too many setup attempts. Please wait and try again.',
  keyFn: (req) => `setup:${req.ip || req.socket?.remoteAddress || 'unknown'}`,
});

const adminController = {
  showSetup(req, res) {
    if (!needsSetup()) {
      return res.redirect('/login');
    }
    const username = resolveBootstrapAdminUsername();
    res.type('html').send(setupPage({ username }));
  },

  completeSetup(req, res) {
    if (!needsSetup()) {
      return res.redirect('/login');
    }

    const username = resolveBootstrapAdminUsername();
    const password = String(req.body.password || '');
    const passwordConfirm = String(req.body.passwordConfirm || '');

    const limited = setupRateLimiter.checkBlocked(req);
    if (limited.blocked) {
      res.set('Retry-After', String(limited.retryAfter));
      logger.warn('Admin setup rate-limited', { ip: req.ip });
      return res.status(429).type('html').send(
        setupPage({
          error: 'Too many setup attempts. Please wait and try again.',
          username,
        })
      );
    }

    if (password !== passwordConfirm) {
      setupRateLimiter.recordFailure(req);
      return res.status(400).type('html').send(
        setupPage({ error: 'Passwords do not match', username })
      );
    }

    const passwordError = getAdminPasswordError(password);
    if (passwordError) {
      setupRateLimiter.recordFailure(req);
      return res.status(400).type('html').send(
        setupPage({ error: passwordError, username })
      );
    }

    // Race: another request may have completed setup
    if (!needsSetup()) {
      return res.redirect('/login');
    }

    try {
      const admin = User.create({
        username,
        password,
        displayName: 'Administrator',
        isAdmin: true,
      });
      setupRateLimiter.reset(req);
      logger.info('First-run admin setup completed', {
        username: admin.username,
        ip: req.ip,
      });
      return res.type('html').send(
        setupCompletePage({
          username: admin.username,
          apiKey: admin.apiKey,
        })
      );
    } catch (err) {
      setupRateLimiter.recordFailure(req);
      logger.error('First-run admin setup failed', {
        err: err.message,
        ip: req.ip,
      });
      const message =
        err.code === 'CONFLICT'
          ? 'Admin already exists. Please log in.'
          : err.code === 'VALIDATION'
            ? err.message
            : 'Could not create admin. Try again.';
      if (err.code === 'CONFLICT') {
        return res.redirect('/login');
      }
      return res.status(400).type('html').send(
        setupPage({ error: message, username })
      );
    }
  },

  showLogin(req, res) {
    if (needsSetup()) {
      return res.redirect('/setup');
    }
    if (req.session?.user?.isAdmin) {
      return res.redirect('/');
    }
    res.type('html').send(loginPage({ error: null }));
  },

  login(req, res) {
    if (needsSetup()) {
      return res.redirect('/setup');
    }

    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    const limited = loginRateLimiter.checkBlocked(req);
    if (limited.blocked) {
      res.set('Retry-After', String(limited.retryAfter));
      logger.warn('Admin login rate-limited', { username, ip: req.ip });
      return res.status(429).type('html').send(
        loginPage({
          error: 'Too many login attempts. Please wait and try again.',
          username,
        })
      );
    }

    const user = User.authenticate(username, password);
    if (!user) {
      loginRateLimiter.recordFailure(req);
      logger.warn('Admin login failed', { username, ip: req.ip });
      return res.status(401).type('html').send(
        loginPage({ error: 'Invalid username or password', username })
      );
    }
    if (!user.isAdmin) {
      loginRateLimiter.recordFailure(req);
      logger.warn('Non-admin login rejected for admin UI', {
        username: user.username,
        ip: req.ip,
      });
      return res.status(403).type('html').send(
        loginPage({
          error: 'Only admin users can access this UI (v1).',
          username,
        })
      );
    }

    // Prevent session fixation: issue a new session id before attaching identity
    req.session.regenerate((err) => {
      if (err) {
        logger.error('Session regenerate failed on login', {
          err: err.message,
          username: user.username,
        });
        return res
          .status(500)
          .type('html')
          .send(loginPage({ error: 'Login failed (session error). Try again.', username }));
      }

      req.session.user = user;
      loginRateLimiter.reset(req);
      logger.info('Admin login success', { username: user.username, ip: req.ip });
      req.session.save((saveErr) => {
        if (saveErr) {
          logger.error('Session save failed on login', {
            err: saveErr.message,
            username: user.username,
          });
          return res
            .status(500)
            .type('html')
            .send(loginPage({ error: 'Login failed (session error). Try again.', username }));
        }
        res.redirect('/');
      });
    });
  },

  logout(req, res) {
    const username = req.session?.user?.username;
    req.session.destroy(() => {
      logger.info('Admin logout', { username });
      res.redirect(needsSetup() ? '/setup' : '/login');
    });
  },

  listUsers(req, res) {
    const users = User.findAll();
    const counts = {};
    const duplicateExtras = {};
    for (const u of users) {
      counts[u.id] = Bookmark.countForUser(u.id);
      const dup = Bookmark.findDuplicates(u.id);
      duplicateExtras[u.id] = dup.extraCount;
    }
    res.type('html').send(
      usersPage({
        user: req.user,
        users,
        flash: takeFlash(req),
        counts,
        duplicateExtras,
        logConfig: getLogConfig(),
        timeFormat: resolveTimeFormat(),
      })
    );
  },

  createUser(req, res) {
    try {
      const created = User.create({
        username: req.body.username,
        password: req.body.password,
        displayName: req.body.displayName || '',
        isAdmin: req.body.isAdmin === '1' || req.body.isAdmin === 'on',
      });
      logger.info('User created', {
        username: created.username,
        isAdmin: created.isAdmin,
        by: req.user?.username,
      });
      setFlash(
        req,
        'success',
        `User "${created.username}" created. API key: ${created.apiKey}`
      );
    } catch (err) {
      const msg =
        err.code === 'VALIDATION' || err.code === 'CONFLICT'
          ? err.message
          : 'Failed to create user';
      if (!err.code) logger.error('createUser failed', { err: err.message, stack: err.stack });
      else logger.warn('createUser rejected', { message: msg });
      setFlash(req, 'error', msg);
    }
    res.redirect('/');
  },

  regenerateKey(req, res) {
    const updated = User.regenerateApiKey(req.params.id);
    if (!updated) {
      setFlash(req, 'error', 'User not found');
    } else {
      logger.info('API key regenerated', {
        username: updated.username,
        by: req.user?.username,
      });
      setFlash(req, 'success', `New API key for ${updated.username}: ${updated.apiKey}`);
    }
    res.redirect('/');
  },

  setPassword(req, res) {
    try {
      const ok = User.updatePassword(req.params.id, req.body.password);
      if (!ok) {
        setFlash(req, 'error', 'User not found');
      } else {
        logger.info('User password updated', {
          userId: req.params.id,
          by: req.user?.username,
        });
        setFlash(req, 'success', 'Password updated');
      }
    } catch (err) {
      logger.warn('setPassword failed', { message: err.message });
      setFlash(req, 'error', err.code === 'VALIDATION' ? err.message : 'Failed to update password');
    }
    res.redirect('/');
  },

  enableUser(req, res) {
    if (req.params.id === req.user.id) {
      setFlash(req, 'error', 'You cannot change your own active status here');
      return res.redirect('/');
    }
    User.setActive(req.params.id, true);
    logger.info('User enabled', { userId: req.params.id, by: req.user?.username });
    setFlash(req, 'success', 'User enabled');
    res.redirect('/');
  },

  disableUser(req, res) {
    if (req.params.id === req.user.id) {
      setFlash(req, 'error', 'You cannot disable your own account');
      return res.redirect('/');
    }
    const target = User.findById(req.params.id);
    if (target?.isAdmin && User.countAdmins() <= 1) {
      setFlash(req, 'error', 'Cannot disable the last admin');
      return res.redirect('/');
    }
    User.setActive(req.params.id, false);
    logger.info('User disabled', { userId: req.params.id, by: req.user?.username });
    setFlash(req, 'success', 'User disabled');
    res.redirect('/');
  },

  deleteUser(req, res) {
    if (req.params.id === req.user.id) {
      setFlash(req, 'error', 'You cannot delete your own account');
      return res.redirect('/');
    }
    try {
      const ok = User.delete(req.params.id);
      if (ok) {
        logger.info('User deleted', { userId: req.params.id, by: req.user?.username });
      }
      setFlash(req, ok ? 'success' : 'error', ok ? 'User deleted' : 'User not found');
    } catch (err) {
      logger.warn('deleteUser failed', { message: err.message });
      setFlash(req, 'error', err.code === 'VALIDATION' ? err.message : 'Failed to delete user');
    }
    res.redirect('/');
  },

  setLogLevel(req, res) {
    try {
      const level = String(req.body.level || '').trim();
      const next = saveLevelToDb(Bookmark.setMeta.bind(Bookmark), level);
      setFlash(req, 'success', `Log level set to "${next}"`);
    } catch (err) {
      logger.warn('setLogLevel failed', { message: err.message });
      setFlash(
        req,
        'error',
        err.code === 'VALIDATION' ? err.message : 'Failed to update log level'
      );
    }
    res.redirect('/');
  },

  /**
   * Download one user's bookmarks as a ZIP containing JSON.
   * GET /users/:id/export?includeDeleted=1
   */
  exportUserBookmarks(req, res) {
    try {
      const target = User.findById(req.params.id);
      if (!target) {
        setFlash(req, 'error', 'User not found');
        return res.redirect('/');
      }

      const includeDeleted = req.query.includeDeleted === '1' || req.query.includeDeleted === 'true';
      const payload = Bookmark.exportForUser(target.id, { includeDeleted });
      payload.username = target.username;

      const safeName = String(target.username || 'user').replace(/[^a-zA-Z0-9._-]+/g, '_');
      const stamp = new Date().toISOString().slice(0, 10);
      const jsonName = `${safeName}-bookmarks.json`;
      const zipName = `${safeName}-bookmarks-${stamp}.zip`;

      const zip = zipStore([
        {
          name: jsonName,
          data: `${JSON.stringify(payload, null, 2)}\n`,
        },
      ]);

      logger.info('Admin export user bookmarks', {
        userId: target.id,
        username: target.username,
        count: payload.count,
        includeDeleted,
        by: req.user?.username,
      });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
      res.send(zip);
    } catch (err) {
      logger.error('exportUserBookmarks failed', { err: err.message, stack: err.stack });
      setFlash(req, 'error', 'Failed to export bookmarks');
      res.redirect('/');
    }
  },

  /**
   * Download all users' bookmarks as one ZIP (one JSON file per user).
   * GET /export/bookmarks?includeDeleted=1
   */
  exportAllBookmarks(req, res) {
    try {
      const includeDeleted = req.query.includeDeleted === '1' || req.query.includeDeleted === 'true';
      const users = User.findAll();
      const files = [];
      let total = 0;

      for (const u of users) {
        const payload = Bookmark.exportForUser(u.id, { includeDeleted });
        payload.username = u.username;
        total += payload.count;
        const safeName = String(u.username || u.id).replace(/[^a-zA-Z0-9._-]+/g, '_');
        files.push({
          name: `${safeName}-bookmarks.json`,
          data: `${JSON.stringify(payload, null, 2)}\n`,
        });
      }

      files.unshift({
        name: 'README.txt',
        data: [
          'Bookmarks Sync — admin export',
          `Exported at: ${new Date().toISOString()}`,
          `Users: ${users.length}`,
          `Total bookmarks (files): ${total}`,
          `includeDeleted: ${includeDeleted}`,
          '',
          'Each *-bookmarks.json file is the library for one user.',
          '',
        ].join('\n'),
      });

      const stamp = new Date().toISOString().slice(0, 10);
      const zipName = `all-bookmarks-${stamp}.zip`;
      const zip = zipStore(files);

      logger.info('Admin export all bookmarks', {
        users: users.length,
        total,
        includeDeleted,
        by: req.user?.username,
      });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
      res.send(zip);
    } catch (err) {
      logger.error('exportAllBookmarks failed', { err: err.message, stack: err.stack });
      setFlash(req, 'error', 'Failed to export all bookmarks');
      res.redirect('/');
    }
  },

  /**
   * Soft-delete folder-scoped URL duplicates for one user (keep newest).
   * POST /users/:id/dedupe-bookmarks
   */
  dedupeUserBookmarks(req, res) {
    try {
      const target = User.findById(req.params.id);
      if (!target) {
        setFlash(req, 'error', 'User not found');
        return res.redirect('/');
      }

      const result = Bookmark.dedupeByFolderUrl(target.id, { dryRun: false });
      logger.info('Admin deduped user bookmarks', {
        userId: target.id,
        username: target.username,
        groupCount: result.groupCount,
        removedCount: result.removedCount,
        by: req.user?.username,
      });
      if (result.removedCount === 0) {
        setFlash(
          req,
          'success',
          `No folder-scoped URL duplicates for "${target.username}".`
        );
      } else {
        setFlash(
          req,
          'success',
          `Deduped "${target.username}": soft-deleted ${result.removedCount} duplicate bookmark(s) across ${result.groupCount} group(s). Kept the newest of each folder+URL pair.`
        );
      }
    } catch (err) {
      logger.error('dedupeUserBookmarks failed', { err: err.message, stack: err.stack });
      setFlash(req, 'error', 'Failed to dedupe bookmarks');
    }
    res.redirect('/');
  },

  /**
   * Permanently delete all bookmarks for a user (keeps the user account).
   * POST /users/:id/clear-bookmarks
   */
  clearUserBookmarks(req, res) {
    try {
      const target = User.findById(req.params.id);
      if (!target) {
        setFlash(req, 'error', 'User not found');
        return res.redirect('/');
      }

      const removed = Bookmark.deleteAllForUser(target.id);
      logger.info('Admin cleared user bookmarks', {
        userId: target.id,
        username: target.username,
        removed,
        by: req.user?.username,
      });
      setFlash(
        req,
        'success',
        `Cleared ${removed} bookmark(s) for "${target.username}" (account kept).`
      );
    } catch (err) {
      logger.error('clearUserBookmarks failed', { err: err.message, stack: err.stack });
      setFlash(req, 'error', 'Failed to clear bookmarks');
    }
    res.redirect('/');
  },

  /**
   * Factory reset: wipe the entire database (all users including admins,
   * all bookmarks, meta), destroy the session, send the browser to first-run setup.
   * POST /settings/reset
   * Requires body.confirm_reset === '1' (checkbox in the confirm dialog).
   */
  resetToDefault(req, res) {
    const confirmed =
      req.body.confirm_reset === '1' ||
      req.body.confirm_reset === 'on' ||
      req.body.confirm_reset === true;

    if (!confirmed) {
      setFlash(
        req,
        'error',
        'Reset cancelled: you must confirm that you understand everything will be deleted.'
      );
      return res.redirect('/');
    }

    const by = req.user?.username;
    try {
      logger.warn('Factory reset requested — wiping database', { by, ip: req.ip });
      resetDatabase();
      // Log level was stored in DB meta; fall back to env/default after wipe
      try {
        loadLevelFromDb(Bookmark.getMeta.bind(Bookmark));
      } catch {
        // ignore — logger keeps previous in-memory level if meta is empty
      }
      logger.warn('Factory reset completed — database wiped', { by, ip: req.ip });
    } catch (err) {
      logger.error('Factory reset failed', {
        err: err.message,
        stack: err.stack,
        by,
      });
      setFlash(req, 'error', 'Factory reset failed. Check server logs.');
      return res.redirect('/');
    }

    // Destroy session after wipe so the cookie no longer maps to a user
    req.session.destroy(() => {
      res.redirect('/setup');
    });
  },
};

module.exports = adminController;
