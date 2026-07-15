const { layout, escapeHtml } = require('./layout');

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function usersPage({ user, users, flash, counts = {}, logConfig = null }) {
  const rows = users
    .map((u) => {
      const badge = u.isAdmin
        ? '<span class="badge badge-admin">admin</span>'
        : '<span class="badge">user</span>';
      const status = u.isActive
        ? '<span class="badge badge-ok">active</span>'
        : '<span class="badge badge-off">disabled</span>';
      const bmCount = counts[u.id] ?? 0;

      const toggleLabel = u.isActive ? 'Disable' : 'Enable';
      const toggleAction = u.isActive ? 'disable' : 'enable';
      const isSelf = u.id === user.id;

      return `
        <tr class="${u.isActive ? '' : 'row-muted'}">
          <td>
            <strong>${escapeHtml(u.username)}</strong>
            ${badge}
            ${status}
            <div class="muted small">${escapeHtml(u.displayName || '')}</div>
          </td>
          <td class="mono small">
            <div class="api-key-row">
              ${
                u.apiKey
                  ? `<code class="api-key is-masked" data-key="${escapeHtml(u.apiKey)}" title="API key hidden — click view to reveal" aria-label="API key for ${escapeHtml(u.username)} (hidden)">••••••••••••••••••••••••</code>
              <div class="api-key-actions">
                <button type="button" class="btn btn-icon btn-toggle-key" title="View API key" aria-label="View API key for ${escapeHtml(u.username)}" aria-pressed="false">
                  <svg class="icon-eye" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                    <circle cx="12" cy="12" r="3"></circle>
                  </svg>
                  <svg class="icon-eye-off" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" hidden>
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path>
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path>
                    <line x1="1" y1="1" x2="23" y2="23"></line>
                    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"></path>
                  </svg>
                </button>
                <button type="button" class="btn btn-icon btn-copy-key" data-copy="${escapeHtml(u.apiKey)}" title="Copy API key" aria-label="Copy API key for ${escapeHtml(u.username)}">
                  <svg class="icon-copy" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                  <svg class="icon-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" hidden>
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </button>
              </div>`
                  : '<span class="muted">—</span>'
              }
            </div>
          </td>
          <td class="num">${bmCount}</td>
          <td class="muted small">${escapeHtml(formatDate(u.createdAt))}</td>
          <td class="actions">
            <a class="btn btn-small" href="/users/${escapeHtml(u.id)}/export" title="Download ZIP of this user’s bookmarks">Export ZIP</a>
            <form method="post" action="/users/${escapeHtml(u.id)}/clear-bookmarks" class="inline form-clear-bookmarks"
              data-username="${escapeHtml(u.username)}"
              data-count="${bmCount}"
              onsubmit="return confirm('Clear ALL ${bmCount} bookmark(s) for \\'${escapeHtml(u.username)}\\'?\\n\\nThis permanently deletes their bookmarks. The account and API key are kept.\\n\\nThis cannot be undone.') && confirm('Final confirmation: delete all bookmarks for \\'${escapeHtml(u.username)}\\'?');">
              <button type="submit" class="btn btn-small btn-ghost" ${bmCount === 0 ? 'disabled' : ''}>Clear bookmarks</button>
            </form>
            <form method="post" action="/users/${escapeHtml(u.id)}/regenerate-key" class="inline"
              onsubmit="return confirm('Regenerate API key for ${escapeHtml(u.username)}? The old key will stop working.');">
              <button type="submit" class="btn btn-small">New API key</button>
            </form>
            <form method="post" action="/users/${escapeHtml(u.id)}/password" class="inline stack-tight password-form">
              <input type="password" name="password" placeholder="New password" required />
              <button type="submit" class="btn btn-small">Set password</button>
            </form>
            ${
              isSelf
                ? '<span class="muted small">you</span>'
                : `<form method="post" action="/users/${escapeHtml(u.id)}/${toggleAction}" class="inline">
                    <button type="submit" class="btn btn-small btn-ghost">${toggleLabel}</button>
                  </form>
                  <form method="post" action="/users/${escapeHtml(u.id)}/delete" class="inline"
                    onsubmit="return confirm('Delete user ${escapeHtml(u.username)} and all their bookmarks?');">
                    <button type="submit" class="btn btn-small btn-danger">Delete</button>
                  </form>`
            }
          </td>
        </tr>`;
    })
    .join('');

  const body = `
    <header class="page-header">
      <div>
        <h1>Users</h1>
        <p class="muted">Only admins can create users. Each user gets a password (web login later) and an API key (extension / API).</p>
      </div>
    </header>

    <section class="card">
      <h2>Create user</h2>
      <form method="post" action="/users" class="form-grid">
        <label>
          Username
          <input type="text" name="username" required minlength="2" pattern="[A-Za-z0-9._\\-]+" autocomplete="off" />
        </label>
        <label>
          Display name
          <input type="text" name="displayName" autocomplete="off" />
        </label>
        <label>
          Password
          <input type="password" name="password" required autocomplete="new-password" />
        </label>
        <label class="checkbox">
          <input type="checkbox" name="isAdmin" value="1" />
          Admin
        </label>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Create user</button>
        </div>
      </form>
    </section>

    <section class="card">
      <div class="section-header">
        <h2>All users <span class="muted">(${users.length})</span></h2>
        <div class="section-actions">
          <a class="btn btn-small btn-primary" href="/export/bookmarks">Export all users (ZIP)</a>
          <a class="btn btn-small" href="/export/bookmarks?includeDeleted=1" title="Also includes soft-deleted rows">Export all + deleted</a>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>API key</th>
              <th title="URL bookmarks only (folders excluded)">Bookmarks</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="5" class="muted">No users yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <h2>Logging</h2>
      <p class="muted small">
        Logs go to <strong>stdout</strong> and rotating files under
        <code>${escapeHtml(logConfig?.logDir || 'data/logs')}</code>.
      </p>
      <form method="post" action="/settings/log-level" class="form-grid">
        <label>
          Log level
          <select name="level" required>
            ${(logConfig?.levels || ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'])
              .map((lvl) => {
                const selected = (logConfig?.level || 'info') === lvl ? ' selected' : '';
                return `<option value="${escapeHtml(lvl)}"${selected}>${escapeHtml(lvl)}</option>`;
              })
              .join('')}
          </select>
        </label>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Save log level</button>
        </div>
      </form>
      <p class="muted small" style="margin-top:0.75rem">
        Current: <code>${escapeHtml(logConfig?.level || 'info')}</code>
        · stdout: ${logConfig?.logToStdout === false ? 'off' : 'on'}
        · files: ${logConfig?.logToFile === false ? 'off' : 'on'}
        · retention: ${escapeHtml(String(logConfig?.maxFiles || '14d'))}
        · max size: ${escapeHtml(String(logConfig?.maxSize || '20m'))}
      </p>
    </section>

    <section class="card muted small">
      <p><strong>API usage</strong> (per user):</p>
      <pre>curl -H "Authorization: Bearer &lt;api-key&gt;" http://localhost:${escapeHtml(process.env.SERVER_PORT || '31059')}/api/bookmarks</pre>
      <p>Bookmark management UI for end users is planned next. For now, admins manage accounts only.</p>
    </section>

    <script>
      (function () {
        var MASK = '••••••••••••••••••••••••';

        document.querySelectorAll('.btn-toggle-key').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var row = btn.closest('.api-key-row');
            if (!row) return;
            var el = row.querySelector('.api-key');
            if (!el) return;
            var key = el.getAttribute('data-key') || '';
            var visible = el.classList.contains('is-visible');
            var eye = btn.querySelector('.icon-eye');
            var eyeOff = btn.querySelector('.icon-eye-off');
            if (visible) {
              el.textContent = MASK;
              el.classList.remove('is-visible');
              el.classList.add('is-masked');
              el.title = 'API key hidden — click view to reveal';
              btn.title = 'View API key';
              btn.setAttribute('aria-pressed', 'false');
              btn.setAttribute('aria-label', btn.getAttribute('aria-label') || 'View API key');
              if (eye) eye.hidden = false;
              if (eyeOff) eyeOff.hidden = true;
            } else {
              el.textContent = key;
              el.classList.add('is-visible');
              el.classList.remove('is-masked');
              el.title = 'Full API key';
              btn.title = 'Hide API key';
              btn.setAttribute('aria-pressed', 'true');
              if (eye) eye.hidden = true;
              if (eyeOff) eyeOff.hidden = false;
              el.scrollLeft = 0;
            }
          });
        });

        document.querySelectorAll('.btn-copy-key').forEach(function (btn) {
          btn.addEventListener('click', async function () {
            var value = btn.getAttribute('data-copy') || '';
            if (!value) return;
            try {
              if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(value);
              } else {
                var ta = document.createElement('textarea');
                ta.value = value;
                ta.setAttribute('readonly', '');
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
              }
              btn.classList.add('copied');
              btn.title = 'Copied!';
              var copyIcon = btn.querySelector('.icon-copy');
              var checkIcon = btn.querySelector('.icon-check');
              if (copyIcon) copyIcon.hidden = true;
              if (checkIcon) checkIcon.hidden = false;
              setTimeout(function () {
                btn.classList.remove('copied');
                btn.title = 'Copy API key';
                if (copyIcon) copyIcon.hidden = false;
                if (checkIcon) checkIcon.hidden = true;
              }, 1500);
            } catch (err) {
              btn.title = 'Copy failed';
            }
          });
        });

        document.querySelectorAll('form.form-clear-bookmarks').forEach(function (form) {
          form.addEventListener('submit', function (e) {
            var username = form.getAttribute('data-username') || 'this user';
            var count = form.getAttribute('data-count') || '0';
            var msg1 =
              'Clear bookmarks for "' + username + '"?\\n\\n' +
              'This will permanently delete ' + count + ' bookmark(s).\\n' +
              'The user account and API key will be kept.\\n\\n' +
              'This cannot be undone.';
            if (!window.confirm(msg1)) {
              e.preventDefault();
              return false;
            }
            var msg2 =
              'Final confirmation:\\n\\n' +
              'Delete ALL bookmarks for "' + username + '"?';
            if (!window.confirm(msg2)) {
              e.preventDefault();
              return false;
            }
            return true;
          });
        });
      })();
    </script>`;

  return layout({ title: 'Users', user, flash, body });
}

module.exports = { usersPage };
