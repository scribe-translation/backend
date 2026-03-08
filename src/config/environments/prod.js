module.exports = {
  NODE_ENV: 'prod',
  PORT: process.env.PORT || 3001,
  HOST: '0.0.0.0',
  
  // Database
  DB_TYPE: process.env.DB_TYPE || 'postgres',
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT || '5432',
  DB_NAME: process.env.DB_NAME,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD,
  DB_SSL: process.env.DB_SSL || 'true',
  
  // JWT Configuration
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_ACCESS_EXPIRES_IN: '30d',
  JWT_REFRESH_EXPIRES_IN: '60d',
  
  // CORS - Allow your frontend domains
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'https://speaker.scribe-ai.ca,https://listener.scribe-ai.ca,https://api.scribe-ai.ca',
  
  // Frontend URLs
  FRONTEND_URL: process.env.FRONTEND_URL || 'https://speaker.scribe-ai.ca',
  FRONTEND_DOMAIN: process.env.FRONTEND_DOMAIN || 'scribe-ai.ca',
  TRANSLATION_URL: process.env.TRANSLATION_URL || 'https://listener.scribe-ai.ca',
  
  // Google Cloud
  GOOGLE_CLOUD_PROJECT_ID: process.env.GOOGLE_CLOUD_PROJECT_ID || 'scribe-471123',
  
  // Logging
  LOG_LEVEL: 'warn'
}
