/**
 * Language code utilities for Google Cloud APIs
 * 
 * Frontend sends:
 * - Speech-to-Text: Full locale codes (en-US, fr-FR, etc.)
 * - Translation: Full locale codes (same as STT) or simple codes (be, mk)
 * 
 * Backend uses codes directly for Speech-to-Text.
 * For Translation, we extract base codes since Google Translation
 * prefers simple codes (en, fr) over locale codes (en-US, fr-FR).
 */

/**
 * Extract base language code for Google Translation API
 * Converts locale codes like 'en-US' to 'en'
 * Keeps already-simple codes like 'be' as-is
 * @param {string} languageCode - Language code (e.g., 'en-US' or 'en')
 * @returns {string} Base language code for Translation API
 */
function getBaseLanguageCode(languageCode) {
  if (!languageCode) {
    return languageCode;
  }
  
  // Special cases that should keep their format
  if (languageCode === 'zh-CN' || languageCode === 'zh-TW') {
    return languageCode; // Chinese needs to distinguish simplified vs traditional
  }
  
  if (languageCode.startsWith('yue-')) {
    return 'yue'; // Cantonese
  }
  
  // Extract base code (en-US -> en, fr-FR -> fr)
  const parts = languageCode.split('-');
  const base = parts[0];

  // `fil` is formal written Filipino. Tagalog `tl` is the contemporary code
  // Google Translate uses for this language. Match the whole code so Finnish `fi` stays Finnish.
  if (base === 'fil') {
    return 'tl';
  }

  return base;
}

/**
 * Check if two language codes represent the same language
 * Used to skip translation when source and target are the same
 * @param {string} code1 - First language code
 * @param {string} code2 - Second language code
 * @returns {boolean} True if same language
 */
function isSameLanguage(code1, code2) {
  const base1 = getBaseLanguageCode(code1);
  const base2 = getBaseLanguageCode(code2);
  return base1 === base2;
}

module.exports = {
  getBaseLanguageCode,
  isSameLanguage
};
