const { layout, escapeHtml } = require('./layout');

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function usersPage({ user, users, flash, counts = {} }) {
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
            <code class="api-key" title="Full API key">${escapeHtml(u.apiKey || '')}</code>
          </td>
          <td class="num">${bmCount}</td>
          <td class="muted small">${escapeHtml(formatDate(u.createdAt))}</td>
          <td class="actions">
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
      <h2>All users <span class="muted">(${users.length})</span></h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>API key</th>
              <th>Bookmarks</th>
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

    <section class="card muted small">
      <p><strong>API usage</strong> (per user):</p>
      <pre>curl -H "Authorization: Bearer &lt;api-key&gt;" http://localhost:${escapeHtml(process.env.SERVER_PORT || '31059')}/api/bookmarks</pre>
      <p>Bookmark management UI for end users is planned next. For now, admins manage accounts only.</p>
    </section>`;

  return layout({ title: 'Users', user, flash, body });
}

module.exports = { usersPage };
