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

function layout({ title, user, flash, body }) {
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
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
</body>
</html>`;
}

module.exports = { layout, escapeHtml, APP_VERSION, CONTACT_EMAIL };
