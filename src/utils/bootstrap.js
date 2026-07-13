const User = require('../models/User');
const { getDb } = require('./db');
const { hashPassword } = require('./crypto');

/**
 * Ensure at least one admin exists.
 * ADMIN_USERNAME / ADMIN_PASSWORD are used only when:
 *   - no admin exists yet (create), or
 *   - RESET_ADMIN_PASSWORD=true (overwrite existing admin login from .env)
 *
 * Changing .env alone does NOT update an existing admin — set RESET_ADMIN_PASSWORD=true once, restart, then remove it.
 */
function bootstrapAdmin() {
  const db = getDb();
  const adminCount = User.countAdmins();
  const username = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const reset = String(process.env.RESET_ADMIN_PASSWORD || '').toLowerCase() === 'true';

  if (adminCount === 0) {
    if (!password || password.length < 1) {
      console.error(
        '[bootstrap] No admin users found. Set ADMIN_PASSWORD in .env and restart.'
      );
      console.error(
        '[bootstrap] Example: ADMIN_USERNAME=admin  ADMIN_PASSWORD=your-secure-password'
      );
      process.exit(1);
    }

    if (password === 'change-me-admin-password' || password === 'admin') {
      console.warn(
        '[bootstrap] WARNING: using a weak ADMIN_PASSWORD — change it before any real use.'
      );
    }

    const admin = User.create({
      username,
      password,
      displayName: 'Administrator',
      isAdmin: true,
    });

    console.log(`[bootstrap] Created admin user "${admin.username}"`);
    console.log(`[bootstrap] Admin API key: ${admin.apiKey}`);
    console.log('[bootstrap] Store the API key securely; it is also visible in the admin UI.');
  } else if (reset) {
    if (!password || password.length < 1) {
      console.error('[bootstrap] RESET_ADMIN_PASSWORD=true but ADMIN_PASSWORD is empty.');
      process.exit(1);
    }

    const adminRow = db
      .prepare(`SELECT id FROM users WHERE is_admin = 1 ORDER BY created_at ASC LIMIT 1`)
      .get();

    db.prepare(
      `UPDATE users SET username = ?, password_hash = ?, is_active = 1, updated_at = ?
       WHERE id = ?`
    ).run(username, hashPassword(password), new Date().toISOString(), adminRow.id);

    console.log(
      `[bootstrap] Reset admin login from .env → username "${username}". Remove RESET_ADMIN_PASSWORD from .env now.`
    );
  }

  // Assign legacy bookmarks without owner to first admin
  const admin = db
    .prepare(
      `SELECT id FROM users WHERE is_admin = 1 ORDER BY created_at ASC LIMIT 1`
    )
    .get();

  if (admin) {
    const orphaned = db
      .prepare(`SELECT COUNT(*) AS c FROM bookmarks WHERE user_id IS NULL`)
      .get().c;
    if (orphaned > 0) {
      db.prepare(`UPDATE bookmarks SET user_id = ? WHERE user_id IS NULL`).run(admin.id);
      console.log(`[bootstrap] Assigned ${orphaned} orphan bookmark(s) to admin`);
    }
  }
}

module.exports = { bootstrapAdmin };
