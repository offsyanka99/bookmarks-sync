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

function generateSessionSecret() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateApiKey,
  generateSessionSecret,
};
