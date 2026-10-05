// server/src/server.js
const cron = require('node-cron');
const app = require('./app');
const env = require('./config/env');
const orders = require('./services/orders');

const server = app.listen(env.port, () => {
  console.log(`Nguni Marketing store running at ${env.appBaseUrl} (port ${env.port}, ${env.nodeEnv})`); // eslint-disable-line no-console
});

async function expiryJob() {
  try {
    const r = await orders.runExpiryJobs();
    if (r.orders || r.quotes) console.log(`Expiry job: ${r.orders} order(s), ${r.quotes} quote(s) expired.`); // eslint-disable-line no-console
  } catch (err) { console.error('Expiry job failed:', err.message); } // eslint-disable-line no-console
}
// Every 10 minutes (safe to overlap with an external scheduler calling /internal/jobs/expire-orders).
if (env.runJobs) { cron.schedule('*/10 * * * *', expiryJob); setTimeout(expiryJob, 5000).unref(); }

const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop); process.on('SIGINT', stop);
