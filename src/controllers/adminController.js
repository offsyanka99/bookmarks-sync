const User = require('../models/User');
const Bookmark = require('../models/Bookmark');
const { loginPage } = require('../views/login');
const { usersPage } = require('../views/users');

function takeFlash(req) {
  const flash = req.session.flash || null;
  delete req.session.flash;
  return flash;
}

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

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

    const user = User.authenticate(username, password);
    if (!user) {
      return res.status(401).type('html').send(
        loginPage({ error: 'Invalid username or password', username })
      );
    }
    if (!user.isAdmin) {
      return res.status(403).type('html').send(
        loginPage({
          error: 'Only admin users can access this UI (v1).',
          username,
        })
      );
    }

    req.session.user = user;
    req.session.save(() => {
      res.redirect('/');
    });
  },

  logout(req, res) {
    req.session.destroy(() => {
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
      setFlash(
        req,
        'success',
        `User "${created.username}" created. API key: ${created.apiKey}`
      );
    } catch (err) {
      const msg = err.code === 'VALIDATION' || err.code === 'CONFLICT'
        ? err.message
        : 'Failed to create user';
      if (!err.code) console.error('createUser:', err);
      setFlash(req, 'error', msg);
    }
    res.redirect('/');
  },

  regenerateKey(req, res) {
    const updated = User.regenerateApiKey(req.params.id);
    if (!updated) {
      setFlash(req, 'error', 'User not found');
    } else {
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
        setFlash(req, 'success', 'Password updated');
      }
    } catch (err) {
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
      setFlash(req, ok ? 'success' : 'error', ok ? 'User deleted' : 'User not found');
    } catch (err) {
      setFlash(req, 'error', err.code === 'VALIDATION' ? err.message : 'Failed to delete user');
    }
    res.redirect('/');
  },
};

module.exports = adminController;
