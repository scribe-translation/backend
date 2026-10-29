const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  INTERIM_TRANSLATION_INTERVAL_MS,
  shouldTranslateInterim,
} = require('./interimTranslationThrottle');

describe('shouldTranslateInterim', () => {
  it('translates the first interim result immediately', () => {
    assert.equal(shouldTranslateInterim(null, 10_000), true);
  });

  it('holds the previous translation until two seconds have passed', () => {
    const translatedAt = 10_000;

    assert.equal(INTERIM_TRANSLATION_INTERVAL_MS, 2000);
    assert.equal(shouldTranslateInterim(translatedAt, translatedAt + 1999), false);
    assert.equal(shouldTranslateInterim(translatedAt, translatedAt + 2000), true);
  });
});
