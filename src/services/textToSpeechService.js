const fs = require('fs');
const textToSpeech = require('@google-cloud/text-to-speech');
const config = require('../config');

class TextToSpeechService {
  constructor() {
    this.projectId = config.GOOGLE_CLOUD_PROJECT_ID;
    this.client = null;
    this.credentials = null;
  }

  async initializeCredentials() {
    if (this.credentials) {
      return this.credentials;
    }

    try {
      const isProduction = process.env.NODE_ENV === 'prod' || process.env.NODE_ENV === 'production';
      
      if (isProduction) {
        // Production: always use service account (ADC)
        console.log('☁️ TTS: Using default service account (production)');
        this.credentials = null;
        return this.credentials;
      }
      
      // Development: try local credentials file
      if (fs.existsSync('./google-credentials.json')) {
        console.log('🔧 TTS: Loading credentials from local file (development)');
        this.credentials = JSON.parse(fs.readFileSync('./google-credentials.json', 'utf8'));
        return this.credentials;
      }

      console.log('☁️ TTS: Using default service account');
      this.credentials = null;
      return this.credentials;
    } catch (error) {
      console.error('❌ TTS: Failed to load credentials:', error);
      console.log('⚠️ TTS: Falling back to default service account');
      this.credentials = null;
      return this.credentials;
    }
  }

  async getTTSClient() {
    if (this.client) {
      return this.client;
    }

    const credentials = await this.initializeCredentials();
    
    if (credentials) {
      this.client = new textToSpeech.TextToSpeechClient({
        projectId: this.projectId,
        credentials: {
          client_email: credentials.client_email,
          private_key: credentials.private_key
        }
      });
    } else {
      this.client = new textToSpeech.TextToSpeechClient({
        projectId: this.projectId
      });
    }

    console.log('✅ TTS: Client initialized');
    return this.client;
  }

  /**
   * Map translation language codes to TTS language codes
   * TTS uses different codes than Translation API
   */
  getTTSLanguageCode(ctLanguageCode) {
    const mapping = {
      // Arabic variants all map to ar-XA
      'ar': 'ar-XA',
      'ar-SA': 'ar-XA',
      
      // Afrikaans
      'af': 'af-ZA',
      
      // Bengali
      'bn': 'bn-IN',
      'bn-IN': 'bn-IN',
      
      // Bulgarian
      'bg': 'bg-BG',
      
      // Catalan
      'ca': 'ca-ES',
      
      // Chinese
      'zh': 'cmn-CN',
      'zh-CN': 'cmn-CN',
      'zh-Hans': 'cmn-CN',
      'zh-TW': 'cmn-TW',
      'zh-Hant': 'cmn-TW',
      'zh-HK': 'yue-HK',
      
      // Czech
      'cs': 'cs-CZ',
      
      // Danish
      'da': 'da-DK',
      
      // Dutch
      'nl': 'nl-NL',
      'nl-BE': 'nl-BE',
      
      // English
      'en': 'en-US',
      'en-AU': 'en-AU',
      'en-CA': 'en-US',
      'en-GB': 'en-GB',
      'en-NZ': 'en-AU',
      'en-PH': 'en-US',
      'en-US': 'en-US',
      'en-ZA': 'en-GB',
      
      // Estonian
      'et': 'et-EE',
      
      // Filipino
      'fil': 'fil-PH',
      'tl': 'fil-PH',
      
      // Finnish
      'fi': 'fi-FI',
      
      // French
      'fr': 'fr-FR',
      'fr-CA': 'fr-CA',
      'fr-CH': 'fr-FR',
      
      // Galician
      'gl': 'gl-ES',
      
      // German
      'de': 'de-DE',
      
      // Greek
      'el': 'el-GR',
      
      // Gujarati
      'gu': 'gu-IN',
      
      // Hebrew
      'he': 'he-IL',
      'iw': 'he-IL',
      
      // Hindi
      'hi': 'hi-IN',
      
      // Hungarian
      'hu': 'hu-HU',
      
      // Icelandic
      'is': 'is-IS',
      
      // Indonesian
      'id': 'id-ID',
      
      // Italian
      'it': 'it-IT',
      
      // Japanese
      'ja': 'ja-JP',
      
      // Kannada
      'kn': 'kn-IN',
      
      // Korean
      'ko': 'ko-KR',
      
      // Latvian
      'lv': 'lv-LV',
      
      // Lithuanian
      'lt': 'lt-LT',
      
      // Malay
      'ms': 'ms-MY',
      
      // Malayalam
      'ml': 'ml-IN',
      
      // Marathi
      'mr': 'mr-IN',
      
      // Norwegian
      'nb': 'nb-NO',
      'no': 'nb-NO',
      
      // Polish
      'pl': 'pl-PL',
      
      // Portuguese
      'pt': 'pt-PT',
      'pt-BR': 'pt-BR',
      
      // Punjabi
      'pa': 'pa-IN',
      
      // Romanian
      'ro': 'ro-RO',
      
      // Russian
      'ru': 'ru-RU',
      
      // Serbian
      'sr': 'sr-RS',
      
      // Slovak
      'sk': 'sk-SK',
      
      // Spanish
      'es': 'es-ES',
      'es-US': 'es-US',
      
      // Swedish
      'sv': 'sv-SE',
      
      // Tamil
      'ta': 'ta-IN',
      
      // Telugu
      'te': 'te-IN',
      
      // Thai
      'th': 'th-TH',
      
      // Turkish
      'tr': 'tr-TR',
      
      // Ukrainian
      'uk': 'uk-UA',
      
      // Vietnamese
      'vi': 'vi-VN',
    };

    // Check direct mapping first
    if (mapping[ctLanguageCode]) {
      return mapping[ctLanguageCode];
    }

    // Try base code
    const baseCode = ctLanguageCode.split('-')[0];
    return mapping[baseCode] || null;
  }

