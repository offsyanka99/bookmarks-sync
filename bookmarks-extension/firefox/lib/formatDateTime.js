/**
 * Locale-aware local date/time for UI (extension popup, failsafe messages).
 *
 * Date order/separators follow the browser locale. Hour cycle (12h vs 24h)
 * follows the server TIME_FORMAT setting (from GET /info → timeFormat),
 * cached as meta.serverTimeFormat. Default is 24h.
 */

export const DEFAULT_TIME_FORMAT = '24h';

/**
 * @param {unknown} raw
 * @returns {'12h'|'24h'}
 */
export function normalizeTimeFormat(raw) {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (['12h', '12', 'h12', 'h11', 'ampm', 'am/pm'].includes(v)) return '12h';
  if (['24h', '24', 'h23', 'h24', 'military'].includes(v)) return '24h';
  return DEFAULT_TIME_FORMAT;
}

/**
 * @param {string|number|Date|null|undefined} input ISO string, epoch, or Date
 * @param {string} [fallback=''] returned when input is empty/invalid
 * @param {string|boolean} [timeFormat='24h'] '12h' | '24h', or boolean hour12
 * @returns {string}
 */
export function formatDateTime(input, fallback = '', timeFormat = DEFAULT_TIME_FORMAT) {
  if (input == null || input === '') return fallback;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return fallback || String(input);

  let hour12 = false;
  if (typeof timeFormat === 'boolean') {
    hour12 = timeFormat;
  } else {
    hour12 = normalizeTimeFormat(timeFormat) === '12h';
  }

  try {
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12,
    });
  } catch {
    try {
      return d.toLocaleString();
    } catch {
      return fallback || String(input);
    }
  }
}
