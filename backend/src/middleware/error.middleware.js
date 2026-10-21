class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function notFound(req, res) {
  res.status(404).json({ error: 'not_found', message: `${req.method} ${req.originalUrl} not found` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
  }
  // Client vanished mid-upload (e.g. Jetson lost power/Wi-Fi). Multer already removed the partial file.
  if (err && (err.message === 'Request aborted' || err.code === 'ECONNRESET' || req.aborted)) {
    console.warn(`Upload aborted by client: ${req.method} ${req.originalUrl}`);
    return undefined;
  }
  if (err && err.name === 'MulterError') {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: 'upload_error', message: err.message });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large', message: 'Request body too large' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
  }
  // Prisma known errors
  if (err && typeof err.code === 'string' && /^P\d{4}$/.test(err.code)) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'conflict', message: 'Record already exists' });
    if (err.code === 'P2025') return res.status(404).json({ error: 'not_found', message: 'Record not found' });
    if (err.code === 'P2003') return res.status(409).json({ error: 'conflict', message: 'Referenced record does not exist' });
    if (['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(err.code)) {
      return res.status(503).json({ error: 'database_unavailable', message: 'Database temporarily unavailable' });
    }
  }
  // PostgreSQL: invalid text representation / datetime format / numeric out of range
  if (err && ['22P02', '22007', '22008', '22003'].includes(err.code)) {
    return res.status(400).json({ error: 'invalid_input', message: 'A value had an invalid format' });
  }
  console.error('Unhandled error:', err);
  return res.status(500).json({ error: 'internal_error', message: 'Internal server error' });
}

module.exports = { HttpError, asyncHandler, notFound, errorHandler };