  /**
   * Get deep, authoritative male voice for a language
   * Uses deeper voice variants and lower pitch for a more commanding tone
   */
  getVoiceConfig(languageCode) {
    // Deep male voices - using variants known to be deeper/more authoritative
    const deepMaleVoices = {
      'ar-XA': { name: 'ar-XA-Wavenet-C', ssmlGender: 'MALE' },
      'bn-IN': { name: 'bn-IN-Wavenet-B', ssmlGender: 'MALE' },
      'bg-BG': { name: 'bg-BG-Standard-A', ssmlGender: 'MALE' },
      'ca-ES': { name: 'ca-ES-Standard-A', ssmlGender: 'MALE' },
      'cmn-CN': { name: 'cmn-CN-Wavenet-C', ssmlGender: 'MALE' },
      'cmn-TW': { name: 'cmn-TW-Wavenet-C', ssmlGender: 'MALE' },
      'yue-HK': { name: 'yue-HK-Standard-B', ssmlGender: 'MALE' },
      'cs-CZ': { name: 'cs-CZ-Wavenet-A', ssmlGender: 'MALE' },
      'da-DK': { name: 'da-DK-Neural2-C', ssmlGender: 'MALE' },
      'nl-BE': { name: 'nl-BE-Wavenet-B', ssmlGender: 'MALE' },
      'nl-NL': { name: 'nl-NL-Wavenet-C', ssmlGender: 'MALE' },
      'en-AU': { name: 'en-AU-Neural2-D', ssmlGender: 'MALE' },
      'en-GB': { name: 'en-GB-Neural2-D', ssmlGender: 'MALE' },
      'en-US': { name: 'en-US-Neural2-J', ssmlGender: 'MALE' },
      'et-EE': { name: 'et-EE-Standard-A', ssmlGender: 'MALE' },
      'fil-PH': { name: 'fil-PH-Wavenet-D', ssmlGender: 'MALE' },
      'fi-FI': { name: 'fi-FI-Wavenet-A', ssmlGender: 'MALE' },
      'fr-CA': { name: 'fr-CA-Neural2-D', ssmlGender: 'MALE' },
      'fr-FR': { name: 'fr-FR-Neural2-D', ssmlGender: 'MALE' },
      'gl-ES': { name: 'gl-ES-Standard-A', ssmlGender: 'MALE' },
      'de-DE': { name: 'de-DE-Neural2-D', ssmlGender: 'MALE' },
      'el-GR': { name: 'el-GR-Wavenet-A', ssmlGender: 'MALE' },
      'gu-IN': { name: 'gu-IN-Wavenet-B', ssmlGender: 'MALE' },
      'he-IL': { name: 'he-IL-Wavenet-D', ssmlGender: 'MALE' },
      'hi-IN': { name: 'hi-IN-Neural2-D', ssmlGender: 'MALE' },
      'hu-HU': { name: 'hu-HU-Wavenet-A', ssmlGender: 'MALE' },
      'is-IS': { name: 'is-IS-Standard-A', ssmlGender: 'MALE' },
      'id-ID': { name: 'id-ID-Wavenet-C', ssmlGender: 'MALE' },
      'it-IT': { name: 'it-IT-Neural2-C', ssmlGender: 'MALE' },
      'ja-JP': { name: 'ja-JP-Neural2-D', ssmlGender: 'MALE' },
      'kn-IN': { name: 'kn-IN-Wavenet-B', ssmlGender: 'MALE' },
      'ko-KR': { name: 'ko-KR-Neural2-C', ssmlGender: 'MALE' },
      'lv-LV': { name: 'lv-LV-Standard-A', ssmlGender: 'MALE' },
      'lt-LT': { name: 'lt-LT-Standard-A', ssmlGender: 'MALE' },
      'ms-MY': { name: 'ms-MY-Wavenet-D', ssmlGender: 'MALE' },
      'ml-IN': { name: 'ml-IN-Wavenet-D', ssmlGender: 'MALE' },
      'mr-IN': { name: 'mr-IN-Wavenet-C', ssmlGender: 'MALE' },
      'nb-NO': { name: 'nb-NO-Wavenet-D', ssmlGender: 'MALE' },
      'pl-PL': { name: 'pl-PL-Wavenet-C', ssmlGender: 'MALE' },
      'pt-BR': { name: 'pt-BR-Neural2-B', ssmlGender: 'MALE' },
      'pt-PT': { name: 'pt-PT-Wavenet-D', ssmlGender: 'MALE' },
      'pa-IN': { name: 'pa-IN-Wavenet-D', ssmlGender: 'MALE' },
      'ro-RO': { name: 'ro-RO-Wavenet-A', ssmlGender: 'MALE' },
      'ru-RU': { name: 'ru-RU-Wavenet-D', ssmlGender: 'MALE' },
      'sr-RS': { name: 'sr-RS-Standard-A', ssmlGender: 'MALE' },
      'sk-SK': { name: 'sk-SK-Wavenet-A', ssmlGender: 'MALE' },
      'es-ES': { name: 'es-ES-Neural2-F', ssmlGender: 'MALE' },
      'es-US': { name: 'es-US-Neural2-C', ssmlGender: 'MALE' },
      'sv-SE': { name: 'sv-SE-Wavenet-C', ssmlGender: 'MALE' },
      'ta-IN': { name: 'ta-IN-Wavenet-D', ssmlGender: 'MALE' },
      'te-IN': { name: 'te-IN-Standard-B', ssmlGender: 'MALE' },
      'th-TH': { name: 'th-TH-Neural2-C', ssmlGender: 'MALE' },
      'tr-TR': { name: 'tr-TR-Wavenet-E', ssmlGender: 'MALE' },
      'uk-UA': { name: 'uk-UA-Wavenet-A', ssmlGender: 'MALE' },
      'vi-VN': { name: 'vi-VN-Neural2-D', ssmlGender: 'MALE' },
      'af-ZA': { name: 'af-ZA-Standard-A', ssmlGender: 'MALE' },
    };

    return deepMaleVoices[languageCode] || { name: null, ssmlGender: 'MALE' };
  }

