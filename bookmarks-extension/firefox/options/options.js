import { getSettings, saveSettings, saveMeta } from '../lib/storage.js';
import {
  requestHostPermission,
  apiOriginPattern,
  hostPermissionPatterns,
  hasHostPermission,
  probeHealth,
  getInfo,
  listBookmarks,
  ApiError,
} from '../lib/api.js';
import { normalizeTimeFormat } from '../lib/formatDateTime.js';
import { getClientInfo } from '../lib/clientInfo.js';
import { browserLabel, BTN_SHOW_KEY, BTN_HIDE_KEY } from '../lib/uiStrings.js';

const form = document.getElementById('form');
const msg = document.getElementById('msg');
const testResult = document.getElementById('test-result');
const btnToggleKey = document.getElementById('btn-toggle-key');
const btnTest = document.getElementById('btn-test');
const apiKeyInput = document.getElementById('apiKey');
const timeBasedSync = document.getElementById('timeBasedSync');
const intervalField = document.getElementById('interval-field');

function showMsg(text, kind) {
  msg.hidden = !text;
  msg.textContent = text || '';
  msg.classList.remove('ok', 'error');
  if (kind) msg.classList.add(kind);
}

/** Connection probe result sits under Test connection (always in view). */
function showTestResult(text, kind) {
  if (!testResult) {
    showMsg(text, kind);
    return;
  }
  testResult.hidden = !text;
  testResult.textContent = text || '';
  testResult.classList.remove('ok', 'error');
  if (kind) testResult.classList.add(kind);
  if (text && testResult.scrollIntoView) {
    try {
      testResult.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch {
      // ignore
    }
  }
}

function updateIntervalVisibility() {
  intervalField.hidden = !timeBasedSync.checked;
}

function selectedStrategy() {
  const el = form.querySelector('input[name="strategy"]:checked');
  return el?.value || 'merge';
}

function readServerFields() {
  const apiBaseUrl = form.apiBaseUrl.value.trim();
  const apiKey = form.apiKey.value.trim();
  // Validate URL synchronously (before any await — keeps user gesture on Firefox)
  apiOriginPattern(apiBaseUrl);
  return { apiBaseUrl, apiKey };
}

/**
 * Request host access as the first async call in a click/submit handler.
 * Required on Firefox; Chrome/Brave also accept this pattern.
 */
async function grantHostFromUserGesture(apiBaseUrl) {
  try {
    const granted = await requestHostPermission(apiBaseUrl);
    // Firefox: request may resolve true/false; also re-check contains
    const ok = granted || (await hasHostPermission(apiBaseUrl));
    if (!ok) {
      throw new ApiError(
        'Host permission denied. When Firefox prompts, choose Allow so the extension can reach your API.'
      );
    }
    return true;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(
      err?.message ||
        'Could not request host permission. Use Save or Test connection (a real button click) so Firefox can show the prompt.'
    );
  }
}

/**
 * Run connection tests in the Options page (same place the permission was just granted).
 * Avoids Firefox cases where background fetch fails even after a grant.
 */
async function runConnectionTestInPage(apiBaseUrl, apiKey) {
  const patterns = hostPermissionPatterns(apiBaseUrl);
  const permitted = await hasHostPermission(apiBaseUrl);

  const health = await probeHealth(apiBaseUrl);
  const info = await getInfo({ apiBaseUrl, apiKey: '' });
  const timeFormat = normalizeTimeFormat(info?.timeFormat);
  await saveMeta({ serverTimeFormat: timeFormat });

  let authLine = 'Auth: skipped (no API key)';
  if (apiKey) {
    const list = await listBookmarks({ apiBaseUrl, apiKey });
    const count = list?.count ?? list?.bookmarks?.length ?? 0;
    authLine = `Auth: ok · ${count} bookmarks on server`;
  }

  return [
    `Health: ${health?.status || 'ok'}`,
    `Service: ${info?.name || '?'} ${info?.version || ''} (${info?.status || ''})`,
    `Time format: ${timeFormat}`,
    authLine,
    `Host access: ${permitted ? 'granted' : 'uncertain'}`,
    `Patterns: ${patterns.slice(0, 3).join(', ')}${patterns.length > 3 ? '…' : ''}`,
  ].join('\n');
}

function fillFooter() {
  const info = getClientInfo();
  const browserEl = document.getElementById('footer-browser');
  const versionEl = document.getElementById('footer-version');
  if (browserEl) browserEl.textContent = browserLabel(info.browser);
  if (versionEl) versionEl.textContent = info.version;
}

async function load() {
  const s = await getSettings();
  form.apiBaseUrl.value = s.apiBaseUrl || '';
  form.apiKey.value = s.apiKey || '';
  form.syncOnChange.checked = Boolean(s.syncOnChange);
  form.syncOnStartup.checked = Boolean(s.syncOnStartup);
  form.timeBasedSync.checked = Boolean(s.timeBasedSync);
  form.syncIntervalMinutes.value = String(s.syncIntervalMinutes || 15);
  form.syncRoot.value = s.syncRoot || 'other';
  form.removeLocalMissing.checked = s.removeLocalMissing !== false;
  form.matchByUrl.checked = s.matchByUrl !== false;
  form.destructiveFailsafe.checked = s.destructiveFailsafe !== false;
  form.destructiveFailsafePercent.value = String(s.destructiveFailsafePercent || 50);

  const strategy = s.strategy || 'merge';
  const radio = form.querySelector(`input[name="strategy"][value="${strategy}"]`);
  if (radio) radio.checked = true;

  updateIntervalVisibility();
  updateFailsafeVisibility();
  fillFooter();
}

function updateFailsafeVisibility() {
  const field = document.getElementById('failsafe-pct-field');
  if (field) field.hidden = !form.destructiveFailsafe.checked;
}

timeBasedSync.addEventListener('change', updateIntervalVisibility);
form.destructiveFailsafe.addEventListener('change', updateFailsafeVisibility);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showMsg('');
  showTestResult('');

  let apiBaseUrl;
  let apiKey;
  try {
    ({ apiBaseUrl, apiKey } = readServerFields());
  } catch (err) {
    showMsg(err?.message || 'API base URL is not a valid URL.', 'error');
    return;
  }

  let interval = Number(form.syncIntervalMinutes.value);
  if (!Number.isFinite(interval) || interval < 1) interval = 15;

  try {
    // Must be the first await — Firefox user-gesture requirement
    await grantHostFromUserGesture(apiBaseUrl);

    let failsafePct = Number(form.destructiveFailsafePercent.value);
    if (!Number.isFinite(failsafePct) || failsafePct < 1) failsafePct = 50;
    if (failsafePct > 100) failsafePct = 100;

    await saveSettings({
      apiBaseUrl,
      apiKey,
      syncOnChange: form.syncOnChange.checked,
      syncOnStartup: form.syncOnStartup.checked,
      timeBasedSync: form.timeBasedSync.checked,
      syncIntervalMinutes: interval,
      strategy: selectedStrategy(),
      syncRoot: form.syncRoot.value === 'toolbar' ? 'toolbar' : 'other',
      removeLocalMissing: form.removeLocalMissing.checked,
      matchByUrl: form.matchByUrl.checked,
      destructiveFailsafe: form.destructiveFailsafe.checked,
      destructiveFailsafePercent: failsafePct,
    });

    await chrome.runtime.sendMessage({ type: 'SETTINGS_SAVED' });
    showMsg('Settings saved. Host permission granted for the API origin.', 'ok');
  } catch (err) {
    showMsg(err?.message || String(err), 'error');
  }
});

btnToggleKey.addEventListener('click', () => {
  const showing = apiKeyInput.type === 'text';
  apiKeyInput.type = showing ? 'password' : 'text';
  btnToggleKey.textContent = showing ? BTN_SHOW_KEY : BTN_HIDE_KEY;
});

btnTest.addEventListener('click', async () => {
  showMsg('');
  showTestResult('Testing…');

  let apiBaseUrl;
  let apiKey;
  try {
    ({ apiBaseUrl, apiKey } = readServerFields());
  } catch (err) {
    showTestResult(err?.message || 'API base URL is not a valid URL.', 'error');
    return;
  }

  try {
    // First await must be permissions.request (Firefox)
    await grantHostFromUserGesture(apiBaseUrl);

    await saveSettings({ apiBaseUrl, apiKey });

    // Probe from this page first (where the permission was just granted)
    const report = await runConnectionTestInPage(apiBaseUrl, apiKey);
    showTestResult(report, 'ok');

    // Also notify background so it warms up with the same settings
    try {
      await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' });
    } catch (err) {
      // non-fatal if background probe fails but page probe worked
      console.debug('[bookmarks-sync:options] background test failed', String(err));
    }
  } catch (err) {
    showTestResult(err?.message || String(err), 'error');
  }
});

load();
