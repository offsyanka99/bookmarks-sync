const crypto = require('crypto');
const { logger } = require('../utils/logger');

function ensureCsrfToken(req) {
  if (!req.session) return '';
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function tokensMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function originMatchesHost(req) {
  const host = req.get('host');
  if (!host) return false;
  const candidate = req.get('origin') || req.get('referer');
  if (!candidate) return false;
  try {
    return new URL(candidate).host === host;
  } catch {
    return false;
  }
}

/**
 * Session synchronizer token plus Origin/Referer host check for admin POSTs.
 * SameSite=Lax does not stop another port on this host from submitting a form.
 */
function csrfMiddleware(req, res, next) {
  const token = ensureCsrfToken(req);
  res.locals.csrfToken = token;
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  const provided = req.body?._csrf || req.get('x-csrf-token');
  if (!originMatchesHost(req) || !tokensMatch(provided, token)) {
    logger.warn('Rejected admin request (CSRF)', {
      path: req.path,
      method: req.method,
      ip: req.ip,
    });
    if (req.accepts('html')) {
      return res.status(403).type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Forbidden</title>
<link rel="stylesheet" href="/admin.css"/></head>
<body class="page"><main class="card"><h1>403 — Forbidden</h1>
<p>The form token is missing or this request did not come from the admin site. Reload the page and try again.</p>
</main></body></html>`);
    }
    return res.status(403).json({ error: 'invalid_csrf' });
  }
  return next();
}

module.exports = { csrfMiddleware, ensureCsrfToken };
