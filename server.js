require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const { getDb, closeDb } = require('./src/utils/db');
const { bootstrapAdmin } = require('./src/utils/bootstrap');
const {
  logger,
  morganStream,
  loadLevelFromDb,
  getLogConfig,
  LOG_DIR,
} = require('./src/utils/logger');
const {
  resolveSessionSecret,
  resolveSessionMaxAgeMs,
  resolveSessionMaxAgeMinutes,
} = require('./src/utils/securityConfig');
const bookmarksRouter = require('./src/routes/bookmarks');
const adminRouter = require('./src/routes/admin');
const Bookmark = require('./src/models/Bookmark');

const API_PORT = Number(process.env.SERVER_PORT) || 31059;
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 31060;
const HOST = process.env.SERVER_HOST || '0.0.0.0';
// Env SESSION_SECRET, or auto-generated file next to the DB
const SESSION_SECRET = resolveSessionSecret();
const publicDir = path.join(__dirname, 'public');

// HTTP access log format → winston (stdout + files)
const morganFormat =
  process.env.NODE_ENV === 'production' ? 'combined' : 'dev';

/**
 * Security headers for API + admin.
 *
 * Helmet’s default CSP includes `upgrade-insecure-requests`, which makes browsers
 * rewrite subresource loads (CSS, icons) to HTTPS. That breaks plain HTTP LAN
 * deploys (TrueNAS, home lab): HTML loads over http:// but /admin.css is blocked.
 *
 * When COOKIE_SECURE=true we assume HTTPS (reverse proxy / TLS) and keep the
 * upgrade + HSTS defaults. Otherwise disable them.
 */
function createHelmet() {
  const httpsOnly = process.env.COOKIE_SECURE === 'true';
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'", "'unsafe-inline'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        // null removes the Helmet default directive
        ...(httpsOnly ? {} : { upgradeInsecureRequests: null }),
      },
    },
    // HSTS is only meaningful over HTTPS; omit on HTTP-only LAN
    hsts: httpsOnly,
  });
}

/**
 * CORS for the bookmark API.
 * - Unset / empty: no CORS middleware (non-browser clients and same-origin only)
 * - "*": reflect any Origin (dev / explicit open)
 * - comma-separated list: allowlist only
 */
