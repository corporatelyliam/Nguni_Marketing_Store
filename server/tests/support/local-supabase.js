// server/tests/support/local-supabase.js
// A local stand-in for a Supabase project, for automated tests ONLY:
//   * /rest/v1     -> a REAL PostgREST process in front of the REAL migrated Postgres database
//   * /auth/v1     -> a small emulation of the GoTrue endpoints this app uses (sign-in, refresh, admin
//                     create/update/delete/list, recovery links). It is NOT the real GoTrue.
//   * /storage/v1  -> an in-memory emulation of the Storage endpoints this app uses.
// So database behaviour, PostgREST/RLS behaviour and the Express app are genuinely exercised, while
// auth and storage are emulated. Real-Supabase behaviour for those two still needs a staging check.
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const express = require('express');
const { Client } = require('pg');
const { urlFor } = require('./pg');

const JWT_SECRET = 'test-jwt-secret-test-jwt-secret-1234567890';
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const sign = (payload) => {
  const h = b64({ alg: 'HS256', typ: 'JWT' }); const p = b64(payload);
  return `${h}.${p}.${crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`;
};
function verify(token) {
  const [h, p, s] = String(token || '').split('.');
  if (!h || !p || !s) return null;
  const good = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  if (good.length !== s.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(s))) return null;
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  return payload.exp && payload.exp < Date.now() / 1000 ? null : payload;
}
const hashPw = (pw, salt = crypto.randomBytes(8).toString('hex')) => `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
const checkPw = (pw, stored) => { const [salt] = String(stored).split(':'); return hashPw(pw, salt) === stored; };
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function start({ dbName, accessTtl = 3600 }) {
  const dbUrl = urlFor(dbName);
  const db = new Client({ connectionString: dbUrl }); await db.connect();
  const refreshTokens = new Map(); const recoveryTokens = new Map(); const passwords = new Map();
  const objects = new Map(); const signed = new Map(); const buckets = new Map([['private-files', false], ['product-images', true]]);
  const stats = { signIns: 0, refreshes: 0 };

  // ---- real PostgREST ----
  const pgrstPort = await freePort();
  const proc = spawn(process.env.PGRST_BIN || 'postgrest', [], {
    env: { ...process.env, PGRST_DB_URI: dbUrl.replace(/\/\/[^@]+@/, '//authenticator:authpw@'), PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon',
      PGRST_JWT_SECRET: JWT_SECRET, PGRST_SERVER_PORT: String(pgrstPort), PGRST_SERVER_HOST: '127.0.0.1', PGRST_LOG_LEVEL: 'error' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${pgrstPort}/`); if (r.ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
    if (i === 79) throw new Error('PostgREST did not start (is the `postgrest` binary on PATH or PGRST_BIN set?)');
  }

  // ---- gateway ----
  const app = express();
  app.use('/rest/v1', (req, res) => {
    const p = http.request({ host: '127.0.0.1', port: pgrstPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${pgrstPort}` } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => res.status(502).end()); req.pipe(p);
  });

  const auth = express.Router(); auth.use(express.json());
  const userJson = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.created_at, created_at: u.created_at, app_metadata: {}, user_metadata: {} });
  const getUser = async (id) => (await db.query('select id, email, created_at from auth.users where id=$1', [id])).rows[0];
  const session = (u) => {
    const refresh = crypto.randomBytes(24).toString('hex'); refreshTokens.set(refresh, u.id);
    const now = Math.floor(Date.now() / 1000);
    return { access_token: sign({ sub: u.id, role: 'authenticated', aud: 'authenticated', email: u.email, exp: now + accessTtl }), token_type: 'bearer', expires_in: accessTtl, refresh_token: refresh, user: userJson(u) };
  };
  const err = (res, status, msg, code) => res.status(status).json({ code: status, error_code: code, msg });
  auth.post('/admin/users', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 6) return err(res, 422, 'Password should be at least 6 characters.', 'weak_password');
    const dup = await db.query('select 1 from auth.users where lower(email)=lower($1)', [email]);
    if (dup.rowCount) return err(res, 422, 'A user with this email address has already been registered', 'email_exists');
    const { rows } = await db.query('insert into auth.users(email) values ($1) returning id,email,created_at', [email]);
    passwords.set(rows[0].id, hashPw(password)); res.json(userJson(rows[0]));
  });
  auth.get('/admin/users', async (req, res) => {
    const per = Number(req.query.per_page || 50); const page = Number(req.query.page || 1);
    const { rows } = await db.query('select id,email,created_at from auth.users order by created_at limit $1 offset $2', [per, (page - 1) * per]);
    res.set('x-total-count', String(rows.length)).json({ users: rows.map(userJson), aud: 'authenticated' });
  });
  auth.get('/admin/users/:id', async (req, res) => { const u = await getUser(req.params.id).catch(() => null); return u ? res.json(userJson(u)) : err(res, 404, 'User not found', 'user_not_found'); });
  auth.put('/admin/users/:id', async (req, res) => {
    const u = await getUser(req.params.id).catch(() => null); if (!u) return err(res, 404, 'User not found', 'user_not_found');
    if (req.body.password) { if (req.body.password.length < 6) return err(res, 422, 'Password should be at least 6 characters.', 'weak_password'); passwords.set(u.id, hashPw(req.body.password)); }
    res.json(userJson(u));
  });
  auth.delete('/admin/users/:id', async (req, res) => {
    try { await db.query('delete from auth.users where id=$1', [req.params.id]); passwords.delete(req.params.id); res.json({}); } catch (e) { err(res, 500, e.message); }
  });
  auth.get('/user', async (req, res) => {
    const claims = verify((req.headers.authorization || '').replace(/^Bearer /, ''));
    const u = claims && (await getUser(claims.sub)); return u ? res.json(userJson(u)) : err(res, 401, 'invalid JWT', 'bad_jwt');
  });
  auth.post('/token', async (req, res) => {
    if (req.query.grant_type === 'password') {
      stats.signIns += 1;
      const { rows } = await db.query('select id,email,created_at from auth.users where lower(email)=lower($1)', [req.body.email || '']);
      if (!rows[0] || !passwords.has(rows[0].id) || !checkPw(req.body.password || '', passwords.get(rows[0].id))) return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid login credentials' });
      return res.json(session(rows[0]));
    }
    if (req.query.grant_type === 'refresh_token') {
      stats.refreshes += 1;
      const id = refreshTokens.get(req.body.refresh_token); const u = id && (await getUser(id));
      if (!u) return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid Refresh Token: Refresh Token Not Found' });
      refreshTokens.delete(req.body.refresh_token); return res.json(session(u));
    }
    res.status(400).json({ error: 'unsupported_grant_type' });
  });
  auth.post('/admin/generate_link', async (req, res) => {
    const { rows } = await db.query('select id,email,created_at from auth.users where lower(email)=lower($1)', [req.body.email || '']);
    if (!rows[0]) return err(res, 404, 'User not found', 'user_not_found');
    const token = crypto.randomBytes(24).toString('hex'); recoveryTokens.set(token, { id: rows[0].id, exp: Date.now() + 3600e3 });
    res.json({ ...userJson(rows[0]), action_link: `http://stub/verify?token=${token}&type=recovery`, email_otp: '123456', hashed_token: token, redirect_to: '', verification_type: 'recovery' });
  });
  auth.post('/verify', async (req, res) => {
    const r = recoveryTokens.get(req.body.token_hash);
    if (!r || r.exp < Date.now() || req.body.type !== 'recovery') return err(res, 403, 'Email link is invalid or has expired', 'otp_expired');
    recoveryTokens.delete(req.body.token_hash); res.json(session(await getUser(r.id)));
  });
  app.use('/auth/v1', auth);

  const st = express.Router();
  const key = (req) => `${req.params.bucket}/${decodeURIComponent(req.params[0])}`;
  st.get('/bucket', (req, res) => res.json([...buckets].map(([name, pub]) => ({ id: name, name, public: pub }))));
  st.post('/bucket', express.json(), (req, res) => { buckets.set(req.body.name, !!req.body.public); res.json({ name: req.body.name }); });
  st.post('/object/sign/:bucket/*', express.json(), (req, res) => {
    if (!objects.has(key(req))) return res.status(404).json({ error: 'not_found', message: 'Object not found' });
    const token = crypto.randomBytes(16).toString('hex'); signed.set(token, key(req));
    res.json({ signedURL: `/object/sign/${req.params.bucket}/${req.params[0]}?token=${token}` });
  });
  st.get('/object/sign/:bucket/*', (req, res) => { const o = signed.get(req.query.token) === key(req) && objects.get(key(req)); return o ? res.type(o.type).send(o.data) : res.status(400).json({ error: 'invalid token' }); });
  st.get('/object/public/:bucket/*', (req, res) => { const o = buckets.get(req.params.bucket) && objects.get(key(req)); return o ? res.type(o.type).send(o.data) : res.status(404).json({ error: 'not_found' }); });
  st.delete('/object/:bucket', express.json(), (req, res) => { (req.body.prefixes || []).forEach((p) => objects.delete(`${req.params.bucket}/${p}`)); res.json([]); });
  st.post('/object/:bucket/*', express.raw({ type: () => true, limit: '20mb' }), (req, res) => {
    const k = key(req); if (objects.has(k) && req.headers['x-upsert'] !== 'true') return res.status(400).json({ error: 'Duplicate', message: 'The resource already exists', statusCode: '409' });
    objects.set(k, { data: req.body, type: req.headers['content-type'] || 'application/octet-stream' }); res.json({ Key: k, Id: crypto.randomUUID() });
  });
  app.use('/storage/v1', st);

  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const now = Math.floor(Date.now() / 1000);
  return {
    url, dbUrl, serviceKey: sign({ role: 'service_role', iss: 'test', exp: now + 86400 }), anonKey: sign({ role: 'anon', iss: 'test', exp: now + 86400 }),
    objects, stats, sign, recoveryTokens, db,
    async stop() { proc.kill('SIGTERM'); await new Promise((r) => server.close(r)); await db.end(); },
  };
}

module.exports = { start, JWT_SECRET, sign };
