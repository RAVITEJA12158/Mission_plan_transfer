require('dotenv').config();
const path = require('path');

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

const apiKey = required('API_KEY');
if (apiKey.length < 16) throw new Error('API_KEY must be at least 16 characters');

const logStorageDir = path.resolve(process.env.LOG_STORAGE_DIR || './storage/flight-logs');

module.exports = {
  port: parseInt(process.env.PORT || '5000', 10),
  databaseUrl: required('DATABASE_URL'),
  apiKey,
  logStorageDir,
  tmpDir: path.join(logStorageDir, '.tmp'),
  maxLogBytes: parseInt(process.env.MAX_LOG_MB || '512', 10) * 1024 * 1024,
  corsOrigins: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()) : null,
};
