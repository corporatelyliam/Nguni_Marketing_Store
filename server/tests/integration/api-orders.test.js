// End-to-end API tests: the real Express app + real PostgREST + real migrated Postgres
// (auth/storage emulated, see support/local-supabase.js). Drives it over HTTP like a browser would.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { boot, PDF, PNG, EXE } = require('../support/app');

let t; let admin; let finance; let sales; let ops; let support; let alice; let bob;
let A; let B; let F; let S; let O; let SU; let AD; // logged-in browsers

before(async () => {
  t = await boot('nguni_test_api_orders');
  [admin, finance, sales, ops, support] = await Promise.all([
    t.makeUser({ role: 'admin' }), t.makeUser({ role: 'employee', department: 'finance' }), t.makeUser({ role: 'employee', department: 'sales' }),
    t.makeUser({ role: 'employee', department: 'operations' }), t.makeUser({ role: 'support' }),
  ]);
  [alice, bob] = await Promise.all([t.makeUser(), t.makeUser()]);
  [AD, F, S, O, SU, A, B] = await Promise.all([admin, finance, sales, ops, support, alice, bob].map((u) => t.login(u)));
  await AD.post('/api/staff/stock/adjust', { product_id: 'pr-pullup', delta: 10, reason: 'restock' });
  await AD.post('/api/staff/stock/adjust', { product_id: 'sg-stamps', delta: 1, reason: 'restock' });
});
after(async () => { await t.stop(); });

const orderBody = (items, extra = {}) => ({ items, delivery_method: 'collection', accept_terms: true, ...extra });
const stockOf = async (id) => (await AD.get('/api/staff/stock')).body.stock.find((s) => s.productId === id);

