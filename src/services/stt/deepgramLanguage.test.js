const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { mapLanguageCodeForDeepgram } = require('./deepgramLanguage');

describe('mapLanguageCodeForDeepgram', () => {
  it('passes through known Deepgram locales', () => {
    assert.equal(mapLanguageCodeForDeepgram('en-US'), 'en-US');
    assert.equal(mapLanguageCodeForDeepgram('en-CA'), 'en-CA');
    assert.equal(mapLanguageCodeForDeepgram('fr-CA'), 'fr-CA');
    assert.equal(mapLanguageCodeForDeepgram('ja'), 'ja');
    assert.equal(mapLanguageCodeForDeepgram('kk'), 'kk');
  });

  it('aliases unsupported Google-style locales onto Deepgram codes', () => {
    assert.equal(mapLanguageCodeForDeepgram('en-IE'), 'en');
    assert.equal(mapLanguageCodeForDeepgram('es-MX'), 'es-419');
    assert.equal(mapLanguageCodeForDeepgram('ja-JP'), 'ja');
  });

  it('falls back to language family then en', () => {
    assert.equal(mapLanguageCodeForDeepgram('de-LU'), 'de');
    assert.equal(mapLanguageCodeForDeepgram('xx-YY'), 'en');
    assert.equal(mapLanguageCodeForDeepgram(''), 'en');
    assert.equal(mapLanguageCodeForDeepgram(null), 'en');
  });
});
