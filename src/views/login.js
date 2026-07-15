const { layout, escapeHtml } = require('./layout');

function loginPage({ error, username = 'admin' } = {}) {
  const flash = error ? { type: 'error', message: error } : null;

  const body = `
    <div class="auth-wrap">
      <div class="card auth-card">
        <h1>Admin login</h1>
        <p class="muted">Sign in with your admin username and password.</p>
        <form method="post" action="/login" class="stack">
          <label>
            Username
            <input type="text" name="username" autocomplete="username" required value="${escapeHtml(username)}" />
          </label>
          <label>
            Password
            <input type="password" name="password" autocomplete="current-password" required />
          </label>
          <button type="submit" class="btn btn-primary">Sign in</button>
        </form>
      </div>
    </div>`;

  return layout({ title: 'Login', user: null, flash, body });
}

module.exports = { loginPage };
