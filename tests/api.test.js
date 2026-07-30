const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { applyTestEnv, cleanupTempDir } = require('./helpers');

describe('API HTTP', () => {
  let apiApp;
  let User;
  let closeDb;
  let apiKey;

  before(() => {
    applyTestEnv({
      TIME_FORMAT: '12h',
      STATUS_MESSAGE: 'test-online',
    });
    // Require server after env so session secret / paths resolve correctly
    ({ apiApp } = require('../server'));
    closeDb = require('../src/utils/db').closeDb;
    User = require('../src/models/User');
    require('../src/utils/db').getDb();
  });

  after(() => {
    closeDb();
    cleanupTempDir();
  });

  beforeEach(() => {
    const db = require('../src/utils/db').getDb();
    db.exec('DELETE FROM bookmarks; DELETE FROM users;');
    const user = User.create({ username: 'apiuser' });
    apiKey = user.apiKey;
  });

  it('GET /health returns ok', async () => {
    const res = await request(apiApp).get('/health').expect(200);
    assert.equal(res.body.status, 'ok');
    assert.ok(typeof res.body.uptime === 'number');
  });

  it('GET /info exposes version and timeFormat', async () => {
    const res = await request(apiApp).get('/info').expect(200);
    assert.equal(res.body.name, 'bookmarks-sync');
    assert.equal(res.body.timeFormat, '12h');
    assert.equal(res.body.message, 'test-online');
    assert.ok(res.body.version);
  });

  it('rejects missing / invalid API keys', async () => {
    await request(apiApp).get('/api/bookmarks').expect(401);
    await request(apiApp)
      .get('/api/bookmarks')
      .set('X-API-Key', 'bms_invalid')
      .expect(401);
  });

  it('lists and creates bookmarks with X-API-Key', async () => {
    const empty = await request(apiApp)
      .get('/api/bookmarks')
      .set('X-API-Key', apiKey)
      .expect(200);
    assert.ok(Array.isArray(empty.body.bookmarks) || Array.isArray(empty.body));

    const created = await request(apiApp)
      .post('/api/bookmarks')
      .set('X-API-Key', apiKey)
      .send({ title: 'GitHub', url: 'https://github.com/', folder: '' })
      .expect((r) => {
        if (r.status !== 200 && r.status !== 201) {
          throw new Error(`unexpected status ${r.status}: ${JSON.stringify(r.body)}`);
        }
      });

    const list = await request(apiApp)
      .get('/api/bookmarks')
      .set('X-API-Key', apiKey)
      .expect(200);

    const bookmarks = list.body.bookmarks || list.body;
    assert.ok(bookmarks.some((b) => b.title === 'GitHub' || b.url?.includes('github.com')));
    assert.ok(created.body);
  });

  it('accepts Authorization Bearer API key', async () => {
    await request(apiApp)
      .get('/api/bookmarks')
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);
  });
});
