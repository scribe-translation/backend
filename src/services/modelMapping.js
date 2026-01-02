// Model mapping based on official Google Cloud Speech-to-Text documentation
// Reference: https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages
// Last updated: 2025-12-30

// Using V2 API with @google-cloud/speech v6.0.0
// Model priority: chirp_3 > chirp_2 > telephony > long > short > default
// Note: chirp_3 and chirp_2 are V2-only models and require V2 API
// telephony is optimized for conversational/phone call audio
// long/short are for long-form and short-form content respectively

// V2 API models: chirp_3, chirp_2, chirp, long, short, telephony, latest_long, latest_short
// Note: "default" does NOT exist in V2 API - use "long" or "short" as final fallback
const MODEL_MAPPING = {
  // Spanish variants - Only officially supported variants from Google Cloud documentation
  // Based on official docs: https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages
  // Using V2 API - chirp_3 and chirp_2 are available
  'es-419': { models: ['chirp_2', 'short'], useEnhanced: false }, // Latin America - general Latin American Spanish
  'es-CO': { models: ['chirp_2', 'telephony', 'short'], useEnhanced: false }, // Colombia - has telephony
  'es-ES': { models: ['chirp_2', 'long', 'short'], useEnhanced: false }, // Spain - has long model
  'es-MX': { models: ['chirp_2', 'telephony', 'short'], useEnhanced: false }, // Mexico - has telephony
  'es-US': { models: ['chirp_2', 'long', 'short', 'telephony'], useEnhanced: false }, // US - has multiple models

  // French variants
  'fr-BE': { models: ['chirp_2', 'telephony'], useEnhanced: false }, // Belgium
  'fr-CA': { models: ['chirp_2', 'telephony'], useEnhanced: false }, // Canada
  'fr-FR': { models: ['chirp_2', 'telephony'], useEnhanced: false }, // France - has long and short
  'fr-CH': { models: ['chirp_2', 'telephony'], useEnhanced: false }, // Switzerland

  // English variants
  'en-US': { models: ['chirp_2', 'long', 'short', 'telephony'], useEnhanced: true }, // US - has all models
  'en-GB': { models: ['chirp_2', 'long', 'short'], useEnhanced: true }, // UK - has long and short
  'en-AU': { models: ['chirp_2', 'long', 'short'], useEnhanced: true }, // Australia - has long and short
  'en-CA': { models: ['chirp_2', 'short'], useEnhanced: false }, // Canada
  'en-IN': { models: ['chirp_2', 'long', 'short'], useEnhanced: true }, // India - has long and short
  'en-IE': { models: ['chirp_2', 'short'], useEnhanced: false }, // Ireland
  'en-NZ': { models: ['chirp_2', 'short'], useEnhanced: false }, // New Zealand
  'en-ZA': { models: ['chirp_2', 'short'], useEnhanced: false }, // South Africa
  'en-GH': { models: ['chirp_2', 'short'], useEnhanced: false }, // Ghana
  'en-HK': { models: ['chirp_2', 'short'], useEnhanced: false }, // Hong Kong
  'en-KE': { models: ['chirp_2', 'short'], useEnhanced: false }, // Kenya
  'en-NG': { models: ['chirp_2', 'short'], useEnhanced: false }, // Nigeria
  'en-PK': { models: ['chirp_2', 'short'], useEnhanced: false }, // Pakistan
  'en-PH': { models: ['chirp_2', 'short'], useEnhanced: false }, // Philippines
  'en-SG': { models: ['chirp_2', 'short'], useEnhanced: false }, // Singapore
  'en-TZ': { models: ['chirp_2', 'short'], useEnhanced: false }, // Tanzania

  // Portuguese
  'pt-BR': { models: ['chirp_2', 'long', 'short', 'telephony'], useEnhanced: false }, // Brazil - has multiple models
  'pt-PT': { models: ['chirp_2', 'short'], useEnhanced: false }, // Portugal

  // Other major languages with chirp support
  'de-DE': { models: ['chirp_2', 'long', 'short'], useEnhanced: false }, // German
  'de-AT': { models: ['chirp_2', 'short'], useEnhanced: false }, // German (Austria)
  'de-CH': { models: ['chirp_2', 'short'], useEnhanced: false }, // German (Switzerland)
  'it-IT': { models: ['chirp_2', 'long', 'short'], useEnhanced: false }, // Italian
  'it-CH': { models: ['chirp_2', 'short'], useEnhanced: false }, // Italian (Switzerland)
  'ja-JP': { models: ['chirp_2', 'long', 'short'], useEnhanced: false }, // Japanese
  'ko-KR': { models: ['chirp_2', 'long', 'short'], useEnhanced: false }, // Korean
  'zh-CN': { models: ['chirp_2', 'short'], useEnhanced: false }, // Chinese (Simplified)
  'zh-TW': { models: ['chirp_2', 'short'], useEnhanced: false }, // Chinese (Traditional)
  'hi-IN': { models: ['chirp_2', 'long', 'short'], useEnhanced: false }, // Hindi
  'ru-RU': { models: ['chirp_2', 'short'], useEnhanced: false }, // Russian
  'ar-SA': { models: ['chirp_2', 'short'], useEnhanced: false }, // Arabic (Saudi Arabia)
  'ar-EG': { models: ['chirp_2', 'short'], useEnhanced: false }, // Arabic (Egypt)
  'nl-NL': { models: ['chirp_2', 'short'], useEnhanced: false }, // Dutch
  'nl-BE': { models: ['chirp_2', 'short'], useEnhanced: false }, // Dutch (Belgium)
  'pl-PL': { models: ['chirp_2', 'short'], useEnhanced: false }, // Polish
  'tr-TR': { models: ['chirp_2', 'short'], useEnhanced: false }, // Turkish
};

module.exports = { MODEL_MAPPING };