describe('authentication & sessions', () => {
  test('register always creates a client, even if the body asks for admin', async () => {
    const b = t.browser();
    assert.equal((await b.post('/api/auth/register', { fullName: 'Eve Evil', email: 'eve@test.local', password: 'Passw0rd!x', role: 'admin', department: 'finance' })).status, 201);
    const me = await b.post('/api/auth/login', { email: 'eve@test.local', password: 'Passw0rd!x' });
    assert.equal(me.body.user.role, 'client'); assert.equal(me.body.user.department, null);
  });
  test('duplicate email, weak password, bad email and wrong password give clear errors without leaking internals', async () => {
    const b = t.browser();
    const dup = await b.post('/api/auth/register', { fullName: 'Dup', email: alice.email, password: 'Passw0rd!x' });
    assert.equal(dup.status, 409); assert.equal(dup.body.error.code, 'EMAIL_IN_USE');
    assert.equal((await b.post('/api/auth/register', { fullName: 'Short', email: 'a@b.co', password: '123' })).status, 400);
    assert.equal((await b.post('/api/auth/register', { fullName: 'X', email: 'not-an-email', password: 'Passw0rd!x' })).status, 400);
    const bad = await b.post('/api/auth/login', { email: alice.email, password: 'nope' });
    assert.equal(bad.status, 401); assert.equal(bad.body.error.message, 'Incorrect email or password.');
    assert.equal((await b.post('/api/auth/login', { email: 'ghost@test.local', password: 'nope' })).body.error.message, 'Incorrect email or password.');
  });
  test('session cookies are HttpOnly and no service-role key reaches the browser', async () => {
    const b = t.browser(); const r = await b.post('/api/auth/login', { email: alice.email, password: alice.password });
    const raw = r.headers.getSetCookie().join('\n');
    assert.match(raw, /ng_at=.*HttpOnly/i); assert.match(raw, /ng_rt=.*HttpOnly/i);
    assert.ok(!JSON.stringify(r.body).includes('eyJ'), 'no token in JSON body');
    const files = ['/js/api.js', '/js/auth-guard.js', '/js/shop.js', '/index.html', '/login.html'];
    for (const f of files) { const x = await (await fetch(t.base + f)).text(); assert.ok(!x.includes(process.env.SUPABASE_SERVICE_ROLE_KEY), f); }
  });
  test('an expired access token is silently renewed from the refresh token', async () => {
    const b = await t.login(alice); b.jar.delete('ng_at');
    const before = t.sb.stats.refreshes; const r = await b.get('/api/auth/me');
    assert.equal(r.status, 200); assert.equal(t.sb.stats.refreshes, before + 1); assert.ok(b.jar.has('ng_at'), 'new access cookie issued');
    assert.equal((await b.get('/api/auth/me')).status, 200);
  });
  test('logout ends the session; protected routes then return 401', async () => {
    const b = await t.login(alice); assert.equal((await b.post('/api/auth/logout')).status, 200);
    assert.equal((await b.get('/api/orders')).status, 401); assert.equal((await b.get('/api/auth/me')).status, 401);
  });
  test('password reset: generic answer for unknown emails, one-time link, old password stops working', async () => {
    const b = t.browser(); const u = await t.makeUser({ name: 'Reset Me' });
    const unknown = await b.post('/api/auth/forgot-password', { email: 'nobody@test.local' });
    const known = await b.post('/api/auth/forgot-password', { email: u.email });
    assert.equal(unknown.status, 200); assert.deepEqual(unknown.body, known.body);
    await new Promise((r) => setTimeout(r, 200));
    const mail = t.outbox().filter((m) => m.to === u.email && /Reset/.test(m.subject)).pop(); assert.ok(mail, 'reset email sent');
    assert.equal(t.outbox().filter((m) => m.to === 'nobody@test.local').length, 0, 'nothing sent to unknown address');
    const token = decodeURIComponent(mail.text.match(/token=([^\s]+)/)[1]);
    assert.equal((await b.post('/api/auth/reset-password', { token, password: 'short' })).status, 400);
    assert.equal((await b.post('/api/auth/reset-password', { token, password: 'BrandNewPass1' })).status, 200);
    assert.equal((await b.post('/api/auth/reset-password', { token, password: 'AnotherPass22' })).status, 400, 'link is single-use');
    assert.equal((await b.post('/api/auth/login', { email: u.email, password: u.password })).status, 401);
    assert.equal((await b.post('/api/auth/login', { email: u.email, password: 'BrandNewPass1' })).status, 200);
    assert.equal((await b.post('/api/auth/reset-password', { token: 'x'.repeat(40), password: 'BrandNewPass1' })).status, 400);
  });
  test('change password requires the current one', async () => {
    const u = await t.makeUser(); const b = await t.login(u);
    assert.equal((await b.post('/api/auth/change-password', { currentPassword: 'wrong', newPassword: 'NewPassw0rd!' })).status, 400);
    assert.equal((await b.post('/api/auth/change-password', { currentPassword: u.password, newPassword: 'NewPassw0rd!' })).status, 200);
    assert.equal((await t.browser().post('/api/auth/login', { email: u.email, password: 'NewPassw0rd!' })).status, 200);
  });
  test('profile PATCH cannot touch role/department/active (mass assignment)', async () => {
    assert.equal((await A.patch('/api/auth/me', { role: 'admin' })).status, 400);
    assert.equal((await A.patch('/api/auth/me', { is_active: true, department: 'finance' })).status, 400);
    assert.equal((await A.patch('/api/auth/me', { fullName: 'Alice Smith', company: 'ACME' })).body.user.company, 'ACME');
    assert.equal((await A.get('/api/auth/me')).body.user.role, 'client');
  });
});

