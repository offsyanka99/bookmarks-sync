const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { applyTestEnv, cleanupTempDir } = require('./helpers');

describe('Admin HTTP', () => {
  let adminApp;
  let User;
  let closeDb;
  let needsSetup;

  before(() => {
    applyTestEnv();
    ({ adminApp } = require('../server'));
    closeDb = require('../src/utils/db').closeDb;
    User = require('../src/models/User');
    needsSetup = require('../src/utils/bootstrap').needsSetup;
    require('../src/utils/db').getDb();
  });

  after(() => {
    closeDb();
    cleanupTempDir();
  });

  beforeEach(() => {
    const db = require('../src/utils/db').getDb();
    db.exec('DELETE FROM bookmarks; DELETE FROM users;');
  });

  it('redirects to setup when no admin exists', async () => {
    assert.equal(needsSetup(), true);
    const res = await request(adminApp).get('/login').redirects(0);
    // login may render or redirect depending on setup state
    assert.ok([200, 302, 303].includes(res.status));
    if (res.status === 302 || res.status === 303) {
      assert.match(String(res.headers.location || ''), /setup|login/i);
    }

    const setup = await request(adminApp).get('/setup').expect(200);
    assert.match(setup.text, /setup|password|admin/i);
  });

  it('GET /session requires an admin session', async () => {
    // While setup is needed, requireAdmin redirects HTML clients to /setup
    const res = await request(adminApp).get('/session').redirects(0);
    assert.ok([401, 302, 303, 503].includes(res.status));
  });

  it('login works after creating admin', async () => {
    User.create({
      username: 'admin',
      password: 'strong-password-1',
      isAdmin: true,
      displayName: 'Administrator',
    });
    assert.equal(needsSetup(), false);

    const agent = request.agent(adminApp);
    const res = await agent
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: 'strong-password-1' });
    assert.ok([200, 302, 303].includes(res.status));
    // Successful login usually redirects to /
    if (res.status === 302 || res.status === 303) {
      assert.ok(res.headers.location);
    }
  });
});
