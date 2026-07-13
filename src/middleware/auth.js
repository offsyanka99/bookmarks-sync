const User = require('../models/User');

/**
 * API-key auth for /api/* routes (browser extension / scripts).
 * Accepts:
 *   Authorization: Bearer <user API key>
 *   X-API-Key: <user API key>
 *
 * Sets req.user on success.
 */
function requireApiKey(req, res, next) {
  const headerKey = req.get('x-api-key');
  const authHeader = req.get('authorization') || '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : null;

  const provided = headerKey || bearer;
  if (!provided) {
    return res.status(401).json({ error: 'Unauthorized: missing API key' });
  }

  const user = User.findByApiKey(provided);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized: invalid API key' });
  }

  req.user = user;
  return next();
}

/**
 * Session auth for admin web UI.
 * Redirects to login for browser navigations; JSON 401 for XHR.
 */
function requireSession(req, res, next) {
  if (req.session && req.session.user && req.session.user.id) {
    // Re-check active status periodically would be ideal; light check:
    const user = User.findById(req.session.user.id);
    if (user && user.isActive) {
      req.user = {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        isAdmin: user.isAdmin,
        isActive: user.isActive,
      };
      req.session.user = req.user;
      return next();
    }
    req.session.destroy(() => {});
  }

  if (req.accepts('html')) {
    return res.redirect('/login');
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

function requireAdmin(req, res, next) {
  requireSession(req, res, () => {
    if (!req.user || !req.user.isAdmin) {
      if (req.accepts('html')) {
        return res.status(403).send(renderForbidden());
      }
      return res.status(403).json({ error: 'Admin access required' });
    }
    return next();
  });
}

function renderForbidden() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Forbidden</title>
<link rel="stylesheet" href="/admin.css"/></head>
<body class="page"><main class="card"><h1>403 — Forbidden</h1>
<p>Admin access required.</p><p><a href="/login">Login</a></p></main></body></html>`;
}

module.exports = {
  requireApiKey,
  requireSession,
  requireAdmin,
  // backwards-compatible alias
  auth: requireApiKey,
};
