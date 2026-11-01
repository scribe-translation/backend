const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { getBaseLanguageCode, isSameLanguage } = require('./languageCodeMapper');

describe('getBaseLanguageCode', () => {
  it('maps formal Filipino fil onto contemporary Tagalog tl', () => {
    assert.equal(getBaseLanguageCode('fil'), 'tl');
    assert.equal(getBaseLanguageCode('fil-PH'), 'tl');
  });

  it('leaves Finnish fi alone', () => {
    assert.equal(getBaseLanguageCode('fi'), 'fi');
    assert.equal(getBaseLanguageCode('fi-FI'), 'fi');
  });

  it('keeps existing locale rules', () => {
    assert.equal(getBaseLanguageCode('zh-CN'), 'zh-CN');
    assert.equal(getBaseLanguageCode('zh-TW'), 'zh-TW');
    assert.equal(getBaseLanguageCode('yue-Hant-HK'), 'yue');
    assert.equal(getBaseLanguageCode('en-US'), 'en');
    assert.equal(getBaseLanguageCode('tl'), 'tl');
  });
});

describe('isSameLanguage', () => {
  it('treats Filipino and Tagalog as the same language', () => {
    assert.equal(isSameLanguage('fil', 'tl'), true);
    assert.equal(isSameLanguage('fil-PH', 'tl'), true);
  });

  it('does not treat Finnish as Filipino or Tagalog', () => {
    assert.equal(isSameLanguage('fi', 'fil'), false);
    assert.equal(isSameLanguage('fi', 'tl'), false);
    assert.equal(isSameLanguage('fi-FI', 'fil-PH'), false);
  });
});
