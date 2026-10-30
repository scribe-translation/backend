const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createSttProvider } = require('./createProvider');

describe('createSttProvider', () => {
  it('selects Deepgram by default name', () => {
    const provider = createSttProvider('deepgram');
    assert.equal(provider.getProviderName(), 'deepgram');
    assert.equal(provider.supportsStreamRotation(), false);
    assert.equal(provider.isRotationArmed('socket-1'), false);
  });

  it('selects Google when requested', () => {
    const provider = createSttProvider('google');
    assert.equal(provider.getProviderName(), 'google');
    assert.equal(provider.supportsStreamRotation(), true);
  });

  it('rejects unknown providers', () => {
    assert.throws(() => createSttProvider('whisper'), /Invalid STT provider/);
  });
});
