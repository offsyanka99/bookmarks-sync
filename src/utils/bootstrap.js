const User = require('../models/User');
const { getDb } = require('./db');
const { hashPassword } = require('./crypto');
const {
  assertAdminPasswordSafe,
  resolveBootstrapAdminPassword,
  resolveBootstrapAdminUsername,
} = require('./securityConfig');

/**
 * True when no admin exists yet — admin UI should show first-run /setup.
 * @returns {boolean}
 */
function needsSetup() {
  return User.countAdmins() === 0;
}

/**
 * Ensure at least one admin exists *only* when ADMIN_PASSWORD is set in the environment.
 *
 * Default (no ADMIN_PASSWORD): leave empty → first-run setup in the admin UI.
 * Optional headless bootstrap: set ADMIN_PASSWORD (and optional ADMIN_USERNAME).
 * Emergency reset: RESET_ADMIN_PASSWORD=true + ADMIN_PASSWORD, restart once, then remove.
 *
 * In production, bootstrap/reset refuses known-default or short ADMIN_PASSWORD values.
 */
function bootstrapAdmin() {
  const db = getDb();
  const adminCount = User.countAdmins();
  const username = resolveBootstrapAdminUsername();
  const password = resolveBootstrapAdminPassword();
  const reset = String(process.env.RESET_ADMIN_PASSWORD || '').toLowerCase() === 'true';

  if (adminCount === 0) {
    if (password == null) {
      console.log(
        '[bootstrap] No admin user yet. Open the admin UI to set the password for user "admin" (first-run setup).'
      );
    } else {
      assertAdminPasswordSafe(password, { context: 'bootstrap the first admin' });

      const admin = User.create({
        username,
        password,
        displayName: 'Administrator',
        isAdmin: true,
      });

      console.log(`[bootstrap] Created admin user "${admin.username}" from ADMIN_PASSWORD env`);
      console.log(`[bootstrap] Admin API key: ${admin.apiKey}`);
      console.log('[bootstrap] Store the API key securely; it is also visible in the admin UI.');
    }
  } else if (reset) {
    if (password == null || password.length < 1) {
      console.error('[bootstrap] RESET_ADMIN_PASSWORD=true but ADMIN_PASSWORD is empty.');
      process.exit(1);
    }

    assertAdminPasswordSafe(password, { context: 'reset the admin password' });

    const adminRow = db
      .prepare(`SELECT id FROM users WHERE is_admin = 1 ORDER BY created_at ASC LIMIT 1`)
      .get();

    db.prepare(
      `UPDATE users SET username = ?, password_hash = ?, is_active = 1, updated_at = ?
       WHERE id = ?`
    ).run(username, hashPassword(password), new Date().toISOString(), adminRow.id);

    console.log(
      `[bootstrap] Reset admin login from env → username "${username}". Remove RESET_ADMIN_PASSWORD now.`
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

module.exports = { bootstrapAdmin, needsSetup };
