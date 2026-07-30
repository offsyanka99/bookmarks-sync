const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveTimeFormat,
  timeFormatHour12,
  DEFAULT_TIME_FORMAT,
} = require('../src/utils/timeFormat');

describe('timeFormat', () => {
  it('defaults to 24h', () => {
    assert.equal(DEFAULT_TIME_FORMAT, '24h');
    assert.equal(resolveTimeFormat(undefined), '24h');
    assert.equal(resolveTimeFormat(''), '24h');
    assert.equal(resolveTimeFormat('nope'), '24h');
  });

  it('accepts 12h aliases', () => {
    for (const v of ['12h', '12', 'h12', 'ampm', 'am/pm', '12H']) {
      assert.equal(resolveTimeFormat(v), '12h', v);
    }
    assert.equal(timeFormatHour12('12h'), true);
  });

  it('accepts 24h aliases', () => {
    for (const v of ['24h', '24', 'h23', 'military', '24H']) {
      assert.equal(resolveTimeFormat(v), '24h', v);
    }
    assert.equal(timeFormatHour12('24h'), false);
  });
});
