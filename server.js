require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const { getDb, closeDb } = require('./src/utils/db');
const { bootstrapAdmin } = require('./src/utils/bootstrap');
const bookmarksRouter = require('./src/routes/bookmarks');
const adminRouter = require('./src/routes/admin');
const Bookmark = require('./src/models/Bookmark');
const User = require('./src/models/User');

const API_PORT = Number(process.env.SERVER_PORT) || 31059;
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 31060;
const HOST = process.env.SERVER_HOST || '0.0.0.0';
const SESSION_SECRET =
  process.env.SESSION_SECRET || 'dev-only-session-secret-change-me';
const logFormat = process.env.NODE_ENV === 'production' ? 'combined' : 'dev';
const publicDir = path.join(__dirname, 'public');

function createHelmet() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'", "'unsafe-inline'"],
        'style-src': ["'self'", "'unsafe-inline'"],
      },
    },
  });
}

function jsonErrorHandler(err, _req, res, _next) {
  console.error('Unhandled error:', err);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }
  res.status(500).json({ error: 'Internal server error' });
}

// --- Bookmark sync API (SERVER_PORT) ---
const apiApp = express();
apiApp.use(createHelmet());
apiApp.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  })
);
apiApp.use(morgan(logFormat));
apiApp.use(express.json({ limit: process.env.MAX_SYNC_SIZE_BYTES || '1mb' }));

apiApp.get('/health', (_req, res) => {
  try {
    getDb();
    res.json({ status: 'ok', uptime: process.uptime() });
  } catch {
    res.status(503).json({ status: 'error', error: 'database unavailable' });
  }
});

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
      userCount: User.count(),
      bookmarkCount: Bookmark.count(),
      apiPort: API_PORT,
      adminPort: ADMIN_PORT,
    });
  } catch {
    res.status(503).json({ status: 'error', error: 'database unavailable' });
  }
});

apiApp.get('/', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Bookmarks Sync API</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
code{background:#f4f4f4;padding:.1em .35em;border-radius:4px}</style></head>
<body>
  <h1>Bookmarks Sync API</h1>
  <p>This port serves the REST API only.</p>
  <ul>
    <li><code>GET /health</code></li>
    <li><code>GET /info</code></li>
    <li><code>/api/bookmarks</code> — requires per-user API key</li>
  </ul>
  <p>Admin UI runs on port <strong>${ADMIN_PORT}</strong>.</p>
</body></html>`);
});

apiApp.use('/api/bookmarks', bookmarksRouter);
apiApp.use(jsonErrorHandler);

// --- Admin portal (ADMIN_PORT) ---
const adminApp = express();
adminApp.use(createHelmet());
adminApp.use(morgan(logFormat));
adminApp.use(express.urlencoded({ extended: false }));
adminApp.use(
  session({
    name: 'bms.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);
adminApp.use(express.static(publicDir));

// Mount admin UI at / (and keep /admin aliases for old bookmarks)
adminApp.use('/', adminRouter);
adminApp.use('/admin', adminRouter);

adminApp.use((err, _req, res, _next) => {
  console.error('Admin error:', err);
  res.status(500).type('html').send('<h1>Internal server error</h1>');
});

// DB + bootstrap before listen
getDb();
bootstrapAdmin();

if (
  process.env.NODE_ENV === 'production' &&
  SESSION_SECRET === 'dev-only-session-secret-change-me'
) {
  console.warn('[security] Set a strong SESSION_SECRET in production.');
}

const displayHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'bookmarks.db');

const apiServer = apiApp.listen(API_PORT, HOST, () => {
  console.log(`API listening on http://${displayHost}:${API_PORT}`);
});

const adminServer = adminApp.listen(ADMIN_PORT, HOST, () => {
  console.log(`Admin UI listening on http://${displayHost}:${ADMIN_PORT}/`);
  console.log(`SQLite database: ${dbPath}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
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
