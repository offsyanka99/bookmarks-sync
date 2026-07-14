/**
 * Production fail-closed checks for secrets and bootstrap credentials.
 */

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
 * Resolve session secret. In production, refuses insecure/missing values.
 * In development, falls back to a well-known dev secret.
 * @returns {string}
 */
function resolveSessionSecret() {
  const fromEnv = process.env.SESSION_SECRET;
  if (isProduction()) {
    if (isInsecureSessionSecret(fromEnv)) {
      const reason = !fromEnv
        ? 'SESSION_SECRET is not set'
        : fromEnv.length < MIN_SESSION_SECRET_LENGTH
          ? `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters`
          : 'SESSION_SECRET is a known insecure placeholder';
      console.error(
        `[security] Refusing to start in production: ${reason}. ` +
          'Generate one with: openssl rand -hex 32'
      );
      process.exit(1);
    }
    return String(fromEnv);
  }

  if (fromEnv && !isInsecureSessionSecret(fromEnv)) {
    return String(fromEnv);
  }
  return 'dev-only-session-secret-change-me';
}

/**
 * Validate ADMIN_PASSWORD when it will be applied (first bootstrap or reset).
 * Fails closed in production for defaults / short passwords.
 * @param {string} password
 * @param {{ context: string }} opts
 */
function assertAdminPasswordSafe(password, { context }) {
  if (!isProduction()) {
    if (isInsecureAdminPassword(password)) {
      console.warn(
        `[bootstrap] WARNING: weak ADMIN_PASSWORD in ${context} — change it before any real use.`
      );
    }
    return;
  }

  if (isInsecureAdminPassword(password)) {
    console.error(
      `[security] Refusing to ${context} in production: ADMIN_PASSWORD is missing or a known default (e.g. "admin"). ` +
        'Set a strong ADMIN_PASSWORD in the environment.'
    );
    process.exit(1);
  }

  if (String(password).length < MIN_PROD_ADMIN_PASSWORD_LENGTH) {
    console.error(
      `[security] Refusing to ${context} in production: ADMIN_PASSWORD must be at least ` +
        `${MIN_PROD_ADMIN_PASSWORD_LENGTH} characters.`
    );
    process.exit(1);
  }
}

/**
 * Resolve bootstrap admin password (env or dev default).
 * Does not apply production checks by itself — call assertAdminPasswordSafe when applying.
 */
function resolveBootstrapAdminPassword() {
  if (process.env.ADMIN_PASSWORD !== undefined && process.env.ADMIN_PASSWORD !== '') {
    return process.env.ADMIN_PASSWORD;
  }
  return 'admin';
}

module.exports = {
  isProduction,
  isInsecureSessionSecret,
  isInsecureAdminPassword,
  resolveSessionSecret,
  assertAdminPasswordSafe,
  resolveBootstrapAdminPassword,
  MIN_SESSION_SECRET_LENGTH,
  MIN_PROD_ADMIN_PASSWORD_LENGTH,
  INSECURE_SESSION_SECRETS,
};
