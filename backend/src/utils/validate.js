const { HttpError } = require('../middleware/error.middleware');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;

const bad = (msg) => new HttpError(400, 'validation_error', msg);
const isMissing = (v) => v === undefined || v === null || v === '';

function intField(v, name, { min = -Infinity, max = Infinity, nullable = false } = {}) {
  if (isMissing(v)) { if (nullable) return null; throw bad(`${name} is required`); }
  const n = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

function bigintField(v, name, { min = 1n, max = 9223372036854775807n, nullable = false } = {}) {
  if (isMissing(v)) { if (nullable) return null; throw bad(`${name} is required`); }
  let n;
  try {
    if (typeof v === 'bigint') n = v;
    else if (typeof v === 'number' && Number.isSafeInteger(v)) n = BigInt(v);
    else if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) n = BigInt(v.trim());
    else throw new Error('invalid integer');
  } catch (_) {
    throw bad(`${name} must be an integer`);
  }
  if (n < min || n > max) throw bad(`${name} must be between ${min} and ${max}`);
  return n;
}

function numField(v, name, { min = -Infinity, max = Infinity, nullable = false } = {}) {
  if (isMissing(v)) { if (nullable) return null; throw bad(`${name} is required`); }
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
    throw bad(`${name} must be a finite number between ${min} and ${max}`);
  }
  return n;
}

function boolField(v, name, { nullable = true } = {}) {
  if (isMissing(v)) { if (nullable) return null; throw bad(`${name} is required`); }
  if (typeof v !== 'boolean') throw bad(`${name} must be a boolean`);
  return v;
}

function strField(v, name, { max = 255, nullable = false } = {}) {
  if (isMissing(v)) { if (nullable) return null; throw bad(`${name} is required`); }
  if (typeof v !== 'string' || v.length > max) throw bad(`${name} must be a string of at most ${max} characters`);
  return v;
}

function uuidField(v, name, { nullable = false } = {}) {
  if (isMissing(v)) { if (nullable) return null; throw bad(`${name} is required`); }
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw bad(`${name} must be a UUID`);
  return v.toLowerCase();
}

function sha256Field(v, name, { nullable = false } = {}) {
  if (isMissing(v)) { if (nullable) return null; throw bad(`${name} is required`); }
  if (typeof v !== 'string' || !SHA256_RE.test(v)) throw bad(`${name} must be a 64-character hex SHA-256`);
  return v.toLowerCase();
}

function objectField(v, name, { nullable = true } = {}) {
  if (isMissing(v)) { if (nullable) return null; throw bad(`${name} is required`); }
  if (typeof v !== 'object' || Array.isArray(v)) throw bad(`${name} must be an object`);
  return v;
}

function dateField(v, name, { nullable = false } = {}) {
  if (isMissing(v)) { if (nullable) return null; throw bad(`${name} is required`); }
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(v)) {
    throw bad(`${name} must be an ISO-8601 timestamp`);
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw bad(`${name} must be an ISO-8601 timestamp`);
  return d.toISOString();
}

module.exports = { bad, intField, bigintField, numField, boolField, strField, uuidField, sha256Field, objectField, dateField };
