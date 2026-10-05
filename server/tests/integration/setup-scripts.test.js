// Setup tooling: root-admin seed script and migration runner, against the real stack.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { Client } = require('pg');
const { boot } = require('../support/app');
const { ADMIN_URL, urlFor } = require('../support/pg');
const migrate = require('../../../database/migrate');

let t; const ROOT = path.join(__dirname, '../../..');
// Async on purpose: the stand-in Supabase gateway runs inside THIS process, so it must stay free to answer the script.
const seed = (extra = {}, args = []) => new Promise((resolve) => execFile(process.execPath, ['database/seed/seed_admin.js', ...args], { cwd: ROOT,
  env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: '/nonexistent', SUPABASE_URL: t.sb.url, SUPABASE_SERVICE_ROLE_KEY: t.sb.serviceKey, ADMIN_SEED_EMAIL: 'root@nguni.test', ADMIN_SEED_PASSWORD: 'RootPassw0rd!', ADMIN_SEED_NAME: 'Root Admin', ...extra } },
  (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr })));
const profileOf = async (email) => (await t.sb.db.query('select p.* from profiles p join auth.users u on u.id=p.id where u.email=$1', [email])).rows;

before(async () => { t = await boot('nguni_test_setup'); });
after(async () => { await t.stop(); });

test('seed_admin creates the Auth user + admin profile, who can then log in and reach the admin API', async () => {
  const r = await seed(); assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /auth user created/); assert.match(r.stdout, /profile created/);
  const rows = await profileOf('root@nguni.test'); assert.equal(rows.length, 1); assert.equal(rows[0].role, 'admin'); assert.equal(rows[0].is_active, true);
  const b = t.browser(); const login = await b.post('/api/auth/login', { email: 'root@nguni.test', password: 'RootPassw0rd!' });
  assert.equal(login.body.user.role, 'admin'); assert.equal((await b.get('/api/admin/dashboard')).status, 200);
  assert.match(r.stdout, /bucket ok/);
});
test('running it again is harmless: no duplicate profile, nothing changed', async () => {
  const r = await seed(); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /already an active admin/); assert.ok(!/created/.test(r.stdout.replace(/bucket created/g, '')));
  assert.equal((await profileOf('root@nguni.test')).length, 1);
});
test('an existing non-admin / deactivated account is promoted and reactivated (and it says so); password untouched unless asked', async () => {
  const u = await t.makeUser({ name: 'Was Client' }); await t.sb.db.query('update profiles set is_active=false where id=$1', [u.id]);
  const r = await seed({ ADMIN_SEED_EMAIL: u.email, ADMIN_SEED_PASSWORD: 'SomethingElse1!' }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /was role=client, active=false/);
  const row = (await profileOf(u.email))[0]; assert.equal(row.role, 'admin'); assert.equal(row.is_active, true);
  assert.equal((await t.browser().post('/api/auth/login', { email: u.email, password: u.password })).status, 200, 'old password still works');
  assert.equal((await seed({ ADMIN_SEED_EMAIL: u.email, ADMIN_SEED_PASSWORD: 'SomethingElse1!' }, ['--reset-password'])).status, 0);
  assert.equal((await t.browser().post('/api/auth/login', { email: u.email, password: 'SomethingElse1!' })).status, 200);
});
test('an Auth user with no profile gets one (no orphaned Auth user left behind)', async () => {
  await t.supabase.auth.admin.createUser({ email: 'orphan@nguni.test', password: 'Passw0rd!x', email_confirm: true });
  assert.equal((await profileOf('orphan@nguni.test')).length, 0);
  const r = await seed({ ADMIN_SEED_EMAIL: 'orphan@nguni.test' }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /profile created/);
  assert.equal((await profileOf('orphan@nguni.test'))[0].role, 'admin');
});
test('bad configuration gives clear errors and a non-zero exit', async () => {
  let r = await seed({ ADMIN_SEED_PASSWORD: '' }); assert.equal(r.status, 1); assert.match(r.stderr, /Missing in \.env: ADMIN_SEED_PASSWORD/);
  r = await seed({ ADMIN_SEED_EMAIL: 'not-an-email' }); assert.equal(r.status, 1); assert.match(r.stderr, /not a valid email/);
  r = await seed({ ADMIN_SEED_PASSWORD: 'short' }); assert.equal(r.status, 1); assert.match(r.stderr, /8 to 72 characters/);
});

test('migration runner: adopts a database built by hand from the original files, then applies only the new ones', async () => {
  const admin = new Client({ connectionString: ADMIN_URL }); await admin.connect();
  await admin.query('drop database if exists nguni_test_adopt with (force)'); await admin.query('create database nguni_test_adopt'); await admin.end();
  const url = urlFor('nguni_test_adopt'); const c = new Client({ connectionString: url }); await c.connect();
  await c.query(fs.readFileSync(path.join(__dirname, '../support/auth_shim.sql'), 'utf8'));
  for (const f of ['001_enums', '002_tables', '003_functions', '004_rls']) await c.query(fs.readFileSync(path.join(ROOT, `database/migrations/${f}.sql`), 'utf8')); // the OLD manual install
  const logs = []; const ran = await migrate.run({ connectionString: url, log: (m) => logs.push(m) });
  assert.ok(logs.some((l) => /adopted migrations 001-004/.test(l))); assert.equal(ran, 5, logs.join('|'));   // 005, 006, 007, seed_products, seed_settings
  assert.equal((await c.query('select count(*)::int n from products')).rows[0].n, 18);
  assert.equal(await migrate.run({ connectionString: url, log: () => {} }), 0, 'second run is a no-op');
  assert.equal((await c.query("select has_function_privilege('anon','create_order_tx(uuid,jsonb,delivery_method,uuid,text,text)','execute') a")).rows[0].a, false);
  await c.end();
});
test('a failing migration rolls back completely and reports the file', async () => {
  const admin = new Client({ connectionString: ADMIN_URL }); await admin.connect();
  await admin.query('drop database if exists nguni_test_badmig with (force)'); await admin.query('create database nguni_test_badmig'); await admin.end();
  const url = urlFor('nguni_test_badmig');
  const tmp = path.join(ROOT, 'database/migrations/999_bad_test.sql'); fs.writeFileSync(tmp, 'create table half_done(id int); select 1/0;');
  try {
    const c = new Client({ connectionString: url }); await c.connect(); await c.query(fs.readFileSync(path.join(__dirname, '../support/auth_shim.sql'), 'utf8'));
    await assert.rejects(() => migrate.run({ connectionString: url, log: () => {} }), /999_bad_test\.sql failed/);
    assert.equal((await c.query("select to_regclass('public.half_done') t")).rows[0].t, null, 'no partial table left');
    await c.end();
  } finally { fs.unlinkSync(tmp); }
});
