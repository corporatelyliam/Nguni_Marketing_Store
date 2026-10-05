// server/src/middleware/errors.js
const env = require('../config/env');
const { describeError } = require('../lib/http');

function notFound(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found.' } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const send = (status, code, message, extra) => res.status(status).json({ error: { code, message, ...extra } });

  if (err && err.type === 'entity.parse.failed') return send(400, 'MALFORMED_JSON', 'The request body is not valid JSON.');
  if (err && err.type === 'entity.too.large') return send(413, 'PAYLOAD_TOO_LARGE', 'The request is too large.');
  if (err && err.name === 'ZodError') return send(400, 'VALIDATION_ERROR', 'Request data is invalid.', { details: err.flatten() });
  if (err && err.message === 'UNSUPPORTED_FILE_TYPE') return send(400, 'UNSUPPORTED_FILE_TYPE', 'That file type is not accepted.');
  if (err && err.code === 'LIMIT_FILE_SIZE') return send(400, 'FILE_TOO_LARGE', 'That file is too large.');
  if (err && (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT')) return send(400, 'INVALID_UPLOAD', 'Unexpected file upload.');
  if (err && err.code === 'EBADCSRFTOKEN') return send(403, 'CSRF_INVALID', 'Your session expired. Please refresh the page and try again.');

  const known = describeError(err);
  if (known) return send(known.status, known.code, known.message);

  // Unknown: log everything server-side, show nothing internal to the user.
  // eslint-disable-next-line no-console
  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  return send(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
}

module.exports = { notFound, errorHandler };
