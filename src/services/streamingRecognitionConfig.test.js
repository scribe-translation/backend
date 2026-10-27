const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const speech = require('@google-cloud/speech');
const {
  selectStreamingModel,
  buildStreamingConfigRequest,
  buildAudioRequest,
  parseStreamingResponse,
} = require('./streamingRecognitionConfig');

describe('installed Speech client', () => {
  it('can send the short endpointing preset', () => {
    const sensitivity = speech.protos.google.cloud.speech.v2.StreamingRecognitionFeatures.EndpointingSensitivity;
    assert.equal(sensitivity.ENDPOINTING_SENSITIVITY_SHORT, 3);
  });
});

describe('selectStreamingModel', () => {
  it('uses the long model, which streams partial text, for supported languages', () => {
    assert.equal(selectStreamingModel('en-US'), 'long');
    assert.equal(selectStreamingModel('fr-CA'), 'long');
  });

  it('uses telephony for Canadian English', () => {
    assert.equal(selectStreamingModel('en-CA'), 'telephony');
  });
});

describe('buildStreamingConfigRequest', () => {
  it('requests interim results from a model that streams partial text', () => {
    const request = buildStreamingConfigRequest({
      projectId: 'scribe-471123',
      languageCode: 'en-US',
      sampleRateHertz: 48000,
    });

    const Request = speech.protos.google.cloud.speech.v2.StreamingRecognizeRequest;
    const decoded = Request.toObject(
      Request.decode(Request.encode(Request.fromObject(request)).finish()),
      { enums: String }
    );
    assert.equal(decoded.streamingConfig.streamingFeatures.interimResults, true);
    assert.equal(decoded.streamingConfig.config.explicitDecodingConfig.encoding, 'LINEAR16');
    assert.equal(decoded.streamingConfig.config.model, 'long');

    assert.deepEqual(request, {
      recognizer: 'projects/scribe-471123/locations/global/recognizers/_',
      streamingConfig: {
        config: {
          explicitDecodingConfig: {
            encoding: 'LINEAR16',
            sampleRateHertz: 48000,
            audioChannelCount: 1,
          },
          languageCodes: ['en-US'],
          model: 'long',
          features: {
            enableAutomaticPunctuation: true,
            enableWordTimeOffsets: true,
          },
        },
        streamingFeatures: {
          interimResults: true,
        },
      },
    });
  });

  it('keeps Canadian English on the telephony model that streams partial text', () => {
    const request = buildStreamingConfigRequest({
      projectId: 'scribe-471123',
      languageCode: 'en-CA',
      sampleRateHertz: 48000,
    });

    assert.equal(request.streamingConfig.config.languageCodes[0], 'en-CA');
    assert.equal(request.streamingConfig.config.model, 'telephony');
    assert.equal(request.streamingConfig.streamingFeatures.interimResults, true);
  });
});

describe('buildAudioRequest', () => {
  it('sends audio as a v2 streaming message', () => {
    const audio = Buffer.from([1, 2, 3]);
    assert.deepEqual(buildAudioRequest(audio), { audio });
  });
});

describe('parseStreamingResponse', () => {
  it('reads the first alternative from a v2 result', () => {
    const parsed = parseStreamingResponse({
      results: [{
        isFinal: true,
        alternatives: [{ transcript: 'Hello there.', confidence: 0.91 }],
        resultEndOffset: { seconds: 1 },
      }],
    });

    assert.deepEqual(parsed, [{
      transcript: 'Hello there.',
      isFinal: true,
      confidence: 0.91,
      resultEndTime: { seconds: 1 },
    }]);
  });

  it('uses the existing confidence fallback when Google omits one', () => {
    const parsed = parseStreamingResponse({
      results: [{
        isFinal: false,
        alternatives: [{ transcript: 'Hello' }],
      }],
    });

    assert.equal(parsed[0].confidence, 0.8);
    assert.equal(parsed[0].isFinal, false);
  });

  it('joins the stable and unstable parts of one interim response', () => {
    const parsed = parseStreamingResponse({
      results: [
        { isFinal: false, alternatives: [{ transcript: 'to be' }] },
        { isFinal: false, alternatives: [{ transcript: ' or not to be' }] },
      ],
    });

    assert.deepEqual(parsed, [{
      transcript: 'to be or not to be',
      isFinal: false,
      confidence: 0.8,
      resultEndTime: undefined,
    }]);
  });

  it('commits a finalized sentence and keeps the next sentence separate', () => {
    const parsed = parseStreamingResponse({
      results: [
        { isFinal: true, alternatives: [{ transcript: 'First sentence.', confidence: 0.95 }] },
        { isFinal: false, alternatives: [{ transcript: ' Second' }] },
      ],
    });

    assert.deepEqual(parsed, [
      {
        transcript: 'First sentence.',
        isFinal: true,
        confidence: 0.95,
        resultEndTime: undefined,
      },
      {
        transcript: ' Second',
        isFinal: false,
        confidence: 0.8,
        resultEndTime: undefined,
      },
    ]);
  });

  it('ignores responses that have no transcript', () => {
    assert.deepEqual(parseStreamingResponse({}), []);
    assert.deepEqual(parseStreamingResponse({ results: [] }), []);
    assert.deepEqual(parseStreamingResponse({ results: [{ alternatives: [] }] }), []);
  });
});
