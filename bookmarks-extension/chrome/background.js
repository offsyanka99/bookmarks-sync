/**
 * Service worker: alarms, change-based sync, startup sync, messages.
 */

import { getSettings, getMeta } from './lib/storage.js';
import {
  runSync,
  testConnection,
  isSuppressingLocalChangeHooks,
  registerChangeBasedCanceller,
} from './lib/sync.js';

const ALARM_NAME = 'bookmarks-sync-auto';
const CHANGE_DEBOUNCE_MS = 2500;

let syncRunning = false;
let changeDebounceTimer = null;

registerChangeBasedCanceller(() => {
  clearTimeout(changeDebounceTimer);
  changeDebounceTimer = null;
});

async function setBadge(text, color = '#0d9488') {
  try {
    await chrome.action.setBadgeText({ text: text || '' });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch (err) {
    // Badge APIs can fail in some contexts; not fatal
    console.debug('[bookmarks-sync:bg] setBadge failed', String(err));
  }
}

async function notify(title, message) {
  try {
    await chrome.notifications.create({
      type: 'basic',
      // Absolute extension URL — required on Firefox
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message: String(message).slice(0, 180),
      priority: 0,
    });
  } catch (err) {
    console.debug('[bookmarks-sync:bg] notify failed', String(err));
  }
}

/** Schedule or clear the time-based alarm from settings. */
export async function scheduleAutoSync() {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);

  if (!settings.timeBasedSync) return;

  const minutes = Math.max(1, Number(settings.syncIntervalMinutes) || 15);
  await chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: minutes,
    delayInMinutes: minutes,
  });
}

async function handleSync(opts = {}) {
  if (syncRunning) {
    return { ok: false, error: 'Sync already in progress' };
  }
  syncRunning = true;
  await setBadge('…', '#64748b');
  try {
    const result = await runSync(opts);
    await setBadge('✓', '#0d9488');
    setTimeout(() => setBadge(''), 4000);
    return { ok: true, result };
  } catch (err) {
    await setBadge('!', '#dc2626');
    const message = err?.message || String(err);
    if (opts.notifyOnError && err?.code !== 'destructive_refused') {
      await notify('Bookmarks Sync failed', message);
    } else if (opts.notifyOnError && err?.code === 'destructive_refused') {
      await notify('Sync refused (failsafe)', message.slice(0, 180));
    }
    return {
      ok: false,
      error: message,
      code: err?.code || err?.body?.error || null,
      body: err?.body || null,
    };
  } finally {
    syncRunning = false;
  }
}

function scheduleChangeBasedSync() {
  if (isSuppressingLocalChangeHooks() || syncRunning) return;

  clearTimeout(changeDebounceTimer);
  changeDebounceTimer = setTimeout(async () => {
    if (isSuppressingLocalChangeHooks() || syncRunning) return;
    const settings = await getSettings();
    if (!settings.syncOnChange) return;
    if (!settings.apiBaseUrl || !settings.apiKey) return;
    await handleSync({ reason: 'change', notifyOnError: false });
  }, CHANGE_DEBOUNCE_MS);
}

function onBookmarkEvent() {
  scheduleChangeBasedSync();
}

chrome.bookmarks.onCreated.addListener(onBookmarkEvent);
chrome.bookmarks.onRemoved.addListener(onBookmarkEvent);
chrome.bookmarks.onChanged.addListener(onBookmarkEvent);
chrome.bookmarks.onMoved.addListener(onBookmarkEvent);
if (chrome.bookmarks.onChildrenReordered) {
  chrome.bookmarks.onChildrenReordered.addListener(onBookmarkEvent);
}

chrome.runtime.onInstalled.addListener(async () => {
  await scheduleAutoSync();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAutoSync();
  const settings = await getSettings();
  if (settings.syncOnStartup && settings.apiBaseUrl && settings.apiKey) {
    // slight delay so the profile finishes loading bookmarks
    setTimeout(() => {
      handleSync({ reason: 'startup', notifyOnError: true });
    }, 3000);
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const settings = await getSettings();
  if (!settings.timeBasedSync) return;
  await handleSync({ reason: 'schedule', notifyOnError: true });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message?.type === 'SYNC_NOW') {
        const res = await handleSync({
          force: Boolean(message.force),
          replace: message.replace,
          reason: message.reason || 'manual',
          strategy: message.strategy,
          confirmDestructive: Boolean(message.confirmDestructive),
        });
        sendResponse(res);
        return;
      }
      if (message?.type === 'TEST_CONNECTION') {
        const result = await testConnection();
        sendResponse({ ok: true, result });
        return;
      }
      if (message?.type === 'GET_STATUS') {
        const [settings, meta] = await Promise.all([getSettings(), getMeta()]);
        sendResponse({
          ok: true,
          settings: {
            apiBaseUrl: settings.apiBaseUrl,
            hasApiKey: Boolean(settings.apiKey),
            syncOnChange: settings.syncOnChange,
            syncOnStartup: settings.syncOnStartup,
            timeBasedSync: settings.timeBasedSync,
            syncIntervalMinutes: settings.syncIntervalMinutes,
            strategy: settings.strategy,
            syncRoot: settings.syncRoot,
            removeLocalMissing: settings.removeLocalMissing !== false,
            destructiveFailsafe: settings.destructiveFailsafe !== false,
            destructiveFailsafePercent: settings.destructiveFailsafePercent || 50,
          },
          meta,
        });
        return;
      }
      if (message?.type === 'SETTINGS_SAVED') {
        await scheduleAutoSync();
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false, error: 'Unknown message type' });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    scheduleAutoSync();
  }
});
