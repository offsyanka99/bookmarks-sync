/**
 * Canonical UTC ISO timestamps (millisecond precision).
 * Invalid or empty input returns null so callers can fall back.
 * @param {unknown} value
 * @returns {string|null}
 */
/** Client clocks this far ahead of the server are still accepted. */
const DEFAULT_FUTURE_SKEW_MS = 5 * 60 * 1000;

function canonicalIso(value) {
  if (value == null || value === '') return null;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

/**
 * Canonical ISO, clamped to server time when the client clock is past the skew window.
 * A years-ahead timestamp would otherwise win last-write-wins until that date.
 * @param {unknown} value
 * @param {number} nowMs
 * @param {number} [skewMs]
 * @returns {string|null}
 */
function capClientIso(value, nowMs, skewMs = DEFAULT_FUTURE_SKEW_MS) {
  const iso = canonicalIso(value);
  if (!iso) return null;
  const ms = Date.parse(iso);
  const now = Number(nowMs);
  if (!Number.isFinite(ms) || !Number.isFinite(now)) return iso;
  const skew = Number.isFinite(Number(skewMs)) ? Number(skewMs) : DEFAULT_FUTURE_SKEW_MS;
  if (ms > now + skew) return new Date(now).toISOString();
  return iso;
}

module.exports = { canonicalIso, capClientIso, DEFAULT_FUTURE_SKEW_MS };
