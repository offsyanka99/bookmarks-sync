/**
 * Identify this extension instance in API logs / User-Agent-style headers.
 */

/**
 * Brave exposes `navigator.brave` (and sometimes UA-CH brands).
 * Synchronous check — good enough for headers; avoids async in SW import paths.
 */
export function isBrave() {
  try {
    if (typeof navigator === 'undefined') return false;
    if (typeof navigator.brave !== 'undefined') return true;
    const brands = navigator.userAgentData?.brands || [];
    if (brands.some((b) => /brave/i.test(b.brand || ''))) return true;
  } catch {
    // ignore
  }
  return false;
}

function detectBrowserSync() {
  try {
    if (isBrave()) return 'brave';
    const ua = navigator.userAgent || '';
    if (/firefox/i.test(ua)) return 'firefox';
    if (/edg\//i.test(ua)) return 'edge';
    if (/chrome\//i.test(ua) && !/edg\//i.test(ua)) return 'chrome';
    if (/safari/i.test(ua) && !/chrome/i.test(ua)) return 'safari';
  } catch {
    // ignore
  }
  return 'chromium';
}

/**
 * @returns {{ name: string, browser: string, version: string, label: string }}
 */
export function getClientInfo() {
  let version = '0.0.0';
  try {
    version = chrome.runtime.getManifest()?.version || version;
  } catch {
    // ignore
  }
  const browser = detectBrowserSync();
  const name = 'bookmarks-sync-extension';
  return {
    name,
    browser,
    version,
    label: `${name}/${browser}/${version}`,
  };
}

/** Headers to attach to every API request for server-side logging. */
export function clientHeaders() {
  const info = getClientInfo();
  return {
    'X-Bookmarks-Sync-Client': info.label,
    'X-Bookmarks-Sync-Browser': info.browser,
    'X-Bookmarks-Sync-Version': info.version,
  };
}
