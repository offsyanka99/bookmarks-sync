const User = require('../models/User');
const { needsSetup } = require('../utils/bootstrap');
const { createRateLimiter } = require('../utils/rateLimit');
const { logger } = require('../utils/logger');

// Failed API-key attempts only (valid keys do not consume the budget)
const apiKeyFailLimiter = createRateLimiter({
  windowMs: Number(process.env.API_KEY_RATE_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.API_KEY_RATE_MAX) || 60,
  message: 'Too many invalid API key attempts, try again later',
  keyFn: (req) => `apikey-fail:${req.ip || req.socket?.remoteAddress || 'unknown'}`,
});

/**
 * API-key auth for /api/* routes (browser extension / scripts).
 * Accepts:
 *   Authorization: Bearer <user API key>
 *   X-API-Key: <user API key>
 *
 * Sets req.user on success. Invalid/missing keys are rate-limited per IP.
 */
function requireApiKey(req, res, next) {
  const blocked = apiKeyFailLimiter.checkBlocked(req);
  if (blocked.blocked) {
    res.set('Retry-After', String(blocked.retryAfter));
    return res.status(429).json({
      error: 'Too many invalid API key attempts, try again later',
    });
  }

  const headerKey = req.get('x-api-key');
  const authHeader = req.get('authorization') || '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : null;

  const provided = headerKey || bearer;
  if (!provided) {
    apiKeyFailLimiter.recordFailure(req);
    return res.status(401).json({ error: 'Unauthorized: missing API key' });
  }

  const user = User.findByApiKey(provided);
  if (!user) {
    apiKeyFailLimiter.recordFailure(req);
    logger.warn('Invalid API key attempt', { ip: req.ip });
    return res.status(401).json({ error: 'Unauthorized: invalid API key' });
  }

  apiKeyFailLimiter.reset(req);
  req.user = user;
  return next();
}

/**
 * Session auth for admin web UI.
 * Redirects to login for browser navigations; JSON 401 for XHR.
 * First-run (no admin): redirect to /setup.
 */
function requireSession(req, res, next) {
  if (needsSetup()) {
    if (req.accepts('html')) {
      return res.redirect('/setup');
    }
    return res.status(503).json({ error: 'Admin setup required', setup: '/setup' });
  }

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
<link rel="icon" href="/favicon.ico" sizes="any"/>
<link rel="icon" type="image/png" href="/favicon.png"/>
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
