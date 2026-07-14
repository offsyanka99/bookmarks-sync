import { getSettings, saveSettings } from '../lib/storage.js';
import { ensureHostPermission } from '../lib/api.js';

const form = document.getElementById('form');
const msg = document.getElementById('msg');
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

function updateIntervalVisibility() {
  intervalField.hidden = !timeBasedSync.checked;
}

function selectedStrategy() {
  const el = form.querySelector('input[name="strategy"]:checked');
  return el?.value || 'merge';
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

  const strategy = s.strategy || 'merge';
  const radio = form.querySelector(`input[name="strategy"][value="${strategy}"]`);
  if (radio) radio.checked = true;

  updateIntervalVisibility();
}

timeBasedSync.addEventListener('change', updateIntervalVisibility);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showMsg('');

  const apiBaseUrl = form.apiBaseUrl.value.trim();
  const apiKey = form.apiKey.value.trim();

  try {
    // eslint-disable-next-line no-new
    new URL(apiBaseUrl);
  } catch {
    showMsg('API base URL is not a valid URL.', 'error');
    return;
  }

  let interval = Number(form.syncIntervalMinutes.value);
  if (!Number.isFinite(interval) || interval < 1) interval = 15;

  try {
    const granted = await ensureHostPermission(apiBaseUrl);
    if (!granted) {
      showMsg('Host permission denied. Allow access to your server origin to continue.', 'error');
      return;
    }

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
    });

    await chrome.runtime.sendMessage({ type: 'SETTINGS_SAVED' });
    showMsg('Settings saved.', 'ok');
  } catch (err) {
    showMsg(err?.message || String(err), 'error');
  }
});

btnToggleKey.addEventListener('click', () => {
  const showing = apiKeyInput.type === 'text';
  apiKeyInput.type = showing ? 'password' : 'text';
  btnToggleKey.textContent = showing ? 'Show key' : 'Hide key';
});

btnTest.addEventListener('click', async () => {
  showMsg('Testing…');
  try {
    const apiBaseUrl = form.apiBaseUrl.value.trim();
    const apiKey = form.apiKey.value.trim();
    // eslint-disable-next-line no-new
    new URL(apiBaseUrl);

    const granted = await ensureHostPermission(apiBaseUrl);
    if (!granted) {
      showMsg('Host permission denied for this origin.', 'error');
      return;
    }

    await saveSettings({ apiBaseUrl, apiKey });

    const res = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' });
    if (!res?.ok) {
      showMsg(res?.error || 'Test failed', 'error');
      return;
    }
    const { health, info, auth } = res.result;
    const parts = [
      `Health: ${health?.status}`,
      `${info?.name} v${info?.version}`,
    ];
    if (auth) parts.push(`Auth OK (${auth.bookmarkCount} bookmarks)`);
    else parts.push('No API key — auth not tested');
    showMsg(parts.join(' · '), 'ok');
  } catch (err) {
    showMsg(err?.message || String(err), 'error');
  }
});

load();
