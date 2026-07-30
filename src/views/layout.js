const path = require('path');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getAppVersion() {
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const APP_VERSION = getAppVersion();
const CONTACT_EMAIL = 'hummersoft@mailbox.org';

function layout({ title, user, flash, body, sessionMaxAgeMs = 0 }) {
  const flashHtml = flash
    ? `<div class="flash flash-${escapeHtml(flash.type || 'info')}" role="status">${escapeHtml(flash.message)}</div>`
    : '';

  const brand = `
    <img class="brand-logo" src="/icons/icon32.png" width="28" height="28" alt="" />
    <span>Bookmarks Sync Admin</span>`;

  const nav = user
    ? `<nav class="topnav">
        <a class="brand" href="/">${brand}</a>
        <div class="topnav-right">
          <span class="muted">${escapeHtml(user.displayName || user.username)}</span>
          <form method="post" action="/logout" class="inline">
            <button type="submit" class="btn btn-ghost">Log out</button>
          </form>
        </div>
      </nav>`
    : `<nav class="topnav">
        <a class="brand" href="/login">${brand}</a>
      </nav>`;

  const footer = `
  <footer class="site-footer">
    <div class="container footer-inner">
      <span>Bookmarks Sync <span class="mono">v${escapeHtml(APP_VERSION)}</span></span>
      <span class="footer-sep" aria-hidden="true">·</span>
      <a href="mailto:${escapeHtml(CONTACT_EMAIL)}">${escapeHtml(CONTACT_EMAIL)}</a>
    </div>
  </footer>`;

  // Login (and other logged-out pages): compact layout so footer stays on-screen
  const bodyClass = user ? '' : 'layout-auth';

  // When the session cookie expires, the already-rendered page still shows API keys
  // and other data until navigation. Clear the DOM and send the admin to login.
  // Cookie is rolling on server requests; client deadline resets only after a successful check.
  const maxAge = Number(sessionMaxAgeMs) || 0;
  const sessionWatchdog =
    user && maxAge > 0
      ? `<script>
(function () {
  var maxAgeMs = ${JSON.stringify(maxAge)};
  var loginUrl = '/login?expired=1';
  var fired = false;
  var deadline = Date.now() + maxAgeMs;
  var timerId = null;

  function expireSession() {
    if (fired) return;
    fired = true;
    if (timerId) clearTimeout(timerId);
    try {
      document.documentElement.innerHTML = '';
    } catch (e) {}
    try {
      window.location.replace(loginUrl);
    } catch (e2) {
      window.location.href = loginUrl;
    }
  }

  function armTimer() {
    if (timerId) clearTimeout(timerId);
    var ms = Math.max(0, deadline - Date.now());
    timerId = setTimeout(expireSession, ms);
  }

  function bumpDeadline() {
    deadline = Date.now() + maxAgeMs;
    armTimer();
  }

  function revalidateSession() {
    // Cheap probe: 204 when session is valid (also rolls the cookie); 401 when expired.
    fetch('/session', {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'manual',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
      .then(function (res) {
        if (res && res.status === 204) {
          bumpDeadline();
          return;
        }
        // redirect / 401 / opaque → treat as logged out
        expireSession();
      })
      .catch(function () {
        // Network blip: do not clear the page; idle timer still enforces max age.
      });
  }

  armTimer();

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() >= deadline) {
      expireSession();
      return;
    }
    revalidateSession();
  });

  // Intercept form posts: if the session died, browser would leave secrets on screen
  // until navigation completes; revalidate first only when already past deadline.
  document.addEventListener(
    'submit',
    function (e) {
      if (Date.now() >= deadline) {
        e.preventDefault();
        expireSession();
      }
    },
    true
  );
})();
</script>`
      : '';

  const cacheMeta = user
    ? `<meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate, private" />
  <meta http-equiv="Pragma" content="no-cache" />`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${cacheMeta}
  <title>${escapeHtml(title)} · Bookmarks Sync</title>
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="icon" type="image/png" href="/favicon.png" />
  <link rel="apple-touch-icon" href="/icons/icon180.png" />
  <link rel="stylesheet" href="/admin.css" />
</head>
<body class="${bodyClass}">
  ${nav}
  <main class="container">
    ${flashHtml}
    ${body}
  </main>
  ${footer}
  ${sessionWatchdog}
</body>
</html>`;
}

module.exports = { layout, escapeHtml, APP_VERSION, CONTACT_EMAIL };
