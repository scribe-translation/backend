module.exports = {
  NODE_ENV: 'staging',
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
  JWT_SECRET: process.env.JWT_SECRET || 'staging-super-secret-jwt-key-change-this',
  JWT_ACCESS_EXPIRES_IN: '30d',
  JWT_REFRESH_EXPIRES_IN: '60d',
  
  // Google Cloud
  GOOGLE_CLOUD_PROJECT_ID: process.env.GOOGLE_CLOUD_PROJECT_ID || 'scribe-471123',

  // Streaming STT: deepgram (default) or google
  STT_PROVIDER: process.env.STT_PROVIDER || 'deepgram',
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY || '',
  
  // CORS
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'https://speaker-staging.yourdomain.com,https://listener-staging.yourdomain.com',
  
  // Logging
  LOG_LEVEL: 'info'
}
