#!/usr/bin/env node
/* database/migrate.js
 * Applies database/migrations/*.sql in order, then database/seed/seed_*.sql, recording
 * what has run in a schema_migrations table so it is safe to run repeatedly.
 *
 *   npm run db:migrate              migrations + seeds
 *   npm run db:migrate -- --demo    also load demo opening stock (NOT for production)
 *
 * Needs DATABASE_URL: the Postgres connection string from Supabase
 * (Project Settings > Database > Connection string, "URI"). This is only used by this
 * setup script and by the test-suite. The running web server never needs it.
 *
 * A database that was set up by hand from the original four files (001-004) is
 * detected and adopted: those four are marked as applied rather than re-run.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DIR = __dirname;
const BASELINE = ['001_enums.sql', '002_tables.sql', '003_functions.sql', '004_rls.sql'];

function list(sub, filter) {
  return fs.readdirSync(path.join(DIR, sub)).filter(filter).sort();
}

async function run({ connectionString, demo = false, log = console.log } = {}) {
  const url = connectionString || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Add your Supabase Postgres connection string to .env (see .env.example).');
  }
  const client = new Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const applied = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));

    if (applied.size === 0) {
      const { rows } = await client.query("select to_regclass('public.profiles') as t");
      if (rows[0].t) {
        for (const f of BASELINE) await client.query('insert into schema_migrations(name) values ($1) on conflict do nothing', ['migrations/' + f]);
        BASELINE.forEach((f) => applied.add('migrations/' + f));
        log('Existing schema detected: adopted migrations 001-004 as already applied.');
      }
    }

    const files = [
      ...list('migrations', (f) => /^\d+_.*\.sql$/.test(f)).map((f) => 'migrations/' + f),
      ...list('seed', (f) => /^seed_.*\.sql$/.test(f)).map((f) => 'seed/' + f),
      ...(demo ? ['seed/demo_stock.sql'] : []),
    ];

    let ran = 0;
    for (const rel of files) {
      if (applied.has(rel)) continue;
      const sql = fs.readFileSync(path.join(DIR, rel), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations(name) values ($1)', [rel]);
        await client.query('commit');
        log(`applied  ${rel}`);
        ran += 1;
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw new Error(`${rel} failed: ${err.message}`);
      }
    }
    if (!ran) log('Database is already up to date.');
    return ran;
  } finally {
    await client.end();
  }
}

module.exports = { run };

if (require.main === module) {
  run({ demo: process.argv.includes('--demo') }).catch((err) => {
    console.error('\nMigration failed: ' + err.message);
    process.exit(1);
  });
}
