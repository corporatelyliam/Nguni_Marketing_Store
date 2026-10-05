process.env.ENFORCE_RATE_LIMITS = '1'; // switch the limiters back on (they are skipped in other test files)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../support/app');
let t; before(async () => { t = await boot('nguni_test_limits'); }); after(async () => { await t.stop(); });

test('login is throttled per IP + email after repeated failures; other accounts are unaffected; a good login still works for others', async () => {
  const victim = await t.makeUser(); const other = await t.makeUser(); const b = t.browser(); const codes = [];
  for (let i = 0; i < 10; i += 1) codes.push((await b.post('/api/auth/login', { email: victim.email, password: 'wrong-' + i })).status);
  assert.deepEqual(codes.slice(0, 8), Array(8).fill(401)); assert.deepEqual(codes.slice(8), [429, 429]);
  const blocked = await b.post('/api/auth/login', { email: victim.email, password: victim.password }); assert.equal(blocked.status, 429); assert.equal(blocked.body.error.code, 'RATE_LIMITED');
  assert.equal((await b.post('/api/auth/login', { email: other.email, password: other.password })).status, 200);
});
test('contact form is limited to 5 messages per hour per IP', async () => {
  const b = t.browser(); const codes = [];
  for (let i = 0; i < 7; i += 1) codes.push((await b.post('/api/contact', { name: 'Spammer', email: 's@x.com', message: 'message number ' + i })).status);
  assert.deepEqual(codes, [201, 201, 201, 201, 201, 429, 429]);
});
test('registration / password-reset attempts are limited', async () => {
  const b = t.browser(); let last;
  for (let i = 0; i < 12; i += 1) last = (await b.post('/api/auth/forgot-password', { email: `x${i}@test.local` })).status;
  assert.equal(last, 429);
});
