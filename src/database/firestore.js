const { Firestore } = require('@google-cloud/firestore');
const path = require('path');
const fs = require('fs');

let db = null;

/**
 * Initialize and return Firestore client
 * Uses Application Default Credentials in Cloud Run,
 * or google-credentials.json file for local development
 */
const initFirestore = async () => {
  if (db) {
    return db;
  }

  try {
    const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID || 'scribe-471123';
    const useEmulator = process.env.FIRESTORE_EMULATOR_HOST;
    
    if (useEmulator) {
      // Use Firestore Emulator for local development
      // Note: Emulator uses (default) database, not named 'default' database
      console.log(`🔧 Using Firestore Emulator at ${useEmulator}`);
      db = new Firestore({
        projectId: 'demo-scribe',  // Use demo project for emulator
      });
    } else {
      const isProduction = process.env.NODE_ENV === 'prod' || process.env.NODE_ENV === 'production';
      const localCredentialsPath = path.join(__dirname, '..', '..', 'google-credentials.json');
      
      // Use 'default' named database (not the special "(default)" database)
      const databaseId = 'default';
      
      if (isProduction) {
        // Production: always use Application Default Credentials (service account)
        console.log(`🔧 Using Application Default Credentials for Firestore (production, database: ${databaseId})`);
        db = new Firestore({
          projectId,
          databaseId,
        });
      } else if (fs.existsSync(localCredentialsPath)) {
        // Development: use local credentials file if available
        console.log(`🔧 Using local credentials file for Firestore (development, database: ${databaseId})`);
        db = new Firestore({
          projectId,
          keyFilename: localCredentialsPath,
          databaseId,
        });
      } else {
        // Fallback to ADC
        console.log(`🔧 Using Application Default Credentials for Firestore (database: ${databaseId})`);
        db = new Firestore({
          projectId,
          databaseId,
        });
      }
    }

    // Test connection by accessing a collection
    await db.collection('_health').limit(1).get();
    console.log('✅ Connected to Firestore');
    
    return db;
  } catch (error) {
    console.error('❌ Firestore initialization failed:', error.message);
    throw error;
  }
};

/**
 * Get the Firestore database instance
 * @returns {Firestore} The Firestore database instance
 */
const getDb = () => {
  if (!db) {
    throw new Error('Firestore not initialized. Call initFirestore() first.');
  }
  return db;
};

/**
 * Collection names as constants for consistency
 */
const Collections = {
  USERS: 'users',
  SESSIONS: 'sessions',
  PASSWORD_RESET_TOKENS: 'passwordResetTokens',
  SETTINGS: 'settings',
};

/**
 * Helper to convert Firestore Timestamp to Date
 * @param {FirebaseFirestore.Timestamp} timestamp 
 * @returns {Date|null}
 */
const timestampToDate = (timestamp) => {
  if (!timestamp) return null;
  if (timestamp.toDate) return timestamp.toDate();
  return timestamp;
};

/**
 * Helper to create Firestore Timestamp from Date
 * @param {Date} date 
 * @returns {FirebaseFirestore.Timestamp}
 */
const dateToTimestamp = (date) => {
  const { Timestamp } = require('@google-cloud/firestore');
  if (!date) return Timestamp.now();
  if (date instanceof Date) return Timestamp.fromDate(date);
  return Timestamp.fromDate(new Date(date));
};

module.exports = {
  initFirestore,
  getDb,
  Collections,
  timestampToDate,
  dateToTimestamp,
};

