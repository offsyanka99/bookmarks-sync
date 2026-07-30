const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  hashPassword,
  verifyPassword,
  generateApiKey,
  generateSessionSecret,
} = require('../src/utils/crypto');

describe('crypto', () => {
  it('hashPassword + verifyPassword round-trip', () => {
    const stored = hashPassword('s3cret-pass');
    assert.ok(stored.includes(':'));
    assert.equal(verifyPassword('s3cret-pass', stored), true);
    assert.equal(verifyPassword('wrong', stored), false);
  });

  it('verifyPassword rejects invalid stored values', () => {
    assert.equal(verifyPassword('x', null), false);
    assert.equal(verifyPassword('x', ''), false);
    assert.equal(verifyPassword('x', 'nosalt'), false);
    assert.equal(verifyPassword('x', ':'), false);
  });

  it('generateApiKey uses bms_ prefix and entropy', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    assert.match(a, /^bms_[a-f0-9]{64}$/);
    assert.notEqual(a, b);
  });

  it('generateSessionSecret is hex of sufficient length', () => {
    const s = generateSessionSecret();
    assert.match(s, /^[a-f0-9]{64}$/);
  });
});
