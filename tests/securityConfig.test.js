const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { applyTestEnv, cleanupTempDir } = require('./helpers');

describe('securityConfig', () => {
  before(() => {
    applyTestEnv();
  });

  after(() => {
    cleanupTempDir();
  });

  it('flags insecure passwords and secrets', () => {
    const {
      isInsecureAdminPassword,
      isInsecureSessionSecret,
      getAdminPasswordError,
      resolveSessionMaxAgeMinutes,
    } = require('../src/utils/securityConfig');

    assert.equal(isInsecureAdminPassword('admin'), true);
    assert.equal(isInsecureAdminPassword('password'), true);
    assert.equal(isInsecureAdminPassword('correct-horse-battery'), false);

    assert.equal(isInsecureSessionSecret('secret'), true);
    assert.equal(isInsecureSessionSecret('short'), true);
    assert.equal(isInsecureSessionSecret('a'.repeat(32)), false);

    assert.ok(getAdminPasswordError('admin'));
    assert.ok(getAdminPasswordError('short1'));
    assert.equal(getAdminPasswordError('long-enough-password'), null);

    assert.equal(resolveSessionMaxAgeMinutes(), 15);
  });

  it('honors SESSION_MAX_AGE_MINUTES', () => {
    const { resolveSessionMaxAgeMinutes, resolveSessionMaxAgeMs } = require('../src/utils/securityConfig');
    process.env.SESSION_MAX_AGE_MINUTES = '45';
    assert.equal(resolveSessionMaxAgeMinutes(), 45);
    assert.equal(resolveSessionMaxAgeMs(), 45 * 60 * 1000);
    process.env.SESSION_MAX_AGE_MINUTES = '0';
    assert.equal(resolveSessionMaxAgeMinutes(), 15);
    delete process.env.SESSION_MAX_AGE_MINUTES;
  });
});
