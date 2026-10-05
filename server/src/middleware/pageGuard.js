// server/src/middleware/pageGuard.js
// Server-side gate for HTML pages, so /admin/index.html or /staff/index.html cannot even be
// downloaded without the right role (the API enforces authorisation regardless; this removes
// the "flash of a dashboard you cannot use" and stops direct navigation).
const { resolveSession } = require('./auth');

const roleHome = (role) => (role === 'admin' ? '/admin/index.html' : role === 'client' ? '/account.html' : '/staff/index.html');
const isHtml = (p) => p === '/' || /\.html?$/.test(p) || !/\.[a-z0-9]+$/i.test(p);

// rule(profile) -> true when allowed. Unauthenticated users are sent to login and returned afterwards.
function guard(rule) {
  return async (req, res, next) => {
    if (!isHtml(req.path)) return next();
    try {
      const s = await resolveSession(req, res);
      if (s.error) {
        const back = encodeURIComponent(req.originalUrl);
        return res.redirect(`/login.html?next=${back}`);
      }
      if (!rule(s.profile)) return res.redirect(roleHome(s.profile.role));
      next();
    } catch (err) { next(err); }
  };
}

const adminOnly = guard((p) => p.role === 'admin');
const staffOnly = guard((p) => ['employee', 'support', 'admin'].includes(p.role));
const signedIn = guard(() => true);

module.exports = { adminOnly, staffOnly, signedIn, roleHome };
