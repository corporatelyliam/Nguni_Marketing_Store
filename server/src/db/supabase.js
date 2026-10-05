// server/src/db/supabase.js
// The ONLY place the service-role key is used. This client bypasses RLS, so every
// route built on it must go through requireAuth + RBAC first. It is never sent to
// or imported by anything that runs in the browser.
const { createClient } = require('@supabase/supabase-js');
const env = require('../config/env');

const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };

// Admin/database client: use for tables, RPCs, storage and auth.admin.* ONLY.
const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, options);

// signInWithPassword / refreshSession / verifyOtp store the resulting USER session inside
// the client instance. Doing that on the shared client above could make later admin
// queries run as that user. So user-session calls always get a throwaway client.
const newAuthClient = () => createClient(env.supabaseUrl, env.supabaseServiceRoleKey, options);

module.exports = supabase;
module.exports.newAuthClient = newAuthClient;
