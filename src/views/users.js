const { layout, escapeHtml, csrfInput } = require('./layout');

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
  sessionMaxAgeMs = 0,
  csrfToken = '',
}) {
  const csrf = csrfInput(csrfToken);

  function menuForm({ action, confirm, username, count, label, title, disabled, danger }) {
    const confirmAttrs = confirm
      ? ` class="action-menu-form form-confirm-action" data-confirm="${escapeHtml(confirm)}" data-username="${escapeHtml(username)}" data-count="${escapeHtml(String(count ?? 0))}"`
      : ' class="action-menu-form"';
    const itemClass = danger ? 'action-menu-item action-menu-item-danger' : 'action-menu-item';
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    const disabledAttr = disabled ? ' disabled' : '';
    return `<form method="post" action="${escapeHtml(action)}"${confirmAttrs}>
              ${csrf}
              <button type="submit" class="${itemClass}" role="menuitem"${titleAttr}${disabledAttr}>${escapeHtml(label)}</button>
            </form>`;
  }

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
            <code title="Full key is shown once, when the user is created or the key is regenerated">${escapeHtml(u.apiKeyPrefix || '—')}</code>
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
              <div class="action-menu">
                <button type="button" class="btn btn-icon btn-action-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="user-actions-${escapeHtml(u.id)}" aria-label="Actions for ${escapeHtml(u.username)}" title="Actions">
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <circle cx="8" cy="3.25" r="1.35" fill="currentColor"></circle>
                    <circle cx="8" cy="8" r="1.35" fill="currentColor"></circle>
                    <circle cx="8" cy="12.75" r="1.35" fill="currentColor"></circle>
                  </svg>
                </button>
                <div class="action-menu-panel" id="user-actions-${escapeHtml(u.id)}" role="menu" hidden>
                  <a class="action-menu-item" role="menuitem" href="/users/${escapeHtml(u.id)}/export" title="Download ZIP of this user’s bookmarks">Export ZIP</a>
                  ${menuForm({
                    action: `/users/${u.id}/dedupe-bookmarks`,
                    confirm: 'dedupe-bookmarks',
                    username: u.username,
                    count: dupExtra,
                    label: 'Dedupe',
                    title: 'Soft-delete same-folder URL duplicates (keep newest)',
                    disabled: dupExtra === 0,
                  })}
                  ${menuForm({
                    action: `/users/${u.id}/clear-bookmarks`,
                    confirm: 'clear-bookmarks',
                    username: u.username,
                    count: bmCount,
                    label: 'Clear bookmarks',
                    disabled: bmCount === 0,
                  })}
                  ${menuForm({
                    action: `/users/${u.id}/regenerate-key`,
                    confirm: 'regenerate-key',
                    username: u.username,
                    label: 'New API key',
                  })}
                  ${
                    isSelf
                      ? ''
                      : `<div class="action-menu-sep" role="separator"></div>
                  ${menuForm({
                    action: `/users/${u.id}/${toggleAction}`,
                    label: toggleLabel,
                  })}
                  ${menuForm({
                    action: `/users/${u.id}/delete`,
                    confirm: 'delete-user',
                    username: u.username,
                    count: bmCount,
                    label: 'Delete',
                    danger: true,
                  })}`
                  }
                </div>
              </div>
            ${
              u.isAdmin
                ? `<form method="post" action="/users/${escapeHtml(u.id)}/password" class="password-form">
              ${csrf}
              <input type="password" name="password" placeholder="New password" required minlength="8" autocomplete="new-password" />
              <button type="submit" class="btn btn-small">Set password</button>
            </form>`
                : ''
            }
            ${isSelf ? '<span class="muted small">you</span>' : ''}
            </div>
          </td>
        </tr>`;
    })
    .join('');

  const body = `
    <header class="page-header">
      <div>
        <h1>Users</h1>
        <p class="muted">Only admins can create users. Regular users get an API key (extension / API). Passwords are only for admin portal login.</p>
      </div>
    </header>

    <section class="card">
      <h2>Create user</h2>
      <form method="post" action="/users" class="form-grid" id="form-create-user">
        ${csrf}
        <label>
          Username
          <input type="text" name="username" required minlength="2" pattern="[A-Za-z0-9._\\-]+" autocomplete="off" />
        </label>
        <label>
          Display name
          <input type="text" name="displayName" autocomplete="off" />
        </label>
        <label class="checkbox">
          <input type="checkbox" name="isAdmin" value="1" id="create-user-is-admin" />
          Admin
        </label>
        <label id="create-user-password-label" hidden>
          Password
          <input type="password" name="password" id="create-user-password" autocomplete="new-password" minlength="8" />
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
              <th title="Prefix only. The full key is shown once, in the notice after create or regenerate.">API key</th>
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
        ${csrf}
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

    <section class="card card-danger-zone">
      <h2>Danger zone</h2>
      <p class="muted small">
        Reset this instance to a clean first-run state. Deletes <strong>all users</strong>
        (including admins), <strong>all bookmarks</strong>, and the database file.
        A copy is saved next to the database as <span class="mono">bookmarks.db.bak-before-reset-…</span> first.
        You will be logged out and sent to the setup screen.
      </p>
      <form method="post" action="/settings/reset" id="form-reset-default" class="form-reset-default">
        ${csrf}
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

        // Password field only when creating an admin (portal login).
        var adminCb = document.getElementById('create-user-is-admin');
        var pwdLabel = document.getElementById('create-user-password-label');
        var pwdInput = document.getElementById('create-user-password');
        function syncCreatePasswordVisibility() {
          var isAdmin = adminCb && adminCb.checked;
          if (pwdLabel) pwdLabel.hidden = !isAdmin;
          if (pwdInput) {
            pwdInput.required = !!isAdmin;
            if (!isAdmin) pwdInput.value = '';
          }
        }
        if (adminCb) {
          adminCb.addEventListener('change', syncCreatePasswordVisibility);
          syncCreatePasswordVisibility();
        }

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

        var openMenuBtn = null;
        var ignoreMenuScroll = false;

        function closeActionMenus() {
          document.querySelectorAll('.action-menu-panel').forEach(function (panel) {
            panel.hidden = true;
          });
          document.querySelectorAll('.btn-action-menu[aria-expanded="true"]').forEach(function (btn) {
            btn.setAttribute('aria-expanded', 'false');
          });
          openMenuBtn = null;
        }

        function enabledMenuItems(panel) {
          return Array.prototype.filter.call(panel.querySelectorAll('[role="menuitem"]'), function (el) {
            return !el.disabled && el.getAttribute('aria-disabled') !== 'true';
          });
        }

        function placeActionMenu(btn, panel) {
          panel.hidden = false;
          var rect = btn.getBoundingClientRect();
          var width = panel.offsetWidth;
          var height = panel.offsetHeight;
          var left = rect.right - width;
          if (left < 8) left = 8;
          if (left + width > window.innerWidth - 8) {
            left = Math.max(8, window.innerWidth - width - 8);
          }
          var top = rect.bottom + 4;
          if (top + height > window.innerHeight - 8 && rect.top > height + 8) {
            top = rect.top - height - 4;
          }
          panel.style.left = Math.round(left) + 'px';
          panel.style.top = Math.round(top) + 'px';
        }

        function openActionMenu(btn) {
          var panel = document.getElementById(btn.getAttribute('aria-controls'));
          if (!panel) return;
          closeActionMenus();
          // The users table scrolls horizontally, which would clip a menu inside the cell.
          if (panel.parentElement !== document.body) document.body.appendChild(panel);
          placeActionMenu(btn, panel);
          btn.setAttribute('aria-expanded', 'true');
          openMenuBtn = btn;
          var items = enabledMenuItems(panel);
          ignoreMenuScroll = true;
          if (items.length) items[0].focus({ preventScroll: true });
          setTimeout(function () {
            ignoreMenuScroll = false;
          }, 0);
        }

        document.querySelectorAll('.btn-action-menu').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (btn.getAttribute('aria-expanded') === 'true') closeActionMenus();
            else openActionMenu(btn);
          });
          btn.addEventListener('keydown', function (e) {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            openActionMenu(btn);
            if (e.key === 'ArrowUp') {
              var panel = document.getElementById(btn.getAttribute('aria-controls'));
              var items = panel ? enabledMenuItems(panel) : [];
              if (items.length) items[items.length - 1].focus({ preventScroll: true });
            }
          });
        });

        document.querySelectorAll('.action-menu-panel').forEach(function (panel) {
          panel.addEventListener('click', function (e) {
            e.stopPropagation();
            var link = e.target.closest && e.target.closest('a[role="menuitem"]');
            if (link) closeActionMenus();
          });
          panel.addEventListener('keydown', function (e) {
            var items = enabledMenuItems(panel);
            if (!items.length) return;
            var index = items.indexOf(document.activeElement);
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              items[(index + 1) % items.length].focus({ preventScroll: true });
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              items[index <= 0 ? items.length - 1 : index - 1].focus({ preventScroll: true });
            } else if (e.key === 'Home') {
              e.preventDefault();
              items[0].focus({ preventScroll: true });
            } else if (e.key === 'End') {
              e.preventDefault();
              items[items.length - 1].focus({ preventScroll: true });
            }
          });
        });

        document.addEventListener('click', function () {
          if (openMenuBtn) closeActionMenus();
        });

        document.addEventListener('keydown', function (e) {
          if (!openMenuBtn) return;
          if (e.key !== 'Escape' && e.key !== 'Tab') return;
          if (e.key === 'Tab') e.preventDefault();
          var btn = openMenuBtn;
          closeActionMenus();
          btn.focus({ preventScroll: true });
        });

        window.addEventListener('resize', function () {
          if (openMenuBtn) closeActionMenus();
        });

        window.addEventListener(
          'scroll',
          function () {
            if (ignoreMenuScroll || !openMenuBtn) return;
            closeActionMenus();
          },
          true
        );

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
            closeActionMenus();
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

  return layout({ title: 'Users', user, flash, body, sessionMaxAgeMs, csrfToken });
}

module.exports = { usersPage };
