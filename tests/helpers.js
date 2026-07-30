/**
 * Shared test setup: isolated temp SQLite DB and quiet logging.
 * Call applyTestEnv() before requiring modules that open the DB or server.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let tempDir = null;

function applyTestEnv(overrides = {}) {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-sync-test-'));
  const dbPath = path.join(tempDir, 'test.db');

  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = dbPath;
  process.env.SESSION_SECRET = 'test-session-secret-at-least-32-chars!!';
  process.env.LOG_TO_FILE = 'false';
  process.env.LOG_TO_STDOUT = 'false';
  process.env.LOG_LEVEL = 'error';
  process.env.COOKIE_SECURE = 'false';
  process.env.ALLOW_NEW_SYNCS = 'true';
  process.env.TIME_FORMAT = '24h';
  // Avoid env bootstrap unless a test opts in
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_USERNAME;
  delete process.env.RESET_ADMIN_PASSWORD;
  delete process.env.CORS_ORIGINS;

  Object.assign(process.env, overrides);
  return { tempDir, dbPath };
}

function cleanupTempDir() {
  if (!tempDir) return;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  tempDir = null;
}

module.exports = {
  applyTestEnv,
  cleanupTempDir,
};
