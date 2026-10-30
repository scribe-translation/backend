const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { parseDeepgramResultsMessage } = require('./deepgramResults');

describe('parseDeepgramResultsMessage', () => {
  it('maps interim Results to isFinal:false', () => {
    const parsed = parseDeepgramResultsMessage({
      type: 'Results',
      is_final: false,
      speech_final: false,
      channel: {
        alternatives: [{ transcript: 'yeah so my credit', confidence: 0.92 }],
      },
      duration: 1.2,
    });

    assert.deepEqual(parsed, [{
      transcript: 'yeah so my credit',
      isFinal: false,
      confidence: 0.92,
      resultEndTime: 1.2,
    }]);
  });

  it('maps is_final Results to isFinal:true even when speech_final is false', () => {
    const parsed = parseDeepgramResultsMessage({
      type: 'Results',
      is_final: true,
      speech_final: false,
      channel: {
        alternatives: [{ transcript: 'yeah so my credit card number is two two', confidence: 0.97 }],
      },
      duration: 3.26,
    });

    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].isFinal, true);
    assert.equal(parsed[0].transcript, 'yeah so my credit card number is two two');
  });

  it('uses confidence fallback when Deepgram omits one', () => {
    const parsed = parseDeepgramResultsMessage({
      type: 'Results',
      is_final: false,
      channel: {
        alternatives: [{ transcript: 'hello' }],
      },
    });

    assert.equal(parsed[0].confidence, 0.8);
  });

  it('ignores empty transcripts and non-Results messages', () => {
    assert.deepEqual(parseDeepgramResultsMessage(null), []);
    assert.deepEqual(parseDeepgramResultsMessage({ type: 'Metadata' }), []);
    assert.deepEqual(parseDeepgramResultsMessage({
      type: 'Results',
      is_final: true,
      channel: { alternatives: [{ transcript: '   ' }] },
    }), []);
    assert.deepEqual(parseDeepgramResultsMessage({
      type: 'Results',
      is_final: true,
      channel: { alternatives: [] },
    }), []);
  });

  it('treats successive finals as separate bubble candidates', () => {
    const first = parseDeepgramResultsMessage({
      type: 'Results',
      is_final: true,
      speech_final: false,
      channel: { alternatives: [{ transcript: 'First phrase.', confidence: 0.9 }] },
    });
    const second = parseDeepgramResultsMessage({
      type: 'Results',
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: 'Second phrase.', confidence: 0.95 }] },
    });

    assert.equal(first[0].isFinal, true);
    assert.equal(second[0].isFinal, true);
    assert.notEqual(first[0].transcript, second[0].transcript);
  });
});