describe('server-side page guards', () => {
  const get = async (path, jar) => { const r = await fetch(t.base + path, { redirect: 'manual', headers: { cookie: jar ? jar.cookieHeader : '' } }); return { status: r.status, loc: r.headers.get('location') }; };
  test('anonymous visitors are sent to login, then back to the page they asked for', async () => {
    for (const p of ['/admin/index.html', '/staff/index.html', '/account.html', '/checkout.html']) {
      const r = await get(p); assert.equal(r.status, 302, p); assert.equal(r.loc, `/login.html?next=${encodeURIComponent(p)}`);
    }
    assert.equal((await get('/order.html?id=abc')).loc, `/login.html?next=${encodeURIComponent('/order.html?id=abc')}`, 'query string preserved');
  });
  test('each role lands where it belongs; nobody can open a dashboard that is not theirs', async () => {
    assert.equal((await get('/admin/index.html', AD)).status, 200);
    assert.equal((await get('/admin/index.html', A)).loc, '/account.html');
    assert.equal((await get('/admin/index.html', F)).loc, '/staff/index.html');
    assert.equal((await get('/staff/index.html', A)).loc, '/account.html');
    assert.equal((await get('/staff/index.html', F)).status, 200);
    assert.equal((await get('/staff/index.html', AD)).status, 200);
    assert.equal((await get('/account.html', A)).status, 200);
  });
  test('public pages stay public; unknown pages 404', async () => {
    for (const p of ['/', '/index.html', '/products.html', '/contact.html', '/shop.html', '/login.html', '/register.html', '/terms.html']) assert.equal((await get(p)).status, 200, p);
    assert.equal((await get('/nope.html')).status, 404);
  });
  test('CSP forbids inline scripts', async () => {
    const csp = (await fetch(t.base + '/index.html')).headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/); assert.ok(!/script-src[^;]*unsafe-inline/.test(csp)); assert.match(csp, /frame-ancestors 'none'/);
  });
});

describe('catalogue', () => {
  test('products expose labels, not raw inventory; quote-only items carry no stock; only active items are listed', async () => {
    const { products } = (await t.browser().get('/api/products')).body;
    const stamp = products.find((p) => p.id === 'sg-stamps'); assert.equal(stamp.stock.status, 'low_stock');
    assert.ok(!('inventory' in stamp) && !('low_stock_threshold' in stamp));
    assert.equal(products.find((p) => p.id === 'bb-static').stock, undefined);
    await AD.post('/api/admin/products/pr-cards/deactivate');
    assert.ok(!(await t.browser().get('/api/products')).body.products.some((p) => p.id === 'pr-cards'));
    assert.equal((await t.browser().get('/api/products/pr-cards')).status, 404);
    await AD.post('/api/admin/products/pr-cards/activate');
    assert.equal((await t.browser().get('/api/products/pr-cards')).status, 200);
  });
  test('search escapes wildcard characters', async () => {
    assert.equal((await t.browser().get('/api/products?q=%25')).body.products.length, 0);
    assert.ok((await t.browser().get('/api/products?q=banner')).body.products.length >= 1);
  });
});

