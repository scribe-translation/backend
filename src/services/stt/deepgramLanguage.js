const DEEPGRAM_LANGUAGE_CODES = new Set([
  'multi',
  'af', 'af-ZA',
  'ar', 'ar-AE', 'ar-SA', 'ar-QA', 'ar-KW', 'ar-SY', 'ar-LB', 'ar-PS', 'ar-JO',
  'ar-EG', 'ar-SD', 'ar-TD', 'ar-MA', 'ar-DZ', 'ar-TN', 'ar-IQ', 'ar-IR',
  'hy',
  'as', 'as-IN',
  'be',
  'bn',
  'bs',
  'bg',
  'ca',
  'zh', 'zh-CN', 'zh-Hans', 'zh-TW', 'zh-Hant', 'zh-HK',
  'hr',
  'cs', 'cs-CZ',
  'da', 'da-DK',
  'nl', 'nl-BE',
  'en', 'en-US', 'en-AU', 'en-GB', 'en-IN', 'en-NZ', 'en-CA',
  'et',
  'fi',
  'fr', 'fr-CA',
  'ka', 'ka-GE',
  'de', 'de-CH',
  'el',
  'gu', 'gu-IN',
  'he',
  'hi',
  'hu',
  'id',
  'it',
  'ja',
  'kn',
  'kk', 'kk-KZ',
  'ko', 'ko-KR',
  'lv',
  'lt',
  'mk',
  'ms',
  'mr',
  'mn',
  'ne',
  'no',
  'ps', 'ps-AF',
  'fa',
  'pl',
  'pt', 'pt-BR', 'pt-PT',
  'pa', 'pa-IN',
  'ro',
  'ru',
  'sr',
  'sk',
  'sl',
  'es', 'es-419',
  'sv', 'sv-SE',
  'tl',
  'ta',
  'te',
  'th', 'th-TH',
  'tr', 'tr-TR',
  'uk',
  'ur',
  'vi',
  'xh',
  'zu',
]);

const LOCALE_ALIASES = {
  'en-IE': 'en',
  'en-SG': 'en',
  'en-HK': 'en',
  'en-PK': 'en',
  'es-ES': 'es',
  'es-US': 'es-419',
  'es-MX': 'es-419',
  'es-AR': 'es-419',
  'es-CL': 'es-419',
  'es-CO': 'es-419',
  'es-PE': 'es-419',
  'de-DE': 'de',
  'de-AT': 'de',
  'fr-FR': 'fr',
  'fr-BE': 'fr',
  'fr-CH': 'fr',
  'it-IT': 'it',
  'it-CH': 'it',
  'nl-NL': 'nl',
  'ja-JP': 'ja',
  'ru-RU': 'ru',
  'uk-UA': 'uk',
  'yue-Hant-HK': 'zh-HK',
};

function mapLanguageCodeForDeepgram(languageCode) {
  if (!languageCode || typeof languageCode !== 'string') {
    return 'en';
  }

  const normalized = languageCode.trim();
  if (!normalized) {
    return 'en';
  }

  if (DEEPGRAM_LANGUAGE_CODES.has(normalized)) {
    return normalized;
  }

  if (LOCALE_ALIASES[normalized]) {
    return LOCALE_ALIASES[normalized];
  }

  const family = normalized.split('-')[0];
  if (DEEPGRAM_LANGUAGE_CODES.has(family)) {
    return family;
  }

  return 'en';
}

module.exports = {
  mapLanguageCodeForDeepgram,
  DEEPGRAM_LANGUAGE_CODES,
  LOCALE_ALIASES,
};
