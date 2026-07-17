/**
 * HTTP client for the bookmarks-sync REST API.
 */

import { clientHeaders } from './clientInfo.js';
import { debugLog, debugWarn } from './debugLog.js';

const RETRY_MAX = 3;
const RETRY_BASE_MS = 300;

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

export class ApiError extends Error {
  constructor(message, { status, body, code } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.code = code || (body && body.error) || null;
  }
}

function isFirefox() {
  try {
    return (
      typeof navigator !== 'undefined' &&
      /firefox/i.test(navigator.userAgent || '')
    );
  } catch {
    return false;
  }
}

function networkErrorHint(apiBaseUrl, errMessage) {
  const lines = [
    `Network error: ${errMessage || 'fetch failed'}.`,
    `URL: ${apiBaseUrl}`,
  ];
  if (isFirefox()) {
    lines.push(
      'Firefox often reports missing host access as a generic NetworkError.',
      'Fix: Reload the firefox/ add-on, open Options, click Save or Test connection, and Allow access to the site if prompted.',
      'Also check: HTTPS-Only Mode is off for this URL (Settings → Privacy & Security), and the API port is correct (not the admin port).',
      'Prefer http://127.0.0.1:PORT over http://localhost:PORT if issues persist.'
    );
  } else {
    lines.push('Check the URL and that host permission was granted for this origin.');
  }
  return lines.join(' ');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Transient network / 5xx / 429 failures are retried with exponential backoff.
 * @param {() => Promise<Response>} fn
 * @param {{ max?: number, label?: string }} [opts]
 */
async function withRetry(fn, opts = {}) {
  const max = opts.max ?? RETRY_MAX;
  let lastErr;
  for (let attempt = 1; attempt <= max; attempt += 1) {
    try {
      const res = await fn();
      // Retry server overload / gateway blips (not 4xx client errors)
      if (
        res &&
        (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) &&
        attempt < max
      ) {
        const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
        debugLog('api', `retry HTTP ${res.status}`, {
          attempt,
          delay,
          label: opts.label,
        });
        await sleep(delay);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt >= max) break;
      const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
      debugLog('api', 'retry network error', {
        attempt,
        delay,
        err: String(err?.message || err),
        label: opts.label,
      });
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * @param {{ apiBaseUrl: string, apiKey: string }} settings
 * @param {string} path
 * @param {RequestInit & { json?: unknown, retries?: number }} [options]
 */
export async function apiFetch(settings, path, options = {}) {
  const { apiBaseUrl, apiKey } = settings;
  if (!apiBaseUrl) {
    throw new ApiError('API base URL is not configured');
  }
  if (!apiKey && path.startsWith('/api/')) {
    throw new ApiError('API key is not configured');
  }

  const headers = new Headers(options.headers || {});
  if (apiKey) {
    headers.set('Authorization', `Bearer ${apiKey}`);
  }
  const client = clientHeaders();
  for (const [k, v] of Object.entries(client)) {
    if (v) headers.set(k, v);
  }
  if (options.json !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  const init = {
    method: options.method || (options.json !== undefined ? 'POST' : 'GET'),
    headers,
    cache: 'no-store',
    redirect: 'follow',
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
  };

  const url = joinUrl(apiBaseUrl, path);
  const retries = Number.isFinite(Number(options.retries))
    ? Number(options.retries)
    : RETRY_MAX;

  let res;
  try {
    res = await withRetry(() => fetch(url, init), {
      max: retries,
      label: path,
    });
  } catch (err) {
    throw new ApiError(networkErrorHint(apiBaseUrl, err?.message || String(err)), {
      status: 0,
    });
  }

  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const code = body && typeof body === 'object' ? body.error : null;
    const msg =
      (body && typeof body === 'object' && (body.message || body.error)) ||
      `HTTP ${res.status}`;
    throw new ApiError(String(msg), { status: res.status, body, code });
  }

  return body;
}

export async function getHealth(settings, options = {}) {
  return apiFetch(settings, '/health', options);
}

export async function getInfo(settings, options = {}) {
  return apiFetch(settings, '/info', options);
}

export async function listBookmarks(settings, { includeDeleted = false } = {}) {
  const q = includeDeleted ? '?includeDeleted=true' : '';
  return apiFetch(settings, `/api/bookmarks${q}`);
}

/**
 * @param {{ apiBaseUrl: string, apiKey: string }} settings
 * @param {object[]} bookmarks
 * @param {{ replace?: boolean, force?: boolean, lastSyncAt?: string|null, confirmDestructive?: boolean }} [opts]
 */
export async function syncBookmarks(settings, bookmarks, opts = {}) {
  return apiFetch(settings, '/api/bookmarks/sync', {
    method: 'POST',
    json: {
      bookmarks,
      replace: Boolean(opts.replace),
      force: Boolean(opts.force),
      lastSyncAt: opts.lastSyncAt || null,
      confirmDestructive: Boolean(opts.confirmDestructive),
    },
  });
}

/**
 * Match pattern for chrome.permissions (e.g. http://127.0.0.1:31039/*).
 * @param {string} apiBaseUrl
 * @returns {string}
 */
export function apiOriginPattern(apiBaseUrl) {
  try {
    const u = new URL(String(apiBaseUrl || '').trim());
    if (!u.protocol || !u.host) throw new Error('incomplete');
    return `${u.protocol}//${u.host}/*`;
  } catch {
    throw new ApiError(`Invalid API base URL: ${apiBaseUrl}`);
  }
}

/**
 * Extra patterns that help Firefox grant loopback access reliably.
 * @param {string} apiBaseUrl
 * @returns {string[]}
 */
export function hostPermissionPatterns(apiBaseUrl) {
  const primary = apiOriginPattern(apiBaseUrl);
  const u = new URL(String(apiBaseUrl).trim());
  const patterns = new Set([primary]);

  if (u.protocol === 'http:') patterns.add('http://*/*');
  if (u.protocol === 'https:') patterns.add('https://*/*');

  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]') {
    const port = u.port ? `:${u.port}` : '';
    patterns.add(`http://127.0.0.1${port}/*`);
    patterns.add(`http://localhost${port}/*`);
    patterns.add(`http://[::1]${port}/*`);
  }

  return [...patterns];
}

/**
 * Check whether host access is already granted (safe from background / any context).
 * @param {string} apiBaseUrl
 * @returns {Promise<boolean>}
 */
export async function hasHostPermission(apiBaseUrl) {
  const patterns = hostPermissionPatterns(apiBaseUrl);
  try {
    if (await chrome.permissions.contains({ origins: [apiOriginPattern(apiBaseUrl)] })) {
      return true;
    }
    for (const origin of patterns) {
      if (await chrome.permissions.contains({ origins: [origin] })) {
        return true;
      }
    }
    return false;
  } catch (err) {
    debugWarn('api', 'hasHostPermission failed', { err: String(err) });
    return false;
  }
}

/**
 * Request host permission for the API origin.
 *
 * Firefox: must be invoked **directly** from a user input handler (click/submit).
 * Do not `await` anything else before calling this.
 *
 * @param {string} apiBaseUrl
 * @returns {Promise<boolean>}
 */
export function requestHostPermission(apiBaseUrl) {
  const origins = hostPermissionPatterns(apiBaseUrl);
  return chrome.permissions.request({ origins });
}

/**
 * Ensure host permission is available.
 * Background/sync: only checks; does not prompt.
 *
 * @param {string} apiBaseUrl
 * @param {{ interactive?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export async function ensureHostPermission(apiBaseUrl, { interactive = false } = {}) {
  if (await hasHostPermission(apiBaseUrl)) {
    return true;
  }

  if (interactive) {
    try {
      return await requestHostPermission(apiBaseUrl);
    } catch (err) {
      throw new ApiError(
        err?.message ||
          'Could not obtain host permission. Allow access when the browser prompts (Save or Test connection).'
      );
    }
  }

  throw new ApiError(
    'Host permission not granted for this API URL. Open Settings, click Save or Test connection, and allow access to the server origin.'
  );
}

/**
 * Probe /health from the current context (options page or background).
 * Used for clearer diagnostics on Firefox.
 */
export async function probeHealth(apiBaseUrl) {
  const url = joinUrl(apiBaseUrl, '/health');
  let res;
  try {
    res = await withRetry(() => fetch(url, { method: 'GET', cache: 'no-store' }), {
      max: RETRY_MAX,
      label: '/health',
    });
  } catch (err) {
    throw new ApiError(networkErrorHint(apiBaseUrl, err?.message || String(err)), {
      status: 0,
    });
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new ApiError(`Health check HTTP ${res.status}`, { status: res.status, body });
  }
  return body;
}

export { joinUrl };
