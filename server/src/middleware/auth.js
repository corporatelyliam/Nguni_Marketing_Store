// server/src/middleware/auth.js
// Sessions are Supabase access/refresh tokens in HttpOnly cookies set by routes/auth.js;
// browser JS never sees them. When the short-lived access token has expired but the
// refresh token is valid, the session is silently renewed.
const supabase = require('../db/supabase');
const { newAuthClient } = supabase;
const env = require('../config/env');

const ACCESS_COOKIE = 'ng_at';
const REFRESH_COOKIE = 'ng_rt';
const cookieOptions = { httpOnly: true, secure: env.isProd, sameSite: 'lax', path: '/' };

function setSessionCookies(res, session) {
  res.cookie(ACCESS_COOKIE, session.access_token, { ...cookieOptions, maxAge: Math.max(60, session.expires_in || 3600) * 1000 });
  res.cookie(REFRESH_COOKIE, session.refresh_token, { ...cookieOptions, maxAge: 30 * 24 * 3600 * 1000 });
}
function clearSessionCookies(res) {
  res.clearCookie(ACCESS_COOKIE, cookieOptions);
  res.clearCookie(REFRESH_COOKIE, cookieOptions);
}

// Returns { id, email, profile } or { error: 'UNAUTHENTICATED' | 'ACCOUNT_INACTIVE' }.
async function resolveSession(req, res) {
  let token = req.cookies?.[ACCESS_COOKIE];
  let authUser = null;
  if (token) {
    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data?.user) authUser = data.user;
  }
  if (!authUser && req.cookies?.[REFRESH_COOKIE]) {
    const { data, error } = await newAuthClient().auth.refreshSession({ refresh_token: req.cookies[REFRESH_COOKIE] });
    if (!error && data?.session && data.user) {
      authUser = data.user;
      setSessionCookies(res, data.session);
    } else {
      clearSessionCookies(res);
    }
  }
  if (!authUser) return { error: 'UNAUTHENTICATED' };

  const { data: profile } = await supabase.from('profiles').select('*').eq('id', authUser.id).maybeSingle();
  if (!profile || !profile.is_active) return { error: 'ACCOUNT_INACTIVE' };
  return { id: authUser.id, email: authUser.email, profile };
}

async function requireAuth(req, res, next) {
  try {
    const s = await resolveSession(req, res);
    if (s.error === 'ACCOUNT_INACTIVE') {
      return res.status(401).json({ error: { code: 'ACCOUNT_INACTIVE', message: 'This account is not active. Please contact us.' } });
    }
    if (s.error) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Please log in.' } });
    req.user = s;
    next();
  } catch (err) { next(err); }
}

module.exports = { requireAuth, resolveSession, setSessionCookies, clearSessionCookies, ACCESS_COOKIE, REFRESH_COOKIE };
