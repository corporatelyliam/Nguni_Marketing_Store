// server/src/services/email.js
// Email channel. With SMTP configured it sends via Nodemailer; otherwise the message is
// printed to the console (development). Never throws: a mail problem must not fail a request.
const nodemailer = require('nodemailer');
const env = require('../config/env');

let transporter = null;
if (env.smtp.host) {
  transporter = nodemailer.createTransport({
    host: env.smtp.host, port: env.smtp.port, secure: env.smtp.port === 465,
    auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
  });
}
const sent = []; // last few messages, so automated tests can assert on them
const outbox = () => sent;

async function sendEmail({ to, subject, text }) {
  if (!to) return false;
  sent.push({ to, subject, text, at: Date.now() }); if (sent.length > 200) sent.shift();
  if (!transporter) {
    if (process.env.NODE_ENV !== 'test') console.log(`[email:console] to=${to} subject="${subject}"\n${text}\n`); // eslint-disable-line no-console
    return true;
  }
  try { await transporter.sendMail({ from: env.smtp.from, to, subject, text }); return true; }
  catch (err) { console.error('Email send failed:', err.message); return false; } // eslint-disable-line no-console
}

module.exports = { sendEmail, outbox, channel: { name: 'email', send: sendEmail } };
