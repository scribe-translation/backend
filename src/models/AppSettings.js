const { getDb, Collections, dateToTimestamp } = require('../database/firestore');

const DOC_ID = 'app';
const CACHE_TTL_MS = 30 * 1000;

let cache = {
  interimTranslationEnabled: false,
  expiresAt: 0,
};

class AppSettings {
  static DOC_ID = DOC_ID;

  /**
   * Ensure settings/app exists with interimTranslationEnabled: false.
   * Does not overwrite an existing document.
   */
  static async ensureDefaults() {
    try {
      const db = getDb();
      const docRef = db.collection(Collections.SETTINGS).doc(DOC_ID);
      const snapshot = await docRef.get();

      if (snapshot.exists) {
        console.log('✅ App settings document already present');
        return;
      }

      const now = dateToTimestamp(new Date());
      await docRef.set({
        interimTranslationEnabled: false,
        updatedAt: now,
      });
      console.log('✅ Created app settings with interimTranslationEnabled: false');
    } catch (error) {
      console.error('❌ Error ensuring app settings defaults:', error.message);
      throw error;
    }
  }

  /**
   * Read interimTranslationEnabled with a short in-memory cache.
   * Fail closed (false) on read errors so interim translation stays off under cost pressure.
   */
  static async isInterimTranslationEnabled() {
    const now = Date.now();
    if (now < cache.expiresAt) {
      return cache.interimTranslationEnabled;
    }

    try {
      const db = getDb();
      const snapshot = await db.collection(Collections.SETTINGS).doc(DOC_ID).get();
      const enabled = snapshot.exists
        ? snapshot.data()?.interimTranslationEnabled === true
        : false;

      cache = {
        interimTranslationEnabled: enabled,
        expiresAt: now + CACHE_TTL_MS,
      };
      return enabled;
    } catch (error) {
      console.error('❌ Error reading interimTranslationEnabled (defaulting to false):', error.message);
      cache = {
        interimTranslationEnabled: false,
        expiresAt: now + CACHE_TTL_MS,
      };
      return false;
    }
  }
}

module.exports = AppSettings;
