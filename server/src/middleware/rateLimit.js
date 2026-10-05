// server/src/middleware/rateLimit.js
const rateLimit = require('express-rate-limit');

// Automated tests skip limiting (they create many accounts from one IP); a dedicated test turns it back on.
const skipInTests = () => process.env.NODE_ENV === 'test' && !process.env.ENFORCE_RATE_LIMITS;

const make = (windowMs, limit, message, extra = {}) => rateLimit({
  windowMs, limit, standardHeaders: true, legacyHeaders: false, skip: skipInTests,
  message: { error: { code: 'RATE_LIMITED', message } }, ...extra,
});

// Login: per IP + email so one attacker cannot lock everyone out; successful logins do not count.
const loginLimiter = make(15 * 60 * 1000, 8, 'Too many login attempts. Please try again in a few minutes.', {
  keyGenerator: (req) => `${req.ip}|${String(req.body?.email || '').toLowerCase().slice(0, 120)}`,
  skipSuccessfulRequests: true,
});
const authLimiter = make(15 * 60 * 1000, 10, 'Too many attempts. Please try again later.');
const uploadLimiter = make(60 * 60 * 1000, 20, 'Too many uploads. Please try again later.');
const contactLimiter = make(60 * 60 * 1000, 5, 'Too many messages sent. Please try again later.');
const apiLimiter = make(60 * 1000, 300, 'Too many requests. Please slow down.');

module.exports = { loginLimiter, authLimiter, uploadLimiter, contactLimiter, apiLimiter };
