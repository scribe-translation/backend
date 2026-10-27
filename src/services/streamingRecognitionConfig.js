const LONG_MODEL_LANGUAGES = new Set([
  'en-US', 'en-GB', 'en-AU', 'en-IN',
  'fr-FR', 'fr-CA',
  'es-ES', 'es-US',
  'de-DE',
  'pt-BR', 'pt-PT',
  'it-IT',
  'ja-JP',
  'ko-KR',
  'ru-RU'
]);

const TELEPHONY_MODEL_LANGUAGES = new Set([
  'en-CA', 'en-IE', 'en-NZ', 'en-SG', 'en-HK', 'en-PK',
  'fr-BE', 'fr-CH',
  'es-MX', 'es-AR', 'es-CL', 'es-CO', 'es-PE',
  'de-AT', 'de-CH',
  'it-CH',
  'nl-BE'
]);

function languageFamilyHas(languages, languageCode) {
  const langPrefix = languageCode.split('-')[0];
  for (const lang of languages) {
    if (lang.startsWith(langPrefix + '-')) {
      return true;
    }
  }
  return false;
}

function selectStreamingModel(languageCode) {
  if (LONG_MODEL_LANGUAGES.has(languageCode)) {
    return 'long';
  }
  if (TELEPHONY_MODEL_LANGUAGES.has(languageCode)) {
    return 'telephony';
  }
  if (languageFamilyHas(LONG_MODEL_LANGUAGES, languageCode)) {
    return 'long';
  }
  if (languageFamilyHas(TELEPHONY_MODEL_LANGUAGES, languageCode)) {
    return 'telephony';
  }
  return 'long';
}

function buildStreamingConfigRequest({ projectId, languageCode, sampleRateHertz }) {
  return {
    recognizer: `projects/${projectId}/locations/global/recognizers/_`,
    streamingConfig: {
      config: {
        explicitDecodingConfig: {
          encoding: 'LINEAR16',
          sampleRateHertz,
          audioChannelCount: 1,
        },
        languageCodes: [languageCode],
        model: selectStreamingModel(languageCode),
        features: {
          enableAutomaticPunctuation: true,
          enableWordTimeOffsets: true,
        },
      },
      streamingFeatures: {
        interimResults: true,
      },
    },
  };
}

function buildAudioRequest(audio) {
  return { audio };
}

function parseStreamingResponse(response) {
  const parsed = [];
  let interimTranscript = '';
  let interimEndTime;

  const flushInterim = () => {
    if (!interimTranscript) {
      return;
    }
    parsed.push({
      transcript: interimTranscript,
      isFinal: false,
      confidence: 0.8,
      resultEndTime: interimEndTime,
    });
    interimTranscript = '';
    interimEndTime = undefined;
  };

  for (const result of response.results || []) {
    const alternative = result.alternatives?.[0];
    if (!alternative?.transcript) {
      continue;
    }

    if (result.isFinal) {
      flushInterim();
      parsed.push({
        transcript: alternative.transcript,
        isFinal: true,
        confidence: alternative.confidence || 0.8,
        resultEndTime: result.resultEndOffset,
      });
      continue;
    }

    interimTranscript += alternative.transcript;
    interimEndTime = result.resultEndOffset;
  }

  flushInterim();
  return parsed;
}

module.exports = {
  selectStreamingModel,
  buildStreamingConfigRequest,
  buildAudioRequest,
  parseStreamingResponse,
};
