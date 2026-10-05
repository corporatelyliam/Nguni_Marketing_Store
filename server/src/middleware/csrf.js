// server/src/middleware/csrf.js
// Double-submit-cookie CSRF protection. The browser fetches a token from GET /api/auth/csrf
// and echoes it in X-CSRF-Token on every state-changing request (js/api.js does this).
// Mounted ONCE for all of /api (see app.js) so no mutating route can forget it.
const { doubleCsrf } = require('csrf-csrf');
const env = require('../config/env');

const { generateToken, doubleCsrfProtection } = doubleCsrf({
  getSecret: () => env.csrfSecret,
  cookieName: env.isProd ? '__Host-ng.csrf' : 'ng.csrf',
  cookieOptions: { httpOnly: true, secure: env.isProd, sameSite: 'lax', path: '/' },
  size: 64,
  getTokenFromRequest: (req) => req.headers['x-csrf-token'],
});

module.exports = { generateCsrfToken: (req, res) => generateToken(req, res), csrfProtection: doubleCsrfProtection };
