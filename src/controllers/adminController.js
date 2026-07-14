const User = require('../models/User');
const Bookmark = require('../models/Bookmark');
const { loginPage } = require('../views/login');
const { usersPage } = require('../views/users');
const {
  logger,
  getLogConfig,
  saveLevelToDb,
} = require('../utils/logger');
const { createRateLimiter } = require('../utils/rateLimit');

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

const adminController = {
  showLogin(req, res) {
    if (req.session?.user?.isAdmin) {
      return res.redirect('/');
    }
    res.type('html').send(loginPage({ error: null }));
  },

  login(req, res) {
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
      res.redirect('/login');
    });
  },

  listUsers(req, res) {
    const users = User.findAll();
    const counts = {};
    for (const u of users) {
      counts[u.id] = Bookmark.countForUser(u.id);
    }
    res.type('html').send(
      usersPage({
        user: req.user,
        users,
        flash: takeFlash(req),
        counts,
        logConfig: getLogConfig(),
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
};

module.exports = adminController;
