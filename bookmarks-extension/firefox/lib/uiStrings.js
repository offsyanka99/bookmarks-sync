/**
 * Shared UI copy for popup + options.
 */

export const BROWSER_LABELS = {
  brave: 'Brave',
  chrome: 'Chrome',
  firefox: 'Firefox',
  edge: 'Edge',
  chromium: 'Chromium',
  safari: 'Safari',
};

export function browserLabel(browser) {
  return BROWSER_LABELS[browser] || browser || 'Browser';
}

/** Footer line: "Firefox · self-hosted · v0.9.0" */
export function footerLine({ browser, version }) {
  return `${browserLabel(browser)} · self-hosted · v${version || '—'}`;
}

export const FAILSAFE_TITLE = 'Sync refused';
export const FAILSAFE_LEAD =
  'This run would delete a large share of bookmarks. Details below.';
export const FAILSAFE_HINT =
  'Override for this run only, or cancel and use Download / Upload deliberately.';
export const FAILSAFE_CANCEL = 'Cancel';
export const FAILSAFE_OVERRIDE = 'Override & sync';
export const FAILSAFE_OVERRIDING = 'Syncing…';

export const BTN_SYNC = 'Sync now';
export const BTN_SYNCING = 'Syncing…';
export const BTN_TEST = 'Test connection';
export const BTN_SHOW_KEY = 'Show key';
export const BTN_HIDE_KEY = 'Hide key';
