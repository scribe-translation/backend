const { Firestore } = require('@google-cloud/firestore');
const path = require('path');
const fs = require('fs');

let db = null;
let logger = null;

const getLogger = () => {
  if (!logger) {
    try {
      logger = require('../utils/logger').logger;
    } catch {
      logger = console;
    }
  }
  return logger;
};

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
    
    const log = getLogger();
    
    if (useEmulator) {
      log.info({
        emulatorHost: useEmulator,
        projectId: 'demo-scribe',
      }, 'Using Firestore Emulator for local development')
      db = new Firestore({
        projectId: 'demo-scribe',
      });
    } else {
      const isProduction = process.env.NODE_ENV === 'prod' || process.env.NODE_ENV === 'production';
      const localCredentialsPath = path.join(__dirname, '..', '..', 'google-credentials.json');
      const databaseId = 'default';
      
      if (isProduction) {
        log.info({
          projectId,
          databaseId,
          authMethod: 'ApplicationDefaultCredentials',
        }, 'Using Application Default Credentials for Firestore in production')
        db = new Firestore({
          projectId,
          databaseId,
        });
      } else if (fs.existsSync(localCredentialsPath)) {
        log.info({
          projectId,
          databaseId,
          authMethod: 'LocalCredentialsFile',
        }, 'Using local credentials file for Firestore in development')
        db = new Firestore({
          projectId,
          keyFilename: localCredentialsPath,
          databaseId,
        });
      } else {
        log.info({
          projectId,
          databaseId,
          authMethod: 'ApplicationDefaultCredentials',
        }, 'Using Application Default Credentials for Firestore')
        db = new Firestore({
          projectId,
          databaseId,
        });
      }
    }

    await db.collection('_health').limit(1).get();
    log.info('Firestore connection established successfully')
    
    return db;
  } catch (error) {
    const log = getLogger();
    log.error({
      error: error.message,
      stack: error.stack,
      projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
    }, 'Firestore initialization failed')
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
  CREDIT_LEDGER: 'creditLedger',
  DISCOUNT_APPLICATIONS: 'discountApplications',
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

