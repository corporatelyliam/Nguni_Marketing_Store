// server/src/config/env.js
// Loads and validates environment variables once at startup and fails fast with a
// clear message, rather than limping along insecurely.
require('dotenv').config();

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SESSION_SECRET', 'CSRF_SECRET', 'JOBS_SECRET'];
const problems = [];

const missing = required.filter((k) => !process.env[k]);
if (missing.length) problems.push(`Missing required environment variables: ${missing.join(', ')}`);

for (const k of ['SESSION_SECRET', 'CSRF_SECRET', 'JOBS_SECRET']) {
  if (process.env[k] && process.env[k].length < 16) problems.push(`${k} must be at least 16 characters (use 32+ random bytes).`);
}
if (process.env.SUPABASE_URL && !/^https?:\/\//.test(process.env.SUPABASE_URL)) {
  problems.push('SUPABASE_URL must start with http:// or https:// (e.g. https://xxxx.supabase.co).');
}
const nodeEnv = process.env.NODE_ENV || 'development';
if (nodeEnv === 'production' && !/^https:\/\//.test(process.env.APP_BASE_URL || '')) {
  problems.push('In production APP_BASE_URL must be set to your public https:// address.');
}
if (problems.length) {
  // eslint-disable-next-line no-console
  console.error(`\nConfiguration error:\n  - ${problems.join('\n  - ')}\n\nCopy .env.example to .env and fill it in (see docs/06-Installation-Guide.md).\n`);
  process.exit(1);
}

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

module.exports = {
  nodeEnv,
  isProd: nodeEnv === 'production',
  port: int(process.env.PORT, 3000),
  appBaseUrl: process.env.APP_BASE_URL || `http://localhost:${int(process.env.PORT, 3000)}`,

  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  storageBucket: process.env.SUPABASE_STORAGE_BUCKET || 'private-files',
  productBucket: process.env.SUPABASE_PRODUCT_BUCKET || 'product-images',

  sessionSecret: process.env.SESSION_SECRET,
  csrfSecret: process.env.CSRF_SECRET,
  jobsSecret: process.env.JOBS_SECRET,

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'Nguni Marketing <no-reply@nguni.example>',
  },

  uploadMaxBytes: int(process.env.UPLOAD_MAX_BYTES, 5 * 1024 * 1024),
  productImageMaxBytes: int(process.env.PRODUCT_IMAGE_MAX_BYTES, 2 * 1024 * 1024),
  runJobs: process.env.DISABLE_JOBS !== 'true',
};
