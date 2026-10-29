const { getDb, Collections, dateToTimestamp } = require('../database/firestore');
const {
  interimTranslationFlagFromDoc,
  mergeFlagTargeting,
  resolveFlagForUser,
} = require('./flagTargeting');

const DOC_ID = 'app';
const CACHE_TTL_MS = 30 * 1000;

let cache = {
  flag: null,
  expiresAt: 0,
};

function invalidateCache() {
  cache = { flag: null, expiresAt: 0 };
}

function settingsFromDoc(data) {
  const flag = interimTranslationFlagFromDoc(data);
  return {
    interimTranslationEnabled: flag.defaultValue,
    interimTranslationEnabledUserIds: flag.enabledUserIds,
    interimTranslationDisabledUserIds: flag.disabledUserIds,
    updatedAt: data?.updatedAt?.toDate?.() ?? null,
  };
}

function targetingError(result) {
  const error = new Error(
    result.error || 'A user cannot be both on and off for the same flag'
  );
  error.code = result.conflictUserIds ? 'FLAG_TARGETING_CONFLICT' : 'INVALID_FLAG_TARGETING';
  error.conflictUserIds = result.conflictUserIds;
  return error;
}

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

  static async getAll() {
    try {
      const db = getDb();
      const snapshot = await db.collection(Collections.SETTINGS).doc(DOC_ID).get();
      const data = snapshot.exists ? snapshot.data() : {};
      return settingsFromDoc(data);
    } catch (error) {
      console.error('Error reading app settings:', error.message);
      throw error;
    }
  }

  static async update(partial) {
    try {
      const current = await AppSettings.getAll();
      const merged = mergeFlagTargeting(
        {
          defaultValue: current.interimTranslationEnabled,
          enabledUserIds: current.interimTranslationEnabledUserIds,
          disabledUserIds: current.interimTranslationDisabledUserIds,
        },
        {
          defaultValue: partial.interimTranslationEnabled,
          enabledUserIds: partial.interimTranslationEnabledUserIds,
          disabledUserIds: partial.interimTranslationDisabledUserIds,
        }
      );

      if (!merged.ok) {
        throw targetingError(merged);
      }

      const db = getDb();
      const docRef = db.collection(Collections.SETTINGS).doc(DOC_ID);
      await docRef.set({
        interimTranslationEnabled: merged.targeting.defaultValue,
        interimTranslationEnabledUserIds: merged.targeting.enabledUserIds,
        interimTranslationDisabledUserIds: merged.targeting.disabledUserIds,
        updatedAt: dateToTimestamp(new Date()),
      }, { merge: true });

      invalidateCache();

      return AppSettings.getAll();
    } catch (error) {
      console.error('Error updating app settings:', error.message);
      throw error;
    }
  }

  /**
   * Read the interim-translation flag with a short in-memory cache, then
   * resolve it for one speaker. Fail closed on read errors.
   */
  static async isInterimTranslationEnabled(userId) {
    const flag = await AppSettings.readInterimTranslationFlag();
    return resolveFlagForUser(flag, userId);
  }

  static async readInterimTranslationFlag() {
    const now = Date.now();
    if (cache.flag && now < cache.expiresAt) {
      return cache.flag;
    }

    try {
      const db = getDb();
      const snapshot = await db.collection(Collections.SETTINGS).doc(DOC_ID).get();
      const flag = interimTranslationFlagFromDoc(snapshot.exists ? snapshot.data() : {});
      cache = {
        flag,
        expiresAt: now + CACHE_TTL_MS,
      };
      return flag;
    } catch (error) {
      console.error('❌ Error reading interimTranslationEnabled (defaulting to false):', error.message);
      const flag = interimTranslationFlagFromDoc({});
      cache = {
        flag,
        expiresAt: now + CACHE_TTL_MS,
      };
      return flag;
    }
  }
}

module.exports = AppSettings;
