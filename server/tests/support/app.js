// Boots the REAL Express app against the local Supabase stand-in + a freshly migrated database,
// and provides a browser-like client (cookie jar + automatic CSRF) to drive it over HTTP.
const { createDatabase } = require('./pg');
const local = require('./local-supabase');

async function boot(dbName, { accessTtl } = {}) {
  await createDatabase(dbName);
  const sb = await local.start({ dbName, accessTtl });
  Object.assign(process.env, {
    NODE_ENV: 'test', SUPABASE_URL: sb.url, SUPABASE_SERVICE_ROLE_KEY: sb.serviceKey,
    SESSION_SECRET: 'x'.repeat(32), CSRF_SECRET: 'y'.repeat(32), JOBS_SECRET: 'jobs-secret-for-tests', DISABLE_JOBS: 'true',
    SUPABASE_STORAGE_BUCKET: 'private-files', SUPABASE_PRODUCT_BUCKET: 'product-images',
  });
  const app = require('../../src/app');
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const supabase = require('../../src/db/supabase');
  const email = require('../../src/services/email');

  async function makeUser({ role = 'client', department = null, name, password = 'Passw0rd!x' } = {}) {
    const mail = `${role}${department ? '-' + department : ''}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const { data, error } = await supabase.auth.admin.createUser({ email: mail, password, email_confirm: true });
    if (error) throw error;
    const { error: pe } = await supabase.from('profiles').insert({ id: data.user.id, full_name: name || `${role} ${department || ''}`.trim(), role, department });
    if (pe) throw pe;
    return { id: data.user.id, email: mail, password };
  }
  const browser = () => new Browser(base);
  async function login(user) { const b = browser(); const r = await b.post('/api/auth/login', { email: user.email, password: user.password }); if (r.status !== 200) throw new Error(`login failed ${r.status} ${JSON.stringify(r.body)}`); return b; }
  async function stop() { await new Promise((r) => server.close(r)); await sb.stop(); }
  return { base, sb, supabase, makeUser, browser, login, stop, outbox: email.outbox };
}

class Browser {
  constructor(base) { this.base = base; this.jar = new Map(); this.csrf = null; }
  get cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair, ...attrs] = c.split(';'); const i = pair.indexOf('='); const name = pair.slice(0, i).trim(); const val = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*expires=/i.test(a) && new Date(a.split('=')[1]) < new Date());
      if (!val || expired) this.jar.delete(name); else this.jar.set(name, val);
    }
  }
  async token(force) {
    if (this.csrf && !force) return this.csrf;
    const r = await fetch(`${this.base}/api/auth/csrf`, { headers: { cookie: this.cookieHeader } }); this.store(r);
    this.csrf = (await r.json()).csrfToken; return this.csrf;
  }
  async req(method, path, { json, form, headers = {}, csrf = true, raw } = {}) {
    const h = { ...headers }; let body;
    if (form) body = form; else if (raw !== undefined) { body = raw; h['content-type'] = h['content-type'] || 'application/json'; } else if (json !== undefined) { body = JSON.stringify(json); h['content-type'] = 'application/json'; }
    if (csrf && method !== 'GET') h['x-csrf-token'] = await this.token();
    h.cookie = this.cookieHeader; // read AFTER the token fetch so the CSRF cookie is included
    const res = await fetch(this.base + path, { method, headers: h, body, redirect: 'manual' }); this.store(res);
    const text = await res.text(); let parsed = null; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers };
  }
  get(p, o) { return this.req('GET', p, o); }
  post(p, json, o) { return this.req('POST', p, { json, ...o }); }
  patch(p, json, o) { return this.req('PATCH', p, { json, ...o }); }
  put(p, json, o) { return this.req('PUT', p, { json, ...o }); }
  del(p, o) { return this.req('DELETE', p, o); }
  upload(p, field, buf, filename, type, o) { const f = new FormData(); f.append(field, new Blob([buf], { type }), filename); return this.req('POST', p, { form: f, ...o }); }
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const EXE = Buffer.from('MZ\x90\x00\x03\x00\x00\x00 this is not a pdf');

module.exports = { boot, Browser, PDF, PNG, JPG, EXE };
