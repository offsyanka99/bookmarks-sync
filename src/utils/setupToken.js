const crypto = require('crypto');
const { logger } = require('./logger');

let token = null;

function isPrivateAddress(ip) {
  const raw = String(ip || '')
    .replace(/^::ffff:/i, '')
    .toLowerCase();
  if (!raw) return false;
  if (raw === '127.0.0.1' || raw === '::1' || raw === 'localhost') return true;
  if (raw.startsWith('10.') || raw.startsWith('192.168.')) return true;
  const match = /^172\.(\d+)\./.exec(raw);
  if (match) {
    const second = Number(match[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (raw.startsWith('fc') || raw.startsWith('fd') || raw.startsWith('fe80:')) return true;
  return false;
}

/**
 * One-time token required by POST /setup. Printed when setup is actually needed.
 * @returns {string}
 */
function ensureSetupToken() {
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    logger.warn(
      `First-run setup token (enter this on /setup): ${token}`
    );
  }
  return token;
}

function rotateSetupToken() {
  token = null;
  return ensureSetupToken();
}

function getSetupToken() {
  return token;
}

function clearSetupToken() {
  token = null;
}

function verifySetupToken(provided) {
  if (!token || provided == null) return false;
  const left = Buffer.from(String(token));
  const right = Buffer.from(String(provided));
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Setup is allowed from loopback and private addresses unless SETUP_ALLOW_PUBLIC=true.
 * @param {string|undefined} ip
 */
function setupAddressAllowed(ip) {
  const allowPublic = String(process.env.SETUP_ALLOW_PUBLIC || '').toLowerCase();
  if (allowPublic === 'true' || allowPublic === '1') return true;
  return isPrivateAddress(ip);
}

module.exports = {
  ensureSetupToken,
  rotateSetupToken,
  getSetupToken,
  clearSetupToken,
  verifySetupToken,
  setupAddressAllowed,
  isPrivateAddress,
};
