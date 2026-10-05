// server/src/app.js
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const env = require('./config/env');
const { apiLimiter } = require('./middleware/rateLimit');
const { csrfProtection } = require('./middleware/csrf');
const { notFound, errorHandler } = require('./middleware/errors');
const { adminOnly, staffOnly, signedIn } = require('./middleware/pageGuard');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // the hosting platform's proxy: req.ip / rate limiting see the real client

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      // No inline scripts anywhere: every page loads its logic from /js/*.js, so a script-injection
      // (XSS) cannot execute. Do not add 'unsafe-inline' here.
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // the existing site design uses inline style attributes
      imgSrc: ["'self'", 'data:', 'https:', ...(env.isProd ? [] : ['http:'])],
      connectSrc: ["'self'"],
      frameSrc: ['https://www.facebook.com'], // existing embedded Facebook reels
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      ...(env.isProd ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  hsts: env.isProd,
}));
app.use(cors({ origin: env.appBaseUrl, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// ---- API ----
app.use('/api', apiLimiter);
app.use('/api', csrfProtection); // every POST/PATCH/PUT/DELETE needs a valid X-CSRF-Token (GET/HEAD/OPTIONS are exempt)
app.use('/api/auth', require('./routes/auth'));
app.use('/api/me/addresses', require('./routes/addresses'));
app.use('/api/contact', require('./routes/contact'));
app.use('/api', require('./routes/products'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api', require('./routes/quotes'));
app.use('/api/tickets', require('./routes/tickets'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/admin', require('./routes/admin'));
app.use('/internal', require('./routes/internal'));

// ---- Pages: role-gated on the server, then the static site ----
app.use('/admin', adminOnly);
app.use('/staff', staffOnly);
for (const p of ['/account', '/checkout', '/order', '/quote', '/support']) { app.use(p + '.html', signedIn); app.use(p, signedIn); }
app.use(express.static(path.join(__dirname, '../../public'), { extensions: ['html'], index: 'index.html' }));

app.use('/api', notFound);
app.use('/internal', notFound);
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, '../../public/404.html')));
app.use(errorHandler);

module.exports = app;
