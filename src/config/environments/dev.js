module.exports = {
  NODE_ENV: 'dev',
  PORT: 3001,
  HOST: '0.0.0.0',
  
  // Database
  DB_TYPE: 'postgres',
  DB_HOST: process.env.DB_HOST || 'localhost',
  DB_PORT: process.env.DB_PORT || 5432,
  DB_NAME: process.env.DB_NAME || 'scribe-dev',
  DB_USER: process.env.DB_USER || 'johnascott',
  DB_PASSWORD: process.env.DB_PASSWORD || 'password',
  DB_SSL: process.env.DB_SSL || 'false',
  
  // JWT Configuration
  JWT_SECRET: 'dev-super-secret-jwt-key-change-this-in-production',
  JWT_ACCESS_EXPIRES_IN: '30d',
  JWT_REFRESH_EXPIRES_IN: '60d',
  
  // Google Cloud Speech-to-Text
  GOOGLE_CLOUD_PROJECT_ID: process.env.GOOGLE_CLOUD_PROJECT_ID || 'scribe-471123',
  
  // CORS — include plain localhost/IP dev routes alongside subdomain hosts
  CORS_ORIGIN: 'http://speaker.localhost:5173,http://listener.localhost:5173,http://localhost:5173,http://127.0.0.1:5173,http://api.localhost:3001',
  
  // Frontend URLs
  FRONTEND_URL: 'http://speaker.localhost:5173',
  FRONTEND_DOMAIN: 'localhost',
  TRANSLATION_URL: 'http://listener.localhost:5173',
  
  // Logging
  LOG_LEVEL: 'debug',

  SMTP_USER: 'johnascott14@gmail.com',
  SMTP_PASS: '3557321Joh--',
  FROM_EMAIL: 'reset-password@scribe-ai.ca'
}
