// server/src/routes/internal.js: scheduler-only endpoints, protected by a shared secret header (no user session).
const crypto = require('crypto');
const express = require('express');
const env = require('../config/env');
const orders = require('../services/orders');
const { ah } = require('../lib/http');

const router = express.Router();
const same = (a, b) => { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

router.post('/jobs/expire-orders', (req, res, next) => (same(req.headers['x-jobs-secret'], env.jobsSecret) ? next()
  : res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid job secret.' } })),
ah(async (req, res) => res.json(await orders.runExpiryJobs())));

module.exports = router;