function createApiCors() {
  const raw = (process.env.CORS_ORIGINS || '').trim();
  if (!raw) {
    return null;
  }

  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
  const allowedHeaders = ['Content-Type', 'Authorization', 'X-API-Key'];

  if (raw === '*') {
    return cors({
      origin: true,
      methods,
      allowedHeaders,
    });
  }

  const allowlist = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return cors({
    origin(origin, callback) {
      // Non-browser clients (curl, extensions without Origin) — allow
      if (!origin) {
        return callback(null, true);
      }
      if (allowlist.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    methods,
    allowedHeaders,
  });
}

function applyTrustProxy(app) {
  const raw = (process.env.TRUST_PROXY || '').trim().toLowerCase();
  if (!raw || raw === 'false' || raw === '0') {
    return;
  }
  if (raw === 'true' || raw === '1') {
    app.set('trust proxy', 1);
    return;
  }
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum >= 0) {
    app.set('trust proxy', asNum);
    return;
  }
  // e.g. "loopback", "uniquelocal", or a subnet list
  app.set('trust proxy', process.env.TRUST_PROXY);
}

function jsonErrorHandler(err, req, res, _next) {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed by CORS' });
  }
  logger.error('Unhandled API error', {
    err: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }
  res.status(500).json({ error: 'Internal server error' });
}

// --- Bookmark sync API (SERVER_PORT) ---
const apiApp = express();
applyTrustProxy(apiApp);
apiApp.use(createHelmet());
const apiCors = createApiCors();
if (apiCors) {
  apiApp.use(apiCors);
}
apiApp.use(morgan(morganFormat, { stream: morganStream }));
// Brand icons / favicon (same public assets as admin UI)
apiApp.use(express.static(publicDir, { index: false }));
apiApp.use(express.json({ limit: process.env.MAX_SYNC_SIZE_BYTES || '1mb' }));

apiApp.get('/health', (_req, res) => {
  try {
    getDb();
    res.json({ status: 'ok', uptime: process.uptime() });
  } catch (err) {
    logger.error('Health check failed', { err: err.message });
    res.status(503).json({ status: 'error', error: 'database unavailable' });
  }
});

// Public /info is intentionally minimal (no counts, ports, or log internals)
apiApp.get('/info', (_req, res) => {
  try {
    getDb();
    res.json({
      name: 'bookmarks-sync',
      version: require('./package.json').version,
      status: 'online',
      message: process.env.STATUS_MESSAGE || '',
      allowNewSyncs: process.env.ALLOW_NEW_SYNCS !== 'false',
      maxSyncSizeBytes: Number(process.env.MAX_SYNC_SIZE_BYTES) || 1048576,
      multiUser: true,
    });
  } catch (err) {
    logger.error('Info endpoint failed', { err: err.message });
    res.status(503).json({ status: 'error', error: 'database unavailable' });
  }
});

apiApp.get('/', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Bookmarks Sync API</title>
<link rel="icon" href="/favicon.ico" sizes="any"/>
<link rel="icon" type="image/png" href="/favicon.png"/>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
code{background:#f4f4f4;padding:.1em .35em;border-radius:4px}
.hero{display:flex;align-items:center;gap:.75rem}
.hero img{width:48px;height:48px;border-radius:12px}</style></head>
<body>
  <div class="hero">
    <img src="/icons/icon48.png" width="48" height="48" alt="Bookmarks Sync"/>
    <h1 style="margin:0">Bookmarks Sync API</h1>
  </div>
  <p>This port serves the REST API only.</p>
  <ul>
    <li><code>GET /health</code></li>
    <li><code>GET /info</code></li>
    <li><code>/api/bookmarks</code> — requires per-user API key</li>
  </ul>
  <p>Admin UI runs on a separate port (see your deployment config).</p>
</body></html>`);
});

apiApp.use('/api/bookmarks', bookmarksRouter);
apiApp.use(jsonErrorHandler);

// --- Admin portal (ADMIN_PORT) ---
const adminApp = express();
applyTrustProxy(adminApp);
adminApp.use(createHelmet());
adminApp.use(morgan(morganFormat, { stream: morganStream }));
adminApp.use(express.urlencoded({ extended: false }));
// Admin session lifetime via SESSION_MAX_AGE_MINUTES (default 15). rolling: true
// refreshes the cookie on each request so active admins are not logged out mid-work.
const SESSION_MAX_AGE_MS = resolveSessionMaxAgeMs();
adminApp.use(
  session({
    name: 'bms.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: SESSION_MAX_AGE_MS,
    },
  })
);
adminApp.use(express.static(publicDir));

adminApp.use('/', adminRouter);
adminApp.use('/admin', adminRouter);

adminApp.use((err, req, res, _next) => {
  logger.error('Unhandled admin error', {
    err: err.message,
    stack: err.stack,
    path: req.path,
  });
  res.status(500).type('html').send('<h1>Internal server error</h1>');
});

// DB + optional env bootstrap + restore log level
// (no ADMIN_PASSWORD → first-run /setup in admin UI; weak env password fails closed in production)
getDb();
bootstrapAdmin();
loadLevelFromDb(Bookmark.getMeta.bind(Bookmark));

/**
 * Host/ports used only in startup log URLs (not the bind address).
 * SERVER_HOST=0.0.0.0 is correct for listening; logs default to 127.0.0.1 unless
 * PUBLIC_HOST is set (e.g. TrueNAS LAN IP). PUBLIC_*_PORT for host-mapped ports.
 */
const publicHost = (process.env.PUBLIC_HOST || '').trim() || (HOST === '0.0.0.0' ? '127.0.0.1' : HOST);
const publicApiPort = Number(process.env.PUBLIC_API_PORT) || API_PORT;
const publicAdminPort = Number(process.env.PUBLIC_ADMIN_PORT) || ADMIN_PORT;
const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'bookmarks.db');
const logCfg = getLogConfig();

const apiServer = apiApp.listen(API_PORT, HOST, () => {
  logger.info('API listening', {
    url: `http://${publicHost}:${publicApiPort}`,
    port: API_PORT,
    bind: `${HOST}:${API_PORT}`,
  });
});

const adminServer = adminApp.listen(ADMIN_PORT, HOST, () => {
  logger.info('Admin UI listening', {
    url: `http://${publicHost}:${publicAdminPort}/`,
    port: ADMIN_PORT,
    bind: `${HOST}:${ADMIN_PORT}`,
    sessionMaxAgeMinutes: resolveSessionMaxAgeMinutes(),
  });
  logger.info('Runtime paths', {
    database: dbPath,
    logDir: LOG_DIR,
    logLevel: logCfg.level,
    logToStdout: logCfg.logToStdout,
    logToFile: logCfg.logToFile,
  });
});

function shutdown(signal) {
  logger.info(`${signal} received, shutting down`);
  let closed = 0;
  const done = () => {
    closed += 1;
    if (closed >= 2) {
      closeDb();
      process.exit(0);
    }
  };
  apiServer.close(done);
  adminServer.close(done);
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { apiApp, adminApp };