describe('customer purchase -> EFT -> finance -> fulfilment', () => {
  let order; let item;
  test('checkout: server prices the order; forged prices/totals/extra fields are refused', async () => {
    const forged = await A.post('/api/orders', orderBody([{ product_id: 'pr-pullup', quantity: 2, unit_price: 1 }]));
    assert.equal(forged.status, 400, 'unknown field unit_price rejected');
    assert.equal((await A.post('/api/orders', { ...orderBody([{ product_id: 'pr-pullup', quantity: 1 }]), total: 1 })).status, 400);
    assert.equal((await A.post('/api/orders', { ...orderBody([{ product_id: 'pr-pullup', quantity: 1 }]), accept_terms: false })).status, 400);
    assert.equal((await A.post('/api/orders', orderBody([{ product_id: 'pr-pullup', quantity: -1 }]))).status, 400);
    assert.equal((await A.post('/api/orders', orderBody([{ product_id: 'pr-pullup', quantity: 1.5 }]))).status, 400);
    assert.equal((await A.post('/api/orders', orderBody([]))).status, 400);
    assert.equal((await A.post('/api/orders', orderBody([{ product_id: 'bb-static', quantity: 1 }]))).body.error.code, 'QUOTE_ONLY_PRODUCT');
    assert.equal((await A.post('/api/orders', orderBody([{ product_id: 'does-not-exist', quantity: 1 }]))).body.error.code, 'PRODUCT_UNAVAILABLE');
    assert.equal((await A.post('/api/orders', orderBody([{ product_id: 'pr-pullup', quantity: 999 }]))).body.error.code, 'INSUFFICIENT_STOCK');
    assert.equal((await A.post('/api/orders', { ...orderBody([{ product_id: 'pr-pullup', quantity: 1 }]), delivery_method: 'delivery' })).body.error.code, 'ADDRESS_REQUIRED');
    assert.equal((await t.browser().post('/api/orders', orderBody([{ product_id: 'pr-pullup', quantity: 1 }]))).status, 401);
  });
  test('placing an order returns the reference, totals and EFT instructions; a double-submit makes ONE order', async () => {
    await AD.put('/api/admin/settings/bank_details', { value: { bank: 'FNB Namibia', account_name: 'Nguni Marketing CC', account_number: '62000000001', branch_code: '280172' } });
    const key = 'checkout-key-1'; const body = orderBody([{ product_id: 'pr-pullup', quantity: 2 }, { product_id: 'sg-reception', quantity: 1 }]);
    const rs = await Promise.all([1, 2, 3, 4].map(() => A.req('POST', '/api/orders', { json: body, headers: { 'idempotency-key': key } })));
    assert.ok(rs.every((r) => r.status === 201 || r.status === 200), JSON.stringify(rs.map((r) => r.status)));
    const ids = new Set(rs.map((r) => r.body.order.id)); assert.equal(ids.size, 1, 'same order every time');
    order = rs.find((r) => r.status === 201).body.order; const pi = rs[0].body.payment_instructions;
    assert.match(order.order_number, /^NGU-\d{6}$/); assert.equal(order.status, 'pending_payment');
    assert.equal(Number(order.subtotal), 1650 * 2 + 2400); assert.equal(Number(order.total), 5700);
    assert.equal(pi.reference, order.order_number); assert.equal(pi.bank_details.account_number, '62000000001'); assert.equal(pi.method, 'EFT');
    assert.ok(!('idempotency_key' in order), 'internal field not exposed');
    const s = await stockOf('pr-pullup'); assert.equal(s.reserved, 2);
    assert.ok(t.outbox().some((m) => m.to === alice.email && m.subject.includes(order.order_number)), 'order email sent');
    item = order.items.find((i) => i.product_name.includes('Pull-up'));
  });
  test('only the owner can see the order; others get 404 (IDOR)', async () => {
    assert.equal((await A.get(`/api/orders/${order.id}`)).status, 200);
    assert.equal((await B.get(`/api/orders/${order.id}`)).status, 404);
    assert.equal((await B.post(`/api/orders/${order.id}/cancel`)).status, 404);
    assert.equal((await B.upload(`/api/orders/${order.id}/proof`, 'proof', PDF, 'p.pdf', 'application/pdf')).status, 404);
    assert.equal((await B.get('/api/orders')).body.orders.length, 0);
    assert.equal((await A.get('/api/orders/not-a-uuid')).status, 404);
    const mine = (await A.get(`/api/orders/${order.id}`)).body;
    assert.equal(mine.bank_details.bank, 'FNB Namibia'); assert.ok(mine.history.length >= 1); assert.equal(mine.collection_address, 'Chobe Street, Windhoek');
  });
  test('proof upload: wrong type, disguised executable, empty and oversized files are refused; nothing is stored', async () => {
    const before = t.sb.objects.size;
    assert.equal((await A.upload(`/api/orders/${order.id}/proof`, 'proof', EXE, 'virus.exe', 'application/octet-stream')).body.error.code, 'UNSUPPORTED_FILE_TYPE');
    assert.equal((await A.upload(`/api/orders/${order.id}/proof`, 'proof', EXE, 'virus.pdf', 'application/pdf')).body.error.code, 'INVALID_FILE_CONTENT');
    assert.equal((await A.upload(`/api/orders/${order.id}/proof`, 'proof', PDF, 'proof.html', 'application/pdf')).body.error.code, 'UNSUPPORTED_FILE_TYPE');
    assert.equal((await A.upload(`/api/orders/${order.id}/proof`, 'proof', Buffer.alloc(0), 'e.pdf', 'application/pdf')).status, 400);
    const big = Buffer.concat([PDF, Buffer.alloc(6 * 1024 * 1024)]);
    assert.equal((await A.upload(`/api/orders/${order.id}/proof`, 'proof', big, 'big.pdf', 'application/pdf')).body.error.code, 'FILE_TOO_LARGE');
    assert.equal(t.sb.objects.size, before);
  });
  test('valid proof moves the order to payment_submitted; finance is notified; a second upload is refused', async () => {
    const r = await A.upload(`/api/orders/${order.id}/proof`, 'proof', PDF, 'my proof (1).pdf', 'application/pdf');
    assert.equal(r.status, 200); assert.equal(r.body.order.status, 'payment_submitted');
    assert.equal((await A.upload(`/api/orders/${order.id}/proof`, 'proof', PDF, 'again.pdf', 'application/pdf')).body.error.code, 'INVALID_STATE');
    assert.equal(t.sb.objects.size > 0, true);
    const privatePaths = [...t.sb.objects.keys()].filter((k) => k.startsWith('private-files/payment-proofs/'));
    assert.ok(privatePaths.length >= 1 && privatePaths.every((p) => /\/[0-9a-f-]{36}\.pdf$/.test(p)), 'random server-chosen filenames');
  });
  test('who can see the payment queue and proof: finance + admin only', async () => {
    const q = await F.get('/api/staff/payments?status=pending'); assert.equal(q.status, 200);
    const pay = q.body.payments.find((p) => p.order_id === order.id); assert.ok(pay);
    for (const [name, br] of [['client', A], ['sales', S], ['ops', O], ['support', SU]]) {
      assert.equal((await br.get('/api/staff/payments')).status, 403, `${name} queue`);
      assert.equal((await br.get(`/api/staff/payments/${pay.id}/proof-url`)).status, 403, `${name} proof`);
      assert.equal((await br.post(`/api/staff/payments/${order.id}/confirm`, {})).status, 403, `${name} confirm`);
      assert.equal((await br.post(`/api/staff/payments/${order.id}/reject`, { reason: 'nope nope' })).status, 403, `${name} reject`);
    }
    const url = (await F.get(`/api/staff/payments/${pay.id}/proof-url`)).body.url;
    const file = await fetch(url); assert.equal(file.status, 200); assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    assert.equal((await AD.get(`/api/staff/payments/${pay.id}/proof-url`)).status, 200);
  });
  test('support/sales/ops can look an order up but see no payment references; finance does', async () => {
    const sup = (await SU.get(`/api/staff/orders/${order.id}`)).body;
    assert.equal(sup.order.order_number, order.order_number);
    assert.ok(sup.payments.every((p) => !('bank_statement_ref' in p) && !('verified_by' in p) && !('reject_reason' in p)));
    assert.ok(!('idempotency_key' in sup.order));
    assert.ok('verified_by' in (await F.get(`/api/staff/orders/${order.id}`)).body.payments[0]);
    assert.equal((await A.get(`/api/staff/orders/${order.id}`)).status, 403);
  });
  test('finance rejects with a reason -> customer sees it -> re-uploads -> finance confirms', async () => {
    assert.equal((await F.post(`/api/staff/payments/${order.id}/reject`, { reason: 'x' })).status, 400);
    const rej = await F.post(`/api/staff/payments/${order.id}/reject`, { reason: 'Amount does not match the invoice' });
    assert.equal(rej.status, 200); assert.equal(rej.body.order.status, 'payment_rejected');
    const view = (await A.get(`/api/orders/${order.id}`)).body;
    assert.equal(view.order.status, 'payment_rejected'); assert.equal(view.payments[0].reject_reason, 'Amount does not match the invoice');
    assert.ok(view.bank_details, 'bank details shown again for re-payment');
    assert.equal((await F.post(`/api/staff/payments/${order.id}/reject`, { reason: 'twice again' })).status, 409);
    assert.equal((await A.upload(`/api/orders/${order.id}/proof`, 'proof', PNG, 'proof2.png', 'image/png')).body.order.status, 'payment_submitted');
  });
  test('double-clicking Confirm confirms once, deducts stock once and fixes the order state', async () => {
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => F.post(`/api/staff/payments/${order.id}/confirm`, { bank_statement_ref: 'STMT-77' })));
    assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs.map((r) => r.status)));
    assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409 && r.body.error.code === 'ALREADY_CONFIRMED'));
    assert.equal(rs.find((r) => r.status === 200).body.order.status, 'paid');
    const s = await stockOf('pr-pullup'); assert.equal(s.onHand, 8); assert.equal(s.reserved, 0);
    const detail = (await F.get(`/api/staff/orders/${order.id}`)).body;
    assert.equal(detail.payments.find((p) => p.status === 'confirmed').bank_statement_ref, 'STMT-77');
    assert.ok(t.outbox().some((m) => m.to === alice.email && /Payment confirmed/.test(m.subject)));
  });
  test('operations moves it paid -> processing -> ready -> completed; no skipping, no one else can', async () => {
    const st = (br, status) => br.patch(`/api/staff/orders/${order.id}/status`, { status });
    assert.equal((await st(F, 'processing')).status, 403); assert.equal((await st(S, 'processing')).status, 403);
    assert.equal((await st(SU, 'processing')).status, 403); assert.equal((await st(A, 'processing')).status, 403);
    assert.equal((await st(O, 'completed')).status, 409); assert.equal((await st(O, 'paid')).status, 400);
    assert.equal((await st(O, 'processing')).body.order.status, 'processing');
    assert.equal((await st(O, 'ready')).body.order.status, 'ready');
    assert.equal((await st(O, 'completed')).body.order.status, 'completed');
    assert.equal((await st(O, 'processing')).status, 409);
    assert.equal((await A.get(`/api/orders/${order.id}`)).body.order.status, 'completed');
    assert.deepEqual((await A.get(`/api/orders/${order.id}`)).body.history.map((h) => h.status), ['pending_payment', 'payment_submitted', 'payment_rejected', 'payment_submitted', 'paid', 'processing', 'ready', 'completed']);
  });
  test('operations adjusts stock with a reason; finance, sales, support and customers cannot', async () => {
    for (const [n, br] of [['finance', F], ['sales', S], ['support', SU], ['client', A]]) {
      assert.equal((await br.post('/api/staff/stock/adjust', { product_id: 'pr-pullup', delta: 5, reason: 'restock' })).status, 403, n);
    }
    assert.equal((await O.post('/api/staff/stock/adjust', { product_id: 'pr-pullup', delta: -3, reason: 'correction' })).status, 400, 'note required for corrections');
    assert.equal((await O.post('/api/staff/stock/adjust', { product_id: 'pr-pullup', delta: 5, reason: 'order_paid' })).status, 400, 'system reasons refused');
    assert.equal((await O.post('/api/staff/stock/adjust', { product_id: 'pr-pullup', delta: -1000, reason: 'damage' })).body.error.code, 'INVALID_ADJUSTMENT');
    assert.equal((await O.post('/api/staff/stock/adjust', { product_id: 'pr-pullup', delta: -2, reason: 'damage', note: 'water damage' })).status, 200);
    assert.equal((await O.post('/api/staff/stock/adjust', { product_id: 'pr-pullup', delta: 4, reason: 'restock' })).status, 200);
    assert.equal((await stockOf('pr-pullup')).onHand, 10);
    const mv = (await O.get('/api/staff/stock/pr-pullup/movements')).body.movements;
    assert.ok(mv.some((m) => m.reason === 'damage' && m.note === 'water damage') && mv.some((m) => m.reason === 'order_paid'));
    assert.equal((await SU.get('/api/staff/stock/pr-pullup/movements')).status, 403);
  });
  test('customer can cancel only while unpaid; stock returns; cancelling twice is refused', async () => {
    const o = (await B.post('/api/orders', orderBody([{ product_id: 'pr-pullup', quantity: 3 }]))).body.order;
    assert.equal((await stockOf('pr-pullup')).reserved, 3);
    assert.equal((await B.post(`/api/orders/${o.id}/cancel`)).body.order.status, 'cancelled');
    assert.equal((await stockOf('pr-pullup')).reserved, 0);
    assert.equal((await B.post(`/api/orders/${o.id}/cancel`)).status, 409);
    assert.equal((await B.upload(`/api/orders/${o.id}/proof`, 'proof', PDF, 'p.pdf', 'application/pdf')).status, 409, 'no proof on a cancelled order');
    assert.equal((await t.supabase.storage.from('private-files').list).length >= 0, true);
  });
  test('the LAST unit: two customers race, one wins, one gets a clear message', async () => {
    const [r1, r2] = await Promise.all([A, B].map((br) => br.post('/api/orders', orderBody([{ product_id: 'sg-stamps', quantity: 1 }]))));
    const codes = [r1, r2].map((r) => r.status).sort(); assert.deepEqual(codes, [201, 409]);
    assert.equal([r1, r2].find((r) => r.status === 409).body.error.code, 'INSUFFICIENT_STOCK');
    const s = await stockOf('sg-stamps'); assert.equal(s.available, 0);
    const label = (await t.browser().get('/api/products/sg-stamps')).body.product.stock; assert.equal(label.status, 'out_of_stock');
  });
  test('staff cancel needs a reason and a paid order cancel leaves stock untouched', async () => {
    const o = (await B.post('/api/orders', orderBody([{ product_id: 'pr-pullup', quantity: 1 }]))).body.order;
    await B.upload(`/api/orders/${o.id}/proof`, 'proof', PDF, 'p.pdf', 'application/pdf'); await F.post(`/api/staff/payments/${o.id}/confirm`, {});
    const before = await stockOf('pr-pullup');
    assert.equal((await O.post(`/api/staff/orders/${o.id}/cancel`, { reason: '' })).status, 400);
    assert.equal((await F.post(`/api/staff/orders/${o.id}/cancel`, { reason: 'finance may not' })).status, 403);
    assert.equal((await O.post(`/api/staff/orders/${o.id}/cancel`, { reason: 'Customer changed their mind' })).body.order.status, 'cancelled');
    assert.deepEqual(await stockOf('pr-pullup'), before);
    assert.equal((await B.get(`/api/orders/${o.id}`)).body.order.cancel_reason, 'Customer changed their mind');
  });
  test('reorder lists which lines can go back in the cart', async () => {
    const r = (await A.get(`/api/orders/${order.id}/reorder`)).body.items;
    assert.equal(r.length, 2); assert.ok(r.every((i) => i.available));
    assert.equal((await B.get(`/api/orders/${order.id}/reorder`)).status, 404);
    assert.ok(item);
  });
  test('delivery orders need an address of your own and use the configured fee', async () => {
    const mine = (await A.post('/api/me/addresses', { label: 'Office', line1: '12 Independence Ave', town: 'Windhoek' })).body.address;
    const theirs = (await B.post('/api/me/addresses', { line1: '1 Bob St', town: 'Windhoek' })).body.address;
    await AD.put('/api/admin/settings/delivery', { value: { enabled: true, flat_fee: 120, free_over: null, note: 'Within Windhoek' } });
    const body = { ...orderBody([{ product_id: 'sg-reception', quantity: 1 }]), delivery_method: 'delivery' };
    assert.equal((await A.post('/api/orders', { ...body, address_id: theirs.id })).body.error.code, 'ADDRESS_REQUIRED');
    const ok = await A.post('/api/orders', { ...body, address_id: mine.id });
    assert.equal(ok.status, 201); assert.equal(Number(ok.body.order.delivery_fee), 120); assert.equal(Number(ok.body.order.total), 2520);
    assert.equal(ok.body.order.address_snapshot.line1, '12 Independence Ave'); assert.ok(!('profile_id' in ok.body.order.address_snapshot));
    assert.equal((await B.del(`/api/me/addresses/${mine.id}`)).status, 200);
    assert.equal((await A.get('/api/me/addresses')).body.addresses.length, 1, "Bob cannot delete Alice's address");
    await AD.put('/api/admin/settings/delivery', { value: { enabled: true, flat_fee: 0, free_over: null, note: '' } });
  });
});

