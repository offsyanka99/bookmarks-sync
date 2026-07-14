/**
 * Simple in-memory fixed-window rate limiter (per process).
 * Suitable for a single-instance self-hosted deploy.
 */

function createRateLimiter(options = {}) {
  const windowMs = Number(options.windowMs) || 15 * 60 * 1000;
  const max = Number(options.max) || 20;
  const message = options.message || 'Too many requests, try again later';
  const keyFn =
    options.keyFn ||
    ((req) => `${req.ip || req.socket?.remoteAddress || 'unknown'}`);
  const skipSuccessful =
    options.skipSuccessful === true; /* only count when recordFailure is used */

  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();

  // Periodic cleanup to avoid unbounded growth
  const cleanupMs = Math.min(windowMs, 60 * 1000);
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) {
      if (entry.resetAt <= now) buckets.delete(key);
    }
  }, cleanupMs);
  if (typeof timer.unref === 'function') timer.unref();

  function getEntry(key) {
    const now = Date.now();
    let entry = buckets.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }
    return entry;
  }

  function isBlocked(key) {
    const entry = getEntry(key);
    return entry.count >= max;
  }

  function hit(key) {
    const entry = getEntry(key);
    entry.count += 1;
    return entry;
  }

  function retryAfterSec(key) {
    const entry = buckets.get(key);
    if (!entry) return Math.ceil(windowMs / 1000);
    return Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
  }

  /**
   * Middleware: count every request toward the limit.
   * For failure-only limiting, use checkBlocked + recordFailure instead.
   */
  function middleware(req, res, next) {
    const key = keyFn(req);
    if (isBlocked(key)) {
      res.set('Retry-After', String(retryAfterSec(key)));
      if (req.accepts('html')) {
        return res
          .status(429)
          .type('html')
          .send(
            `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Too many requests</title>
<link rel="stylesheet" href="/admin.css"/></head>
<body class="page"><main class="card"><h1>429 — Too many requests</h1>
<p>${message}</p><p><a href="/login">Back to login</a></p></main></body></html>`
          );
      }
      return res.status(429).json({ error: message });
    }
    if (!skipSuccessful) {
      hit(key);
    }
    req.rateLimitKey = key;
    return next();
  }

  /** Fail closed if already over limit (does not increment). */
  function checkBlocked(req) {
    const key = keyFn(req);
    if (isBlocked(key)) {
      return { blocked: true, retryAfter: retryAfterSec(key), key };
    }
    return { blocked: false, key };
  }

  /** Record a failed auth attempt. */
  function recordFailure(reqOrKey) {
    const key =
      typeof reqOrKey === 'string' ? reqOrKey : keyFn(reqOrKey);
    return hit(key);
  }

  /** Clear counter after successful auth (optional). */
  function reset(reqOrKey) {
    const key =
      typeof reqOrKey === 'string' ? reqOrKey : keyFn(reqOrKey);
    buckets.delete(key);
  }

  return {
    middleware,
    checkBlocked,
    recordFailure,
    reset,
    isBlocked,
    hit,
  };
}

module.exports = { createRateLimiter };
