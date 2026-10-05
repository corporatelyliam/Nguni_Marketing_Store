#!/usr/bin/env node
/* Runs a test folder with the built-in Node test runner, listing files explicitly so it behaves
   the same on Node 20, 22 and later.   node scripts/run-tests.js unit|integration */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const kind = process.argv[2];
const dir = path.join(__dirname, '../server/tests', kind || '');
if (!['unit', 'integration'].includes(kind) || !fs.existsSync(dir)) { console.error('usage: run-tests.js unit|integration'); process.exit(2); }
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));

if (kind === 'integration') {
  const hasPg = spawnSync('psql', ['--version'], { encoding: 'utf8' }).status === 0 || !!process.env.TEST_PG_URL;
  const hasRest = spawnSync(process.env.PGRST_BIN || 'postgrest', ['--version'], { encoding: 'utf8' }).status === 0;
  if (!hasPg || !hasRest) {
    console.error('Integration tests need a local PostgreSQL superuser (TEST_PG_URL, e.g. postgres://postgres:postgres@127.0.0.1:5432/postgres)\nand the PostgREST binary on PATH (or PGRST_BIN=/path/to/postgrest). See docs/08-Maintenance-Guide.md > Testing.');
    process.exit(1);
  }
}
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test' } });
process.exit(r.status === null ? 1 : r.status);
