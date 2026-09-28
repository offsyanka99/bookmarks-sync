/**
 * Canonical UTC ISO timestamps (millisecond precision).
 * Invalid or empty input returns null so callers can fall back.
 * @param {unknown} value
 * @returns {string|null}
 */
function canonicalIso(value) {
  if (value == null || value === '') return null;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

module.exports = { canonicalIso };
