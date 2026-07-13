const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../utils/db');
const { hashPassword, verifyPassword, generateApiKey } = require('../utils/crypto');

function nowIso() {
  return new Date().toISOString();
}

function rowToUser(row, { includeApiKey = false } = {}) {
  if (!row) return null;
  const user = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: Boolean(row.is_admin),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    apiKeyPrefix: row.api_key ? `${row.api_key.slice(0, 12)}…` : null,
  };
  if (includeApiKey) {
    user.apiKey = row.api_key;
  }
  return user;
}

class User {
  static findAll() {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, username, display_name, api_key, is_admin, is_active, created_at, updated_at
         FROM users ORDER BY is_admin DESC, username ASC`
      )
      .all();
    return rows.map((r) => rowToUser(r, { includeApiKey: true }));
  }

  static findById(id, { includeApiKey = false } = {}) {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT id, username, display_name, api_key, password_hash, is_admin, is_active, created_at, updated_at
         FROM users WHERE id = ?`
      )
      .get(id);
    if (!row) return null;
    const user = rowToUser(row, { includeApiKey });
    user._passwordHash = row.password_hash;
    return user;
  }

  static findByUsername(username) {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT id, username, display_name, api_key, password_hash, is_admin, is_active, created_at, updated_at
         FROM users WHERE username = ? COLLATE NOCASE`
      )
      .get(username);
    if (!row) return null;
    const user = rowToUser(row, { includeApiKey: false });
    user._passwordHash = row.password_hash;
    user.apiKey = row.api_key;
    return user;
  }

  static findByApiKey(apiKey) {
    if (!apiKey) return null;
    const db = getDb();
    const row = db
      .prepare(
        `SELECT id, username, display_name, api_key, is_admin, is_active, created_at, updated_at
         FROM users WHERE api_key = ? AND is_active = 1`
      )
      .get(apiKey);
    return rowToUser(row, { includeApiKey: false });
  }

  static count() {
    return getDb().prepare('SELECT COUNT(*) AS c FROM users').get().c;
  }

  static countAdmins() {
    return getDb().prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c;
  }

  static authenticate(username, password) {
    const user = this.findByUsername(username);
    if (!user || !user.isActive) return null;
    if (!verifyPassword(password, user._passwordHash)) return null;
    // Strip internal fields for session
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      isAdmin: user.isAdmin,
      isActive: user.isActive,
    };
  }

  static create({ username, password, displayName = '', isAdmin = false }) {
    const normalized = String(username || '')
      .trim()
      .toLowerCase();
    if (!normalized || normalized.length < 2) {
      throw Object.assign(new Error('Username must be at least 2 characters'), { code: 'VALIDATION' });
    }
    if (!/^[a-z0-9._-]+$/.test(normalized)) {
      throw Object.assign(
        new Error('Username may only contain letters, numbers, dots, underscores, hyphens'),
        { code: 'VALIDATION' }
      );
    }
    if (!password || String(password).length < 1) {
      throw Object.assign(new Error('Password is required'), { code: 'VALIDATION' });
    }

    const db = getDb();
    const id = uuidv4();
    const ts = nowIso();
    const apiKey = generateApiKey();

    try {
      db.prepare(
        `INSERT INTO users
          (id, username, password_hash, display_name, api_key, is_admin, is_active, created_at, updated_at)
         VALUES
          (@id, @username, @password_hash, @display_name, @api_key, @is_admin, 1, @created_at, @updated_at)`
      ).run({
        id,
        username: normalized,
        password_hash: hashPassword(password),
        display_name: displayName || normalized,
        api_key: apiKey,
        is_admin: isAdmin ? 1 : 0,
        created_at: ts,
        updated_at: ts,
      });
    } catch (err) {
      if (err && String(err.message).includes('UNIQUE')) {
        throw Object.assign(new Error('Username already exists'), { code: 'CONFLICT' });
      }
      throw err;
    }

    return this.findById(id, { includeApiKey: true });
  }

  static updatePassword(id, password) {
    if (!password || String(password).length < 1) {
      throw Object.assign(new Error('Password is required'), { code: 'VALIDATION' });
    }
    const db = getDb();
    const result = db
      .prepare(
        `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`
      )
      .run(hashPassword(password), nowIso(), id);
    return result.changes > 0;
  }

  static setActive(id, isActive) {
    const db = getDb();
    const result = db
      .prepare(`UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?`)
      .run(isActive ? 1 : 0, nowIso(), id);
    return result.changes > 0;
  }

  static regenerateApiKey(id) {
    const db = getDb();
    const apiKey = generateApiKey();
    const result = db
      .prepare(`UPDATE users SET api_key = ?, updated_at = ? WHERE id = ?`)
      .run(apiKey, nowIso(), id);
    if (result.changes === 0) return null;
    return this.findById(id, { includeApiKey: true });
  }

  static delete(id) {
    const db = getDb();
    // Prevent deleting the last admin
    const target = this.findById(id);
    if (!target) return false;
    if (target.isAdmin && this.countAdmins() <= 1) {
      throw Object.assign(new Error('Cannot delete the last admin user'), { code: 'VALIDATION' });
    }

    const run = db.transaction(() => {
      db.prepare('DELETE FROM bookmarks WHERE user_id = ?').run(id);
      return db.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
    return run().changes > 0;
  }
}

module.exports = User;
