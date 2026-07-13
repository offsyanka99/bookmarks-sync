function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout({ title, user, flash, body }) {
  const flashHtml = flash
    ? `<div class="flash flash-${escapeHtml(flash.type || 'info')}" role="status">${escapeHtml(flash.message)}</div>`
    : '';

  const nav = user
    ? `<nav class="topnav">
        <a class="brand" href="/">Bookmarks Sync Admin</a>
        <div class="topnav-right">
          <span class="muted">${escapeHtml(user.displayName || user.username)}</span>
          <form method="post" action="/logout" class="inline">
            <button type="submit" class="btn btn-ghost">Log out</button>
          </form>
        </div>
      </nav>`
    : `<nav class="topnav">
        <a class="brand" href="/login">Bookmarks Sync Admin</a>
      </nav>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Bookmarks Sync</title>
  <link rel="stylesheet" href="/admin.css" />
</head>
<body>
  ${nav}
  <main class="container">
    ${flashHtml}
    ${body}
  </main>
</body>
</html>`;
}

module.exports = { layout, escapeHtml };
