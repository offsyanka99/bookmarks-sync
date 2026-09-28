const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) {
    return false;
  }
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;

  try {
    const test = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
    const expected = Buffer.from(hash, 'hex');
    if (expected.length !== test.length) return false;
    return crypto.timingSafeEqual(expected, test);
  } catch {
    return false;
  }
}

/** Generate a random API key for extension/API clients. */
function generateApiKey() {
  return `bms_${crypto.randomBytes(32).toString('hex')}`;
}

/** sha256 hex of an API key. Stored value is never the raw key. */
function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey), 'utf8').digest('hex');
}

/** True when the stored column already holds a sha256 hex digest. */
function isApiKeyHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

/** Short prefix shown in the admin UI (raw key, not the hash). */
function apiKeyPrefix(apiKey) {
  return String(apiKey || '').slice(0, 12);
}

function generateSessionSecret() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateApiKey,
  hashApiKey,
  isApiKeyHash,
  apiKeyPrefix,
  generateSessionSecret,
};
