// Test helper: builds a throwaway database (auth shim + all real migrations + seeds).
// Needs a Postgres superuser URL in TEST_PG_URL (default: postgres://postgres:postgres@127.0.0.1:5432/postgres).
const fs = require('fs');
const path = require('path');
const { Client, Pool } = require('pg');
const migrate = require('../../../database/migrate');

const ADMIN_URL = process.env.TEST_PG_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function urlFor(dbName) {
  const u = new URL(ADMIN_URL);
  u.pathname = '/' + dbName;
  return u.toString();
}

async function createDatabase(dbName) {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query(`create database ${dbName}`);
  await admin.end();
  const url = urlFor(dbName);
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query(fs.readFileSync(path.join(__dirname, 'auth_shim.sql'), 'utf8'));
  await c.end();
  await migrate.run({ connectionString: url, log: () => {} });
  return url;
}

let counter = 0;
async function makeUser(pool, { role = 'client', department = null, name } = {}) {
  counter += 1;
  const email = `u${counter}-${Date.now()}@test.local`;
  const { rows } = await pool.query('insert into auth.users(email) values ($1) returning id', [email]);
  await pool.query('insert into profiles(id, full_name, role, department) values ($1,$2,$3,$4)',
    [rows[0].id, name || `User ${counter}`, role, department]);
  return { id: rows[0].id, email };
}

// Runs fn inside a transaction as the given database role, like PostgREST does for a JWT.
async function asRole(pool, role, sub, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${role}`);
    if (sub) await c.query("select set_config('request.jwt.claim.sub', $1, true)", [sub]);
    const out = await fn(c);
    await c.query('rollback');
    return out;
  } catch (err) {
    await c.query('rollback').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

module.exports = { createDatabase, urlFor, makeUser, asRole, Pool, ADMIN_URL };
