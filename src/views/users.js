const { layout, escapeHtml } = require('./layout');

/**
 * Emit a <time> with ISO datetime. Visible text is filled by the page script
 * using the browser's local timezone (server/container is often UTC).
 */
function formatDate(iso) {
  if (!iso) return '—';
  const raw = String(iso);
  return `<time class="local-time" datetime="${escapeHtml(raw)}" data-iso="${escapeHtml(raw)}">${escapeHtml(raw)}</time>`;
}

function usersPage({
  user,
  users,
  flash,
  counts = {},
  duplicateExtras = {},
  logConfig = null,
  timeFormat = '24h',
}) {
  const rows = users
    .map((u) => {
      const badge = u.isAdmin
        ? '<span class="badge badge-admin">admin</span>'
        : '<span class="badge">user</span>';
      const status = u.isActive
        ? '<span class="badge badge-ok">active</span>'
        : '<span class="badge badge-off">disabled</span>';
      const bmCount = counts[u.id] ?? 0;
      const dupExtra = duplicateExtras[u.id] ?? 0;

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
          <td class="num">
            ${bmCount}
            ${
              dupExtra > 0
                ? `<div class="muted small" title="Extra copies of the same URL in the same folder">${dupExtra} dup</div>`
                : ''
            }
          </td>
          <td class="muted small">${formatDate(u.createdAt)}</td>
          <td class="actions-cell">
            <div class="actions">
            <a class="btn btn-small" href="/users/${escapeHtml(u.id)}/export" title="Download ZIP of this user’s bookmarks">Export ZIP</a>
            <form method="post" action="/users/${escapeHtml(u.id)}/dedupe-bookmarks" class="inline form-confirm-action"
              data-confirm="dedupe-bookmarks"
              data-username="${escapeHtml(u.username)}"
              data-count="${dupExtra}">
              <button type="submit" class="btn btn-small btn-ghost" ${dupExtra === 0 ? 'disabled' : ''} title="Soft-delete same-folder URL duplicates (keep newest)">Dedupe</button>
            </form>
            <form method="post" action="/users/${escapeHtml(u.id)}/clear-bookmarks" class="inline form-confirm-action"
              data-confirm="clear-bookmarks"
              data-username="${escapeHtml(u.username)}"
              data-count="${bmCount}">
              <button type="submit" class="btn btn-small btn-ghost" ${bmCount === 0 ? 'disabled' : ''}>Clear bookmarks</button>
            </form>
            <form method="post" action="/users/${escapeHtml(u.id)}/regenerate-key" class="inline form-confirm-action"
              data-confirm="regenerate-key"
              data-username="${escapeHtml(u.username)}">
              <button type="submit" class="btn btn-small">New API key</button>
            </form>
            <form method="post" action="/users/${escapeHtml(u.id)}/password" class="password-form">
              <input type="password" name="password" placeholder="New password" required />
              <button type="submit" class="btn btn-small">Set password</button>
            </form>
            ${
              isSelf
                ? '<span class="muted small">you</span>'
                : `<form method="post" action="/users/${escapeHtml(u.id)}/${toggleAction}" class="inline">
                    <button type="submit" class="btn btn-small btn-ghost">${toggleLabel}</button>
                  </form>
                  <form method="post" action="/users/${escapeHtml(u.id)}/delete" class="inline form-confirm-action"
                    data-confirm="delete-user"
                    data-username="${escapeHtml(u.username)}"
                    data-count="${bmCount}">
                    <button type="submit" class="btn btn-small btn-danger">Delete</button>
                  </form>`
            }
            </div>
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
    </section>

    <section class="card card-danger-zone">
      <h2>Danger zone</h2>
      <p class="muted small">
        Reset this instance to a clean first-run state. Deletes <strong>all users</strong>
        (including admins), <strong>all bookmarks</strong>, and the database file.
        You will be logged out and sent to the setup screen.
      </p>
      <form method="post" action="/settings/reset" id="form-reset-default" class="form-reset-default">
        <input type="hidden" name="confirm_reset" id="reset-confirm-value" value="" />
        <div class="form-actions">
          <button type="submit" class="btn btn-danger" id="btn-reset-default">Reset to default</button>
        </div>
      </form>
    </section>

    <dialog id="confirm-action" class="confirm-dialog" aria-labelledby="confirm-action-title">
      <form method="dialog" class="confirm-dialog-form">
        <h2 id="confirm-action-title">Confirm</h2>
        <p id="confirm-action-message" class="confirm-dialog-message"></p>
        <p id="confirm-action-warning" class="confirm-dialog-warning" hidden></p>
        <div class="confirm-dialog-actions">
          <button type="submit" value="cancel" class="btn">Cancel</button>
          <button type="submit" value="confirm" class="btn" id="confirm-action-ok">Confirm</button>
        </div>
      </form>
    </dialog>

    <dialog id="confirm-reset" class="confirm-dialog confirm-dialog-reset" aria-labelledby="confirm-reset-title">
      <form method="dialog" class="confirm-dialog-form" id="confirm-reset-form">
        <h2 id="confirm-reset-title">Reset to default?</h2>
        <p class="confirm-dialog-message">
          This permanently deletes <strong>everything</strong> on this server:
        </p>
        <ul class="confirm-dialog-list">
          <li>All user accounts (including every admin)</li>
          <li>All bookmarks for every user</li>
          <li>The database file itself</li>
        </ul>
        <p class="confirm-dialog-warning">This cannot be undone. Export data first if you need a backup.</p>
        <label class="confirm-checkbox">
          <input type="checkbox" id="confirm-reset-checkbox" />
          <span>I understand that everything will be deleted and the admin must be set up again.</span>
        </label>
        <div class="confirm-dialog-actions">
          <button type="submit" value="cancel" class="btn">Cancel</button>
          <button type="submit" value="confirm" class="btn btn-danger" id="confirm-reset-ok" disabled>Reset everything</button>
        </div>
      </form>
    </dialog>

    <script>
      (function () {
        var MASK = '••••••••••••••••••••••••';

        // Format timestamps in the browser locale/timezone (container is usually UTC).
        // Clock style (12h/24h) comes from server TIME_FORMAT env (injected below).
        var timeFormat = ${JSON.stringify(timeFormat === '12h' ? '12h' : '24h')};
        var hour12 = timeFormat === '12h';
        document.querySelectorAll('time.local-time[data-iso]').forEach(function (el) {
          var iso = el.getAttribute('data-iso') || el.getAttribute('datetime') || '';
          if (!iso) return;
          var d = new Date(iso);
          if (Number.isNaN(d.getTime())) return;
          try {
            el.textContent = d.toLocaleString(undefined, {
              year: 'numeric',
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: hour12,
            });
            el.title = d.toISOString() + ' (UTC)';
          } catch (err) {
            el.textContent = d.toString();
          }
        });

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

        // Shared confirmation dialog for destructive actions
        var dialog = document.getElementById('confirm-action');
        var titleEl = document.getElementById('confirm-action-title');
        var messageEl = document.getElementById('confirm-action-message');
        var warningEl = document.getElementById('confirm-action-warning');
        var okBtn = document.getElementById('confirm-action-ok');
        var pendingForm = null;

        function appendText(parent, text) {
          parent.appendChild(document.createTextNode(text));
        }

        function appendStrong(parent, text) {
          var el = document.createElement('strong');
          el.textContent = text;
          parent.appendChild(el);
        }

        function appendBr(parent) {
          parent.appendChild(document.createElement('br'));
        }

        function clearNode(node) {
          node.textContent = '';
        }

        /** Build dialog content for each action type (DOM APIs — no HTML injection). */
        function buildConfirmContent(kind, username, count) {
          clearNode(messageEl);
          var fallback = '';
          var title = 'Confirm';
          var okLabel = 'Confirm';
          var danger = true;
          var warning = 'This cannot be undone.';

          if (kind === 'delete-user') {
            title = 'Delete user?';
            okLabel = 'Delete user';
            appendText(messageEl, 'Delete user ');
            appendStrong(messageEl, username);
            appendText(messageEl, ' and all their data?');
            appendBr(messageEl);
            appendBr(messageEl);
            appendText(messageEl, 'This permanently removes the account, API key, and ');
            appendStrong(messageEl, String(count));
            appendText(messageEl, ' bookmark(s).');
            fallback =
              'Delete user "' + username + '" and all their bookmarks (' + count + ')?\\n\\nThis cannot be undone.';
          } else if (kind === 'clear-bookmarks') {
            title = 'Clear bookmarks?';
            okLabel = 'Clear bookmarks';
            appendText(messageEl, 'Clear all bookmarks for ');
            appendStrong(messageEl, username);
            appendText(messageEl, '?');
            appendBr(messageEl);
            appendBr(messageEl);
            appendText(messageEl, 'This permanently deletes ');
            appendStrong(messageEl, String(count));
            appendText(messageEl, ' bookmark(s). The user account and API key are kept.');
            fallback =
              'Clear ALL ' +
              count +
              ' bookmark(s) for "' +
              username +
              '"?\\n\\nThis permanently deletes their bookmarks. The account and API key are kept.\\n\\nThis cannot be undone.';
          } else if (kind === 'regenerate-key') {
            title = 'Regenerate API key?';
            okLabel = 'New API key';
            danger = false;
            warning = 'The old key will stop working immediately.';
            appendText(messageEl, 'Generate a new API key for ');
            appendStrong(messageEl, username);
            appendText(messageEl, '?');
            appendBr(messageEl);
            appendBr(messageEl);
            appendText(
              messageEl,
              'Any extensions or clients using the current key will stop syncing until they are updated.'
            );
            fallback =
              'Regenerate API key for "' + username + '"? The old key will stop working.';
          } else if (kind === 'dedupe-bookmarks') {
            title = 'Dedupe bookmarks?';
            okLabel = 'Soft-delete duplicates';
            danger = false;
            warning = 'Extra copies are soft-deleted; the newest of each folder+URL pair is kept.';
            appendText(messageEl, 'Remove folder-scoped URL duplicates for ');
            appendStrong(messageEl, username);
            appendText(messageEl, '?');
            appendBr(messageEl);
            appendBr(messageEl);
            appendText(messageEl, 'About ');
            appendStrong(messageEl, String(count));
            appendText(
              messageEl,
              ' extra bookmark(s) will be soft-deleted. Same URL in different folders is left alone.'
            );
            fallback =
              'Dedupe bookmarks for "' +
              username +
              '"? Soft-delete about ' +
              count +
              ' extra same-folder URL copy/copies (keep newest).';
          } else {
            appendText(messageEl, 'Are you sure?');
            fallback = 'Are you sure?';
          }

          titleEl.textContent = title;
          okBtn.textContent = okLabel;
          okBtn.classList.toggle('btn-danger', danger);
          okBtn.classList.toggle('btn-primary', !danger);
          if (warning) {
            warningEl.textContent = warning;
            warningEl.hidden = false;
          } else {
            warningEl.textContent = '';
            warningEl.hidden = true;
          }

          return fallback;
        }

        function openConfirmDialog(form) {
          if (!dialog || !messageEl || !titleEl || !okBtn) return false;
          var kind = form.getAttribute('data-confirm') || '';
          var username = form.getAttribute('data-username') || 'this user';
          var count = form.getAttribute('data-count') || '0';
          var fallback = buildConfirmContent(kind, username, count);
          pendingForm = form;

          if (typeof dialog.showModal === 'function') {
            dialog.showModal();
            var cancelBtn = dialog.querySelector('button[value="cancel"]');
            if (cancelBtn) cancelBtn.focus();
          } else {
            var ok = window.confirm(fallback);
            if (ok) {
              pendingForm = null;
              HTMLFormElement.prototype.submit.call(form);
            } else {
              pendingForm = null;
            }
          }
          return true;
        }

        if (dialog) {
          dialog.addEventListener('close', function () {
            var form = pendingForm;
            pendingForm = null;
            if (dialog.returnValue === 'confirm' && form) {
              // form.submit() does not fire the submit event — goes straight to the server
              HTMLFormElement.prototype.submit.call(form);
            }
          });

          // Click backdrop to cancel
          dialog.addEventListener('click', function (e) {
            if (e.target === dialog) {
              dialog.close('cancel');
            }
          });
        }

        document.querySelectorAll('form.form-confirm-action').forEach(function (form) {
          form.addEventListener('submit', function (e) {
            e.preventDefault();
            openConfirmDialog(form);
            return false;
          });
        });

        // Factory-reset dialog (requires checkbox acknowledgment)
        var resetForm = document.getElementById('form-reset-default');
        var resetDialog = document.getElementById('confirm-reset');
        var resetCheckbox = document.getElementById('confirm-reset-checkbox');
        var resetOkBtn = document.getElementById('confirm-reset-ok');
        var resetConfirmValue = document.getElementById('reset-confirm-value');
        var resetPending = false;

        function resetResetDialogState() {
          if (resetCheckbox) resetCheckbox.checked = false;
          if (resetOkBtn) resetOkBtn.disabled = true;
          if (resetConfirmValue) resetConfirmValue.value = '';
          resetPending = false;
        }

        if (resetCheckbox && resetOkBtn) {
          resetCheckbox.addEventListener('change', function () {
            resetOkBtn.disabled = !resetCheckbox.checked;
          });
        }

        if (resetDialog) {
          var resetDialogForm = document.getElementById('confirm-reset-form');
          if (resetDialogForm) {
            resetDialogForm.addEventListener('submit', function (e) {
              // Block confirm path unless the acknowledgment checkbox is checked
              var submitter = e.submitter;
              var value = submitter && submitter.value ? submitter.value : '';
              if (value === 'confirm' && (!resetCheckbox || !resetCheckbox.checked)) {
                e.preventDefault();
                if (resetOkBtn) resetOkBtn.disabled = true;
                return false;
              }
              return true;
            });
          }

          resetDialog.addEventListener('close', function () {
            var acknowledged = resetCheckbox && resetCheckbox.checked;
            if (
              resetDialog.returnValue === 'confirm' &&
              resetPending &&
              resetForm &&
              acknowledged
            ) {
              if (resetConfirmValue) resetConfirmValue.value = '1';
              resetPending = false;
              HTMLFormElement.prototype.submit.call(resetForm);
              return;
            }
            resetResetDialogState();
          });

          resetDialog.addEventListener('click', function (e) {
            if (e.target === resetDialog) {
              resetDialog.close('cancel');
            }
          });
        }

        if (resetForm) {
          resetForm.addEventListener('submit', function (e) {
            e.preventDefault();
            if (!resetDialog) return false;
            resetPending = true;
            if (resetCheckbox) resetCheckbox.checked = false;
            if (resetOkBtn) resetOkBtn.disabled = true;
            if (resetConfirmValue) resetConfirmValue.value = '';
            if (typeof resetDialog.showModal === 'function') {
              resetDialog.showModal();
              if (resetCheckbox) resetCheckbox.focus();
            } else {
              // Fallback: double confirm + require typing (checkbox not available)
              var ok1 = window.confirm(
                'Reset to default?\\n\\nThis deletes ALL users, bookmarks, and the database. You will need to set up the admin again.\\n\\nThis cannot be undone.'
              );
              if (!ok1) {
                resetPending = false;
                return false;
              }
              var typed = window.prompt(
                'Type RESET to confirm that you understand everything will be deleted:'
              );
              if (typed === 'RESET') {
                if (resetConfirmValue) resetConfirmValue.value = '1';
                resetPending = false;
                HTMLFormElement.prototype.submit.call(resetForm);
              } else {
                resetPending = false;
              }
            }
            return false;
          });
        }
      })();
    </script>`;

  return layout({ title: 'Users', user, flash, body });
}

module.exports = { usersPage };
