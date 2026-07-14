import { getClientInfo } from '../lib/clientInfo.js';
import {
  browserLabel,
  FAILSAFE_TITLE,
  FAILSAFE_LEAD,
  FAILSAFE_HINT,
  FAILSAFE_CANCEL,
  FAILSAFE_OVERRIDE,
  FAILSAFE_OVERRIDING,
  BTN_SYNC,
  BTN_SYNCING,
} from '../lib/uiStrings.js';

const el = {
  serverUrl: document.getElementById('server-url'),
  apiKeyState: document.getElementById('api-key-state'),
  lastSync: document.getElementById('last-sync'),
  syncStatus: document.getElementById('sync-status'),
  btnSync: document.getElementById('btn-sync'),
  btnTest: document.getElementById('btn-test'),
  log: document.getElementById('log'),
  openSettings: document.getElementById('open-settings'),
  footerBrowser: document.getElementById('footer-browser'),
  footerVersion: document.getElementById('footer-version'),
  mainActions: document.getElementById('main-actions'),
  failsafePanel: document.getElementById('failsafe-panel'),
  failsafeTitle: document.querySelector('.failsafe-title'),
  failsafeLead: document.querySelector('.failsafe-lead'),
  failsafeHint: document.querySelector('.failsafe-hint'),
  failsafeDetail: document.getElementById('failsafe-detail'),
  btnFailsafeCancel: document.getElementById('btn-failsafe-cancel'),
  btnFailsafeOverride: document.getElementById('btn-failsafe-override'),
};

function applyUiStrings() {
  if (el.failsafeTitle) el.failsafeTitle.textContent = FAILSAFE_TITLE;
  if (el.failsafeLead) el.failsafeLead.textContent = FAILSAFE_LEAD;
  if (el.failsafeHint) el.failsafeHint.textContent = FAILSAFE_HINT;
  if (el.btnFailsafeCancel) el.btnFailsafeCancel.textContent = FAILSAFE_CANCEL;
  if (el.btnFailsafeOverride) el.btnFailsafeOverride.textContent = FAILSAFE_OVERRIDE;
  if (el.btnSync) el.btnSync.textContent = BTN_SYNC;
}

function fillFooter() {
  const info = getClientInfo();
  if (el.footerBrowser) {
    el.footerBrowser.textContent = browserLabel(info.browser);
  }
  if (el.footerVersion) {
    el.footerVersion.textContent = info.version;
  }
}

function showLog(text, kind = '') {
  el.log.hidden = !text;
  el.log.textContent = text || '';
  el.log.classList.remove('error', 'ok');
  if (kind) el.log.classList.add(kind);
}

function showFailsafe(detail) {
  el.failsafePanel.hidden = false;
  el.mainActions.hidden = true;
  el.failsafeDetail.textContent = detail || '';
  showLog('', '');
  el.log.hidden = true;
}

function hideFailsafe() {
  el.failsafePanel.hidden = true;
  el.mainActions.hidden = false;
}

function formatWhen(iso) {
  if (!iso) return 'Never';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Build status pill with DOM APIs (no innerHTML — AMO / CSP friendly). */
function setStatusPill(container, status) {
  if (!container) return;
  container.replaceChildren();
  const span = document.createElement('span');
  if (status === 'ok') {
    span.className = 'pill pill-ok';
    span.textContent = 'ok';
  } else if (status === 'error') {
    span.className = 'pill pill-err';
    span.textContent = 'error';
  } else if (status === 'running') {
    span.className = 'pill pill-warn';
    span.textContent = 'running';
  } else {
    span.className = 'muted';
    span.textContent = 'never';
  }
  container.appendChild(span);
}

async function refreshStatus() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (!res?.ok) {
    if (el.failsafePanel.hidden) {
      showLog(res?.error || 'Failed to load status', 'error');
    }
    return;
  }

  const { settings, meta } = res;
  el.serverUrl.textContent = settings.apiBaseUrl || '—';
  el.apiKeyState.textContent = settings.hasApiKey ? 'configured' : 'missing';
  el.apiKeyState.style.color = settings.hasApiKey ? '' : 'var(--danger)';
  el.lastSync.textContent = formatWhen(meta?.lastSyncAt || meta?.lastResult?.at);
  setStatusPill(el.syncStatus, meta?.lastSyncStatus || 'never');

  // Don't overwrite failsafe panel with last error
  if (!el.failsafePanel.hidden) return;

  if (meta?.lastError && meta?.lastSyncStatus === 'error') {
    showLog(meta.lastError, 'error');
  } else if (meta?.lastResult && meta?.lastSyncStatus === 'ok') {
    const r = meta.lastResult;
    showLog(
      [
        `Strategy: ${r.strategy || settings.strategy || 'merge'}`,
        `Local: ${r.localCount} bookmarks`,
        `Server — created ${r.server?.created}, updated ${r.server?.updated}, deleted ${r.server?.deleted}, conflicts ${r.server?.conflicts}`,
        `Browser — created ${r.localApply?.created}, updated ${r.localApply?.updated}, removed ${r.localApply?.removed}`,
      ].join('\n'),
      'ok'
    );
  }
}

