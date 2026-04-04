// Load environment variables first
require('dotenv').config();

// Normalize environment: 'production' -> 'prod'
let environment = process.env.NODE_ENV || 'dev';
if (environment === 'production') {
  environment = 'prod';
}

let config;
try {
  config = require(`./environments/${environment}`);
} catch (error) {
  console.warn(`No configuration found for environment: ${environment}, falling back to dev`);
  config = require('./environments/dev');
}

const finalConfig = {
  ...config,
  NODE_ENV: process.env.NODE_ENV || config.NODE_ENV,
  PORT: process.env.PORT || config.PORT,
  HOST: process.env.HOST || config.HOST,
  DB_TYPE: process.env.DB_TYPE || config.DB_TYPE,
  DB_PATH: process.env.DB_PATH || config.DB_PATH,
  DB_HOST: process.env.DB_HOST || config.DB_HOST,
  DB_PORT: process.env.DB_PORT || config.DB_PORT,
  DB_NAME: process.env.DB_NAME || config.DB_NAME,
  DB_USER: process.env.DB_USER || config.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD || config.DB_PASSWORD,
  DB_SSL: process.env.DB_SSL || config.DB_SSL,
  JWT_SECRET: process.env.JWT_SECRET || config.JWT_SECRET,
  JWT_ACCESS_EXPIRES_IN: process.env.JWT_ACCESS_EXPIRES_IN || config.JWT_ACCESS_EXPIRES_IN,
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || config.JWT_REFRESH_EXPIRES_IN,
  GOOGLE_CLOUD_PROJECT_ID: process.env.GOOGLE_CLOUD_PROJECT_ID || config.GOOGLE_CLOUD_PROJECT_ID,
  GOOGLE_CLOUD_API_KEY: process.env.GOOGLE_CLOUD_API_KEY || config.GOOGLE_CLOUD_API_KEY,
  CORS_ORIGIN: process.env.CORS_ORIGIN || config.CORS_ORIGIN,
  FRONTEND_URL: process.env.FRONTEND_URL || config.FRONTEND_URL,
  TRANSLATION_URL: process.env.TRANSLATION_URL || config.TRANSLATION_URL,
  LOG_LEVEL: process.env.LOG_LEVEL || config.LOG_LEVEL,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || config.GEMINI_API_KEY,
};

if (environment === 'prod') {
  const requiredVars = ['JWT_SECRET', 'CORS_ORIGIN', 'GOOGLE_CLOUD_PROJECT_ID'];
  const missingVars = requiredVars.filter(varName => !finalConfig[varName]);

  if (missingVars.length > 0) {
    console.error(`Missing required environment variables for production: ${missingVars.join(', ')}`);
    process.exit(1);
  }
}

module.exports = finalConfig;