describe('order expiry job', () => {
  test('rejects a bad secret; releases stock exactly once; safe to repeat', async () => {
    await AD.post('/api/staff/stock/adjust', { product_id: 'pr-flyers', delta: 5, reason: 'restock' });
    const o = (await B.post('/api/orders', orderBody([{ product_id: 'pr-flyers', quantity: 1 }]))).body.order;
    const o2 = (await B.post('/api/orders', orderBody([{ product_id: 'pr-flyers', quantity: 2 }]))).body.order;
    assert.equal((await stockOf('pr-flyers')).reserved >= 2, true);
    await t.sb.db.query("update orders set expires_at = now() - interval '1 minute' where id = any($1)", [[o.id, o2.id]]);
    const bad = await t.browser().req('POST', '/internal/jobs/expire-orders', { headers: { 'x-jobs-secret': 'wrong' }, csrf: false });
    assert.equal(bad.status, 401); assert.equal((await t.browser().req('POST', '/internal/jobs/expire-orders', { csrf: false })).status, 401);
    const run = () => t.browser().req('POST', '/internal/jobs/expire-orders', { headers: { 'x-jobs-secret': process.env.JOBS_SECRET }, csrf: false });
    const [r1, r2] = await Promise.all([run(), run()]);
    assert.equal(r1.body.orders + r2.body.orders, 2);
    assert.equal((await run()).body.orders, 0);
    assert.equal((await B.get(`/api/orders/${o.id}`)).body.order.status, 'expired');
    assert.equal((await stockOf('pr-flyers')).reserved, 0);
  });
});