  /**
   * Synthesize speech from text
   * @param {string} text - Text to convert to speech
   * @param {string} languageCode - Translation language code (e.g., 'fr', 'es-ES')
   * @returns {Promise<Buffer>} - MP3 audio buffer
   */
  async synthesizeSpeech(text, languageCode) {
    try {
      const client = await this.getTTSClient();
      
      const ttsLanguageCode = this.getTTSLanguageCode(languageCode);
      if (!ttsLanguageCode) {
        throw new Error(`Language ${languageCode} is not supported for text-to-speech`);
      }

      const voiceConfig = this.getVoiceConfig(ttsLanguageCode);
      
      console.log(`🔊 TTS: Synthesizing "${text.substring(0, 50)}..." in ${ttsLanguageCode} using ${voiceConfig.name || 'default voice'}`);

      const request = {
        input: { text },
        voice: {
          languageCode: ttsLanguageCode,
          ...(voiceConfig.name && { name: voiceConfig.name }),
          ssmlGender: voiceConfig.ssmlGender
        },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: 1,
          pitch: -3.0,  // Lower pitch for deeper, more authoritative tone
          volumeGainDb: 0
        }
      };

      const [response] = await client.synthesizeSpeech(request);
      
      console.log(`✅ TTS: Generated ${response.audioContent.length} bytes of audio`);
      
      return response.audioContent;
    } catch (error) {
      console.error('❌ TTS: Synthesis error:', error);
      throw error;
    }
  }

  /**
   * Check if a language is supported for TTS
   * @param {string} languageCode - Translation language code
   * @returns {boolean}
   */
  isLanguageSupported(languageCode) {
    return this.getTTSLanguageCode(languageCode) !== null;
  }
}

module.exports = new TextToSpeechService();

