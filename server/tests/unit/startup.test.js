const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const run = (env) => spawnSync(process.execPath, ['-e', "require('./server/src/config/env')"], {
  cwd: path.join(__dirname, '../../..'), env: { PATH: process.env.PATH, ...env }, encoding: 'utf8',
});
const good = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', SESSION_SECRET: 's'.repeat(32), CSRF_SECRET: 'c'.repeat(32), JOBS_SECRET: 'j'.repeat(32), DOTENV_CONFIG_PATH: '/nonexistent' };

test('startup fails fast with a clear message when required settings are missing', () => {
  const r = run({ DOTENV_CONFIG_PATH: '/nonexistent' });
  assert.equal(r.status, 1); assert.match(r.stderr, /Missing required environment variables: .*SUPABASE_URL.*SUPABASE_SERVICE_ROLE_KEY/); assert.match(r.stderr, /\.env\.example/);
});
test('weak secrets, bad URLs and insecure production settings are rejected', () => {
  assert.match(run({ ...good, SESSION_SECRET: 'short' }).stderr, /SESSION_SECRET must be at least 16/);
  assert.match(run({ ...good, SUPABASE_URL: 'not-a-url' }).stderr, /SUPABASE_URL must start with/);
  assert.match(run({ ...good, NODE_ENV: 'production', APP_BASE_URL: 'http://insecure.example' }).stderr, /APP_BASE_URL/);
});
test('a valid configuration loads', () => { assert.equal(run(good).status, 0); });
