/**
 * Opaque keyset token for bookmark pages: { seq, id }.
 * @param {{ seq: number, id: string }} payload
 * @returns {string}
 */
function encodePageToken(payload) {
  return Buffer.from(
    JSON.stringify({ seq: Number(payload.seq) || 0, id: String(payload.id) }),
    'utf8'
  ).toString('base64url');
}

/**
 * @param {unknown} token
 * @returns {{ seq: number, id: string }|null}
 */
function decodePageToken(token) {
  if (typeof token !== 'string' || !token || token.length > 512) return null;
  try {
    const obj = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!obj || typeof obj !== 'object') return null;
    const seq = Number(obj.seq);
    const id = typeof obj.id === 'string' ? obj.id : '';
    if (!Number.isFinite(seq) || seq < 0 || !id) return null;
    return { seq: Math.floor(seq), id };
  } catch {
    return null;
  }
}

module.exports = { encodePageToken, decodePageToken };
