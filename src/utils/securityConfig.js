/**
 * Production fail-closed checks for secrets and bootstrap credentials.
 * Session secret can come from env or a file next to the DB (auto-generated).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INSECURE_SESSION_SECRETS = new Set([
  '',
  'dev-only-session-secret-change-me',
  'generate-a-long-random-string',
  'change-me',
  'secret',
]);

const INSECURE_ADMIN_PASSWORDS = new Set(['', 'admin', 'password', 'changeme']);

const MIN_SESSION_SECRET_LENGTH = 16;
const MIN_PROD_ADMIN_PASSWORD_LENGTH = 8;
const SESSION_SECRET_FILENAME = '.session-secret';

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function isInsecureSessionSecret(secret) {
  if (secret == null) return true;
  const s = String(secret);
  if (s.length < MIN_SESSION_SECRET_LENGTH) return true;
  if (INSECURE_SESSION_SECRETS.has(s)) return true;
  if (INSECURE_SESSION_SECRETS.has(s.toLowerCase())) return true;
  return false;
}

function isInsecureAdminPassword(password) {
  if (password == null) return true;
  const p = String(password);
  if (INSECURE_ADMIN_PASSWORDS.has(p)) return true;
  if (INSECURE_ADMIN_PASSWORDS.has(p.toLowerCase())) return true;
  return false;
}

/**
 * Path for persisted session secret (same directory as the SQLite DB).
 * @returns {string}
 */
function getSessionSecretFilePath() {
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'bookmarks.db');
  return path.join(path.dirname(path.resolve(dbPath)), SESSION_SECRET_FILENAME);
}

/**
 * Read a previously generated session secret from disk, if present and secure.
 * @returns {string|null}
 */
function readSessionSecretFile() {
  const filePath = getSessionSecretFilePath();
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (isInsecureSessionSecret(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Generate and persist a session secret next to the database.
 * @returns {string}
 */
function generateAndPersistSessionSecret() {
  const filePath = getSessionSecretFilePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(filePath, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort on platforms that ignore mode
  }
  console.log(
    `[security] Generated SESSION_SECRET and saved to ${filePath} (override with env SESSION_SECRET if needed)`
  );
  return secret;
}

/**
 * Resolve session secret:
 * 1. Secure SESSION_SECRET env
 * 2. Existing data/.session-secret (or next to DB_PATH)
 * 3. Auto-generate and persist
 * 4. Dev-only placeholder if generation somehow fails outside production
 * @returns {string}
 */
function resolveSessionSecret() {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && !isInsecureSessionSecret(fromEnv)) {
    return String(fromEnv);
  }
  if (fromEnv && isInsecureSessionSecret(fromEnv) && isProduction()) {
    // Explicit weak env value is a misconfiguration — refuse rather than silently ignore
    console.error(
      '[security] Refusing to start: SESSION_SECRET is set but insecure (too short or known placeholder). ' +
        'Unset it to auto-generate, or set a strong value (openssl rand -hex 32).'
    );
    process.exit(1);
  }

  const fromFile = readSessionSecretFile();
  if (fromFile) {
    return fromFile;
  }

  try {
    return generateAndPersistSessionSecret();
  } catch (err) {
    if (isProduction()) {
      console.error(
        `[security] Refusing to start: could not create session secret file (${err.message}). ` +
          'Set SESSION_SECRET or ensure the data directory is writable.'
      );
      process.exit(1);
    }
    console.warn(
      `[security] Could not persist session secret (${err.message}); using dev placeholder`
    );
    return 'dev-only-session-secret-change-me';
  }
}

/**
 * Form-friendly password check (no process.exit).
 * Used by first-run /setup and any UI path.
 * @param {string} password
 * @returns {string|null} error message or null if OK
 */
function getAdminPasswordError(password) {
  if (password == null || String(password).length < 1) {
    return 'Password is required';
  }
  if (isInsecureAdminPassword(password)) {
    return 'Password is too weak (do not use defaults like "admin" or "password")';
  }
  if (String(password).length < MIN_PROD_ADMIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PROD_ADMIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

/**
 * Validate ADMIN_PASSWORD when it will be applied (env bootstrap or reset).
 * Fails closed in production for defaults / short passwords (process.exit).
 * In development, warns on weak passwords but allows them for convenience.
 * @param {string} password
 * @param {{ context: string }} opts
 */
function assertAdminPasswordSafe(password, { context }) {
  if (!isProduction()) {
    if (isInsecureAdminPassword(password) || String(password || '').length < MIN_PROD_ADMIN_PASSWORD_LENGTH) {
      console.warn(
        `[bootstrap] WARNING: weak ADMIN_PASSWORD in ${context} — change it before any real use.`
      );
    }
    return;
  }

  const err = getAdminPasswordError(password);
  if (err) {
    console.error(
      `[security] Refusing to ${context} in production: ${err}. ` +
        'Set a strong ADMIN_PASSWORD in the environment, or complete first-run setup in the admin UI.'
    );
    process.exit(1);
  }
}

/**
 * Resolve bootstrap admin password from env only.
 * Returns null when unset — first-run UI setup should be used instead.
 * @returns {string|null}
 */
function resolveBootstrapAdminPassword() {
  if (process.env.ADMIN_PASSWORD !== undefined && process.env.ADMIN_PASSWORD !== '') {
    return process.env.ADMIN_PASSWORD;
  }
  return null;
}

/**
 * Default / env admin username (always "admin" unless ADMIN_USERNAME is set).
 * @returns {string}
 */
function resolveBootstrapAdminUsername() {
  return (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase() || 'admin';
}

module.exports = {
  isProduction,
  isInsecureSessionSecret,
  isInsecureAdminPassword,
  resolveSessionSecret,
  getSessionSecretFilePath,
  getAdminPasswordError,
  assertAdminPasswordSafe,
  resolveBootstrapAdminPassword,
  resolveBootstrapAdminUsername,
  MIN_SESSION_SECRET_LENGTH,
  MIN_PROD_ADMIN_PASSWORD_LENGTH,
  INSECURE_SESSION_SECRETS,
};
