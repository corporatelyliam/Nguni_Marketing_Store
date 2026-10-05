// server/src/middleware/validate.js: Zod validation. Unknown/malformed input never reaches a service or SQL.
const fail = (res, message, err) => res.status(400).json({ error: { code: 'VALIDATION_ERROR', message, details: err.flatten() } });

const validateBody = (schema) => (req, res, next) => {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) return fail(res, 'Request data is invalid.', r.error);
  req.body = r.data; next();
};
const validateQuery = (schema) => (req, res, next) => {
  const r = schema.safeParse(req.query);
  if (!r.success) return fail(res, 'Query parameters are invalid.', r.error);
  req.validQuery = r.data; next();
};
const validateParams = (schema) => (req, res, next) => {
  const r = schema.safeParse(req.params);
  if (!r.success) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found.' } });
  next();
};

module.exports = { validateBody, validateQuery, validateParams };
