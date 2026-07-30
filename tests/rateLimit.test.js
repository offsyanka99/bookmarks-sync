const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../src/utils/rateLimit');

describe('createRateLimiter', () => {
  it('blocks after max failures and allows reset', () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 3,
      keyFn: () => 'test-ip',
    });

    const req = { ip: '1.2.3.4' };

    assert.equal(limiter.checkBlocked(req).blocked, false);
    limiter.recordFailure(req);
    limiter.recordFailure(req);
    assert.equal(limiter.checkBlocked(req).blocked, false);
    limiter.recordFailure(req);
    const blocked = limiter.checkBlocked(req);
    assert.equal(blocked.blocked, true);
    assert.ok(blocked.retryAfter >= 1);

    limiter.reset(req);
    assert.equal(limiter.checkBlocked(req).blocked, false);
  });
});
