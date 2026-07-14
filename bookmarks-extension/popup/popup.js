const el = {
  serverUrl: document.getElementById('server-url'),
  apiKeyState: document.getElementById('api-key-state'),
  lastSync: document.getElementById('last-sync'),
  syncStatus: document.getElementById('sync-status'),
  btnSync: document.getElementById('btn-sync'),
  btnTest: document.getElementById('btn-test'),
  log: document.getElementById('log'),
  openSettings: document.getElementById('open-settings'),
};

function showLog(text, kind = '') {
  el.log.hidden = !text;
  el.log.textContent = text || '';
  el.log.classList.remove('error', 'ok');
  if (kind) el.log.classList.add(kind);
}

function formatWhen(iso) {
  if (!iso) return 'Never';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function statusPill(status) {
  if (status === 'ok') return '<span class="pill pill-ok">ok</span>';
  if (status === 'error') return '<span class="pill pill-err">error</span>';
  if (status === 'running') return '<span class="pill pill-warn">running</span>';
  return '<span class="muted">never</span>';
}

async function refreshStatus() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (!res?.ok) {
    showLog(res?.error || 'Failed to load status', 'error');
    return;
  }

  const { settings, meta } = res;
  el.serverUrl.textContent = settings.apiBaseUrl || '—';
  el.apiKeyState.textContent = settings.hasApiKey ? 'configured' : 'missing';
  el.apiKeyState.style.color = settings.hasApiKey ? '' : 'var(--danger)';
  el.lastSync.textContent = formatWhen(meta?.lastSyncAt || meta?.lastResult?.at);
  el.syncStatus.innerHTML = statusPill(meta?.lastSyncStatus || 'never');

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
  el.btnSync.textContent = busy ? 'Syncing…' : 'Sync now';
}

el.btnSync.addEventListener('click', async () => {
  setBusy(true);
  showLog('Sync in progress…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'SYNC_NOW' });
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
    showLog(err?.message || String(err), 'error');
  } finally {
    setBusy(false);
    await refreshStatus();
  }
});

el.btnTest.addEventListener('click', async () => {
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

refreshStatus();
