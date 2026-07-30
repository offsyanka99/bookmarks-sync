const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Bookmark = require('../src/models/Bookmark');

describe('Bookmark helpers', () => {
  it('normalizeUrl uses WHATWG URL when possible', () => {
    assert.equal(Bookmark.normalizeUrl('https://Example.com/path'), 'https://example.com/path');
    assert.equal(Bookmark.normalizeUrl('  https://x.test/  '), 'https://x.test/');
    assert.equal(Bookmark.normalizeUrl(''), '');
    assert.equal(Bookmark.normalizeUrl(null), '');
    // invalid → trim raw
    assert.equal(Bookmark.normalizeUrl('  not a url  '), 'not a url');
  });

  it('isUrlBookmarkLike excludes folders and empty urls', () => {
    assert.equal(Bookmark.isUrlBookmarkLike({ url: 'https://a.test', tags: [] }), true);
    assert.equal(Bookmark.isUrlBookmarkLike({ url: '', tags: [] }), false);
    assert.equal(Bookmark.isUrlBookmarkLike({ url: 'folder:Toolbar', tags: [] }), false);
    assert.equal(
      Bookmark.isUrlBookmarkLike({ url: 'https://a.test', tags: ['__dir__'] }),
      false
    );
  });
});
