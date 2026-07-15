const { layout, escapeHtml } = require('./layout');

/**
 * First-run admin password form (no admin exists yet).
 */
function setupPage({ error = null, username = 'admin' } = {}) {
  const flash = error ? { type: 'error', message: error } : null;

  const body = `
    <div class="auth-wrap">
      <div class="card auth-card">
        <h1>Create admin password</h1>
        <p class="muted">
          First-time setup. Choose a password for the built-in
          <strong class="mono">${escapeHtml(username)}</strong> account.
          An API key is generated after you continue.
        </p>
        <form method="post" action="/setup" class="stack">
          <label>
            Username
            <input type="text" name="username" value="${escapeHtml(username)}" readonly autocomplete="username" />
          </label>
          <label>
            Password
            <input type="password" name="password" autocomplete="new-password" required minlength="8" />
          </label>
          <label>
            Confirm password
            <input type="password" name="passwordConfirm" autocomplete="new-password" required minlength="8" />
          </label>
          <button type="submit" class="btn btn-primary">Create admin &amp; continue</button>
        </form>
        <p class="muted" style="margin-top:1rem;margin-bottom:0;font-size:0.9rem">
          Use at least 8 characters. Avoid simple defaults like <span class="mono">admin</span> or <span class="mono">password</span>.
        </p>
      </div>
    </div>`;

  return layout({ title: 'Setup', user: null, flash, body });
}

/**
 * One-time success screen after admin is created (shows API key once).
 */
function setupCompletePage({ username, apiKey }) {
  const body = `
    <div class="auth-wrap">
      <div class="card auth-card">
        <h1>Admin ready</h1>
        <p class="muted">
          Account <strong class="mono">${escapeHtml(username)}</strong> was created.
          Copy the API key now — you can also view and regenerate keys later in the admin portal.
        </p>
        <div class="stack">
          <label>
            API key
            <input type="text" class="mono" readonly value="${escapeHtml(apiKey)}" onclick="this.select()" />
          </label>
          <p class="muted" style="margin:0;font-size:0.9rem">
            Use this key in the browser extension (API port), not the admin login.
          </p>
          <a class="btn btn-primary" href="/login" style="text-align:center">Go to login</a>
        </div>
      </div>
    </div>`;

  return layout({
    title: 'Setup complete',
    user: null,
    flash: { type: 'success', message: 'Password saved. Sign in with your new admin password.' },
    body,
  });
}

module.exports = { setupPage, setupCompletePage };
