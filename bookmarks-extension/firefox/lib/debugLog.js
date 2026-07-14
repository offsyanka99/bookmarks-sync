/**
 * Lightweight debug logging for extension SW / pages.
 * Always safe; uses console.debug so it stays out of normal consoles unless enabled.
 */

export function debugLog(scope, message, extra) {
  try {
    if (extra !== undefined) {
      console.debug(`[bookmarks-sync:${scope}]`, message, extra);
    } else {
      console.debug(`[bookmarks-sync:${scope}]`, message);
    }
  } catch {
    // ignore
  }
}

export function debugWarn(scope, message, extra) {
  try {
    if (extra !== undefined) {
      console.warn(`[bookmarks-sync:${scope}]`, message, extra);
    } else {
      console.warn(`[bookmarks-sync:${scope}]`, message);
    }
  } catch {
    // ignore
  }
}