function setBusy(busy) {
  el.btnSync.disabled = busy;
  el.btnTest.disabled = busy;
  el.btnFailsafeOverride.disabled = busy;
  el.btnFailsafeCancel.disabled = busy;
  el.btnSync.textContent = busy ? BTN_SYNCING : BTN_SYNC;
  el.btnFailsafeOverride.textContent = busy ? FAILSAFE_OVERRIDING : FAILSAFE_OVERRIDE;
}

async function runSync({ confirmDestructive = false } = {}) {
  setBusy(true);
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'SYNC_NOW',
      confirmDestructive,
    });

    if (!res?.ok && res?.code === 'destructive_refused' && !confirmDestructive) {
      const detail =
        res.error ||
        'This sync would remove a large share of bookmarks. Refusing to execute.';
      showFailsafe(detail);
      return;
    }

    hideFailsafe();

    if (!res?.ok) {
      showLog(res?.error || 'Sync failed', 'error');
    } else {
      const r = res.result;
      showLog(
        [
          'Sync finished.',
          `Server: +${r.server?.created} ~${r.server?.updated} -${r.server?.deleted} conflicts ${r.server?.conflicts}`,
          `Browser: +${r.localApply?.created} ~${r.localApply?.updated} -${r.localApply?.removed}`,
        ].join('\n'),
        'ok'
      );
    }
  } catch (err) {
    hideFailsafe();
    showLog(err?.message || String(err), 'error');
  } finally {
    setBusy(false);
    await refreshStatus();
  }
}

el.btnSync.addEventListener('click', () => {
  hideFailsafe();
  showLog('Sync in progress…');
  runSync({ confirmDestructive: false });
});

el.btnFailsafeCancel.addEventListener('click', () => {
  hideFailsafe();
  showLog('Cancelled — failsafe not overridden.', 'error');
  refreshStatus();
});

el.btnFailsafeOverride.addEventListener('click', () => {
  const detail = el.failsafeDetail.textContent || '';
  hideFailsafe();
  showLog(
    `${detail}\n\n───\nRetrying with failsafe override for this run…`,
    'error'
  );
  runSync({ confirmDestructive: true });
});

el.btnTest.addEventListener('click', async () => {
  hideFailsafe();
  setBusy(true);
  showLog('Testing connection…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' });
    if (!res?.ok) {
      showLog(res?.error || 'Connection test failed', 'error');
    } else {
      const { health, info, auth } = res.result;
      const lines = [
        `Health: ${health?.status || 'ok'}`,
        `Service: ${info?.name || '?'} ${info?.version || ''} (${info?.status || ''})`,
      ];
      if (auth) {
        lines.push(`Auth: ok · ${auth.bookmarkCount} bookmarks on server`);
      } else {
        lines.push('Auth: skipped (no API key)');
      }
      showLog(lines.join('\n'), 'ok');
    }
  } catch (err) {
    showLog(err?.message || String(err), 'error');
  } finally {
    setBusy(false);
    await refreshStatus();
  }
});

el.openSettings.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

applyUiStrings();
fillFooter();
refreshStatus();
