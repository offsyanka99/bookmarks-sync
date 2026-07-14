/**
 * HTTP client for the bookmarks-sync REST API.
 */

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

export class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * @param {{ apiBaseUrl: string, apiKey: string }} settings
 * @param {string} path
 * @param {RequestInit & { json?: unknown }} [options]
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
  if (options.json !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  const init = {
    method: options.method || (options.json !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
  };

  let res;
  try {
    res = await fetch(joinUrl(apiBaseUrl, path), init);
  } catch (err) {
    throw new ApiError(
      `Network error: ${err?.message || err}. Check the URL and host permission.`,
      { status: 0 }
    );
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
    const msg =
      (body && typeof body === 'object' && (body.error || body.message)) ||
      `HTTP ${res.status}`;
    throw new ApiError(String(msg), { status: res.status, body });
  }

  return body;
}

export async function getHealth(settings) {
  return apiFetch(settings, '/health');
}

export async function getInfo(settings) {
  return apiFetch(settings, '/info');
}

export async function listBookmarks(settings, { includeDeleted = false } = {}) {
  const q = includeDeleted ? '?includeDeleted=true' : '';
  return apiFetch(settings, `/api/bookmarks${q}`);
}

/**
 * @param {{ apiBaseUrl: string, apiKey: string }} settings
 * @param {object[]} bookmarks
 * @param {{ replace?: boolean, force?: boolean, lastSyncAt?: string|null }} [opts]
 */
export async function syncBookmarks(settings, bookmarks, opts = {}) {
  return apiFetch(settings, '/api/bookmarks/sync', {
    method: 'POST',
    json: {
      bookmarks,
      replace: Boolean(opts.replace),
      force: Boolean(opts.force),
      lastSyncAt: opts.lastSyncAt || null,
    },
  });
}

/**
 * Ensure the extension has host permission for the configured API origin.
 * @returns {Promise<boolean>} true if granted
 */
export async function ensureHostPermission(apiBaseUrl) {
  let origin;
  try {
    const u = new URL(apiBaseUrl);
    origin = `${u.protocol}//${u.host}/*`;
  } catch {
    throw new ApiError(`Invalid API base URL: ${apiBaseUrl}`);
  }

  const already = await chrome.permissions.contains({ origins: [origin] });
  if (already) return true;

  return chrome.permissions.request({ origins: [origin] });
}
