/**
 * Server-wide UI time format (12h vs 24h) from TIME_FORMAT env.
 * Used by admin portal timestamps and exposed on GET /info for extensions.
 */

const DEFAULT_TIME_FORMAT = '24h';

/**
 * @param {string|null|undefined} [raw]
 * @returns {'12h'|'24h'}
 */
function resolveTimeFormat(raw = process.env.TIME_FORMAT) {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (['12h', '12', 'h12', 'h11', 'ampm', 'am/pm'].includes(v)) return '12h';
  if (['24h', '24', 'h23', 'h24', 'military'].includes(v)) return '24h';
  // Unset or unknown → 24h (stable default for self-hosted / admin UIs)
  return DEFAULT_TIME_FORMAT;
}

/** @param {string|null|undefined} [fmt] */
function timeFormatHour12(fmt) {
  return resolveTimeFormat(fmt) === '12h';
}

module.exports = {
  DEFAULT_TIME_FORMAT,
  resolveTimeFormat,
  timeFormatHour12,
};
