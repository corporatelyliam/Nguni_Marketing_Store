#!/usr/bin/env node
/* database/seed/seed_admin.js
 * Creates (or repairs) the root administrator and makes sure the storage buckets exist.
 *   npm run seed:admin                    create/repair the admin from ADMIN_SEED_* in .env
 *   npm run seed:admin -- --reset-password  also set the password from ADMIN_SEED_PASSWORD
 *
 * Safe to run any number of times:
 *  - no account yet            -> creates the Auth user and the matching admin profile
 *  - account exists, no profile -> adds the missing admin profile (no orphaned Auth user)
 *  - account exists as non-admin / inactive -> promotes + reactivates it, and says so
 *  - already a correct admin    -> changes nothing
 * Credentials come only from the environment; nothing is hard-coded.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_SEED_NAME } = process.env;
const email = (process.env.ADMIN_SEED_EMAIL || '').trim().toLowerCase();
const password = process.env.ADMIN_SEED_PASSWORD || '';
const resetPassword = process.argv.includes('--reset-password');

function fail(msg) { console.error(`\n${msg}\n`); process.exit(1); }

const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ADMIN_SEED_EMAIL', 'ADMIN_SEED_PASSWORD'].filter((k) => !process.env[k]);
if (missing.length) fail(`Missing in .env: ${missing.join(', ')}  (see .env.example)`);
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('ADMIN_SEED_EMAIL is not a valid email address.');
if (password.length < 8 || password.length > 72) fail('ADMIN_SEED_PASSWORD must be 8 to 72 characters.');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function findAuthUser() {
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`Could not list Auth users: ${error.message}`);
    const hit = data.users.find((u) => (u.email || '').toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function ensureBuckets() {
  const wanted = [
    { id: process.env.SUPABASE_STORAGE_BUCKET || 'private-files', public: false },
    { id: process.env.SUPABASE_PRODUCT_BUCKET || 'product-images', public: true },
  ];
  const { data: existing, error } = await supabase.storage.listBuckets();
  if (error) throw new Error(`Could not read storage buckets: ${error.message}`);
  for (const b of wanted) {
    if (existing.some((e) => e.name === b.id)) { console.log(`bucket ok        ${b.id}`); continue; }
    const { error: cErr } = await supabase.storage.createBucket(b.id, { public: b.public });
    if (cErr) throw new Error(`Could not create bucket "${b.id}": ${cErr.message}`);
    console.log(`bucket created   ${b.id} (${b.public ? 'public' : 'private'})`);
  }
}

async function main() {
  await ensureBuckets();

  let user = await findAuthUser();
  let createdNow = false;
  if (!user) {
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(`Could not create the Auth user: ${error.message}`);
    user = data.user; createdNow = true;
    console.log(`auth user created ${email}`);
  } else if (resetPassword) {
    const { error } = await supabase.auth.admin.updateUserById(user.id, { password });
    if (error) throw new Error(`Could not reset the password: ${error.message}`);
    console.log('password reset from ADMIN_SEED_PASSWORD');
  }

  const { data: profile, error: pErr } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (pErr) throw new Error(`Could not read profiles (have the migrations been run? npm run db:migrate): ${pErr.message}`);

  if (!profile) {
    const { error } = await supabase.from('profiles').insert({ id: user.id, full_name: ADMIN_SEED_NAME || 'Nguni Admin', role: 'admin', department: null, is_active: true });
    if (error) {
      if (createdNow) await supabase.auth.admin.deleteUser(user.id); // never leave an orphaned Auth user
      throw new Error(`Could not create the admin profile: ${error.message}`);
    }
    console.log('profile created   role=admin');
  } else if (profile.role !== 'admin' || !profile.is_active || profile.department) {
    const { error } = await supabase.from('profiles').update({ role: 'admin', department: null, is_active: true }).eq('id', user.id);
    if (error) throw new Error(`Could not update the profile: ${error.message}`);
    console.log(`profile updated   was role=${profile.role}, active=${profile.is_active}  ->  role=admin, active=true`);
  } else {
    console.log('profile ok        already an active admin');
  }

  console.log(`\nAdmin ready: ${email}\nLog in at /login.html. You will be taken to /admin/index.html.\n`);
}

main().catch((err) => fail(err.message));
