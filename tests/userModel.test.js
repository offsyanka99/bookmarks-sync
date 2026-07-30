const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { applyTestEnv, cleanupTempDir } = require('./helpers');

describe('User model', () => {
  let User;
  let closeDb;

  before(() => {
    applyTestEnv();
    closeDb = require('../src/utils/db').closeDb;
    require('../src/utils/db').getDb();
    User = require('../src/models/User');
  });

  after(() => {
    closeDb();
    cleanupTempDir();
  });

  beforeEach(() => {
    const db = require('../src/utils/db').getDb();
    db.exec('DELETE FROM bookmarks; DELETE FROM users;');
  });

  it('creates admin with password and regular user without', () => {
    const admin = User.create({
      username: 'admin',
      password: 'strong-password-1',
      isAdmin: true,
    });
    assert.equal(admin.isAdmin, true);
    assert.ok(admin.apiKey.startsWith('bms_'));
    assert.ok(User.authenticate('admin', 'strong-password-1'));
    assert.equal(User.authenticate('admin', 'wrong'), null);

    const user = User.create({ username: 'alice', isAdmin: false });
    assert.equal(user.isAdmin, false);
    assert.ok(user.apiKey.startsWith('bms_'));
    assert.equal(User.findByApiKey(user.apiKey).username, 'alice');
  });

  it('rejects admin without password and regular password set', () => {
    assert.throws(
      () => User.create({ username: 'boss', isAdmin: true }),
      (err) => err.code === 'VALIDATION'
    );

    const user = User.create({ username: 'bob', isAdmin: false });
    assert.throws(
      () => User.updatePassword(user.id, 'anything'),
      (err) => err.code === 'VALIDATION' && /admin/i.test(err.message)
    );
  });

  it('prevents deleting the last admin', () => {
    const admin = User.create({
      username: 'admin',
      password: 'strong-password-1',
      isAdmin: true,
    });
    assert.throws(
      () => User.delete(admin.id),
      (err) => err.code === 'VALIDATION'
    );
  });

  it('regenerates API keys', () => {
    const user = User.create({ username: 'carol' });
    const oldKey = user.apiKey;
    const updated = User.regenerateApiKey(user.id);
    assert.notEqual(updated.apiKey, oldKey);
    assert.equal(User.findByApiKey(oldKey), null);
    assert.ok(User.findByApiKey(updated.apiKey));
  });
});
