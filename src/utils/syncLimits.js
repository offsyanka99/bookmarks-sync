/**
 * One parser for MAX_SYNC_SIZE_BYTES.
 * Accepts a byte count or an express/body-parser size string ("5mb", "512kb").
 * @param {unknown} raw
 * @param {number} [fallback]
 * @returns {number}
 */
function parseByteSize(raw, fallback = 1048576) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (raw == null || raw === '') return fallback;
  const text = String(raw).trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|k|mb|m|gb|g)?$/.exec(text);
  if (!match) return fallback;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return fallback;
  const unit = match[2] || 'b';
  const multiplier = {
    b: 1,
    k: 1024,
    kb: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
  }[unit];
  return Math.floor(amount * multiplier);
}

function resolveMaxSyncBytes(raw = process.env.MAX_SYNC_SIZE_BYTES) {
  return parseByteSize(raw, 1048576);
}

module.exports = { parseByteSize, resolveMaxSyncBytes };