describe('inactive accounts & robustness', () => {
  test('a deactivated user is locked out immediately, even with a live session', async () => {
    const u = await t.makeUser(); const b = await t.login(u);
    assert.equal((await b.get('/api/orders')).status, 200);
    assert.equal((await AD.patch(`/api/admin/users/${u.id}`, { is_active: false })).status, 200);
    const r = await b.get('/api/orders'); assert.equal(r.status, 401); assert.equal(r.body.error.code, 'ACCOUNT_INACTIVE');
    assert.equal((await t.browser().post('/api/auth/login', { email: u.email, password: u.password })).body.error.code, 'ACCOUNT_INACTIVE');
    assert.equal((await (await fetch(t.base + '/account.html', { redirect: 'manual', headers: { cookie: b.cookieHeader } })).status), 302);
  });
  test('malformed JSON, huge bodies, bad UUIDs and unknown routes fail cleanly (no stack traces)', async () => {
    assert.equal((await A.req('POST', '/api/orders', { raw: '{"items": [' })).body.error.code, 'MALFORMED_JSON');
    assert.equal((await A.req('POST', '/api/orders', { raw: JSON.stringify({ items: [], x: 'a'.repeat(200000) }) })).status, 413);
    assert.equal((await A.get('/api/orders/%27%3B%20drop%20table%20orders%3B--')).status, 404);
    assert.equal((await A.get('/api/does-not-exist')).status, 404);
    const e = await A.post('/api/orders', orderBody([{ product_id: "x'); drop table products;--", quantity: 1 }]));
    assert.ok([400, 409].includes(e.status)); assert.ok(!JSON.stringify(e.body).match(/sql|postgres|supabase|stack|at \w+ \(/i));
    assert.equal((await t.sb.db.query('select count(*)::int c from products')).rows[0].c, 18);
  });
  test('CSRF: state-changing requests without a valid token are refused', async () => {
    assert.equal((await A.post('/api/orders', orderBody([{ product_id: 'pr-pullup', quantity: 1 }]), { csrf: false })).status, 403);
    assert.equal((await A.post('/api/orders', orderBody([{ product_id: 'pr-pullup', quantity: 1 }]), { csrf: false, headers: { 'x-csrf-token': 'forged' } })).status, 403);
    assert.equal((await A.post('/api/auth/logout', {}, { csrf: false })).status, 403);
  });
  test('XSS payloads are stored as inert text and returned as JSON strings', async () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const r = await A.patch('/api/auth/me', { fullName: payload });
    assert.equal(r.body.user.fullName, payload); assert.match(r.headers.get('content-type'), /application\/json/);
    await A.patch('/api/auth/me', { fullName: 'Alice Smith' });
  });
});
