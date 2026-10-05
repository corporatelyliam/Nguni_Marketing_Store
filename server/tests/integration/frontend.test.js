// Frontend tests: the REAL pages and scripts run in jsdom against the REAL server/database.
// (jsdom does not enforce CSP; inline-script/handler absence is guaranteed separately by `npm run check`.)
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { boot, PDF } = require('../support/app');
const { openPage } = require('../support/dom');

let t; let admin; let finance; let alice; let sales; let support;
let AD; let F; let A; let S; let SU;
const orderBody = (items) => ({ items, delivery_method: 'collection', accept_terms: true });
const clean = (page) => assert.deepEqual(page.errors, [], 'no script errors on the page');

before(async () => {
  t = await boot('nguni_test_frontend');
  [admin, finance, alice, sales, support] = await Promise.all([t.makeUser({ role: 'admin', name: 'Ada Admin' }), t.makeUser({ role: 'employee', department: 'finance', name: 'Fin Ance' }), t.makeUser({ name: 'Alice Customer' }),
    t.makeUser({ role: 'employee', department: 'sales', name: 'Sam Sales' }), t.makeUser({ role: 'support', name: 'Sue Support' })]);
  [AD, F, A, S, SU] = await Promise.all([admin, finance, alice, sales, support].map((u) => t.login(u)));
  await AD.post('/api/staff/stock/adjust', { product_id: 'pr-pullup', delta: 10, reason: 'restock' });
  await AD.post('/api/staff/stock/adjust', { product_id: 'pr-cards', delta: 1, reason: 'restock' });
  await AD.put('/api/admin/settings/bank_details', { value: { bank: 'FNB', account_name: 'Nguni', account_number: '62000', branch_code: '280' } });
  await AD.put('/api/admin/settings/notifications', { value: { finance_email: 'fin@nguni.test', sales_email: '', support_email: '', contact_email: 'hello@nguni.test' } });
});
after(async () => { await t.stop(); });

describe('public pages', () => {
  test('home, products, contact, login, register, forgot/reset password load without errors', async () => {
    for (const p of ['/index.html', '/products.html', '/contact.html', '/login.html', '/register.html', '/forgot-password.html', '/reset-password.html?token=abc', '/terms.html', '/404.html']) {
      const pg = await openPage(t, t.browser(), p); await new Promise((r) => setTimeout(r, 120)); clean(pg); pg.close();
    }
  });
  test('products page tabs switch (their script used to be an inline block the CSP would have blocked)', async () => {
    const pg = await openPage(t, t.browser(), '/products.html');
    const tabs = pg.$$('.tab-btn'); assert.ok(tabs.length >= 5);
    pg.click(tabs[2]); assert.ok(tabs[2].classList.contains('active'));
    assert.ok(pg.$('#panel-' + tabs[2].dataset.tab).classList.contains('active')); clean(pg); pg.close();
  });
  test('contact form really sends the message (no more demo toast)', async () => {
    const pg = await openPage(t, t.browser(), '/contact.html');
    pg.type(pg.$('#cName'), 'Jo Visitor'); pg.type(pg.$('#cEmail'), 'jo@example.com'); pg.type(pg.$('#cMessage'), 'Please quote for three signs.');
    pg.submit(pg.$('#contactForm'));
    await pg.until(() => /Thank you/.test(pg.$('#contactAlert').textContent));
    const row = (await t.sb.db.query("select * from contact_messages where email='jo@example.com'")).rows[0]; assert.equal(row.message, 'Please quote for three signs.');
    assert.ok(t.outbox().some((m) => m.to === 'hello@nguni.test' && /Jo Visitor/.test(m.subject)), 'staff were emailed');
    pg.type(pg.$('#cName'), 'X'); pg.submit(pg.$('#contactForm')); assert.match(pg.$('#contactAlert').textContent, /valid email/); clean(pg); pg.close();
  });
  test('login form: wrong password shows the error; right password heads to the role home; ?next= to other sites is ignored', async () => {
    const pg = await openPage(t, t.browser(), '/login.html?next=' + encodeURIComponent('https://evil.example'));
    pg.type(pg.$('#email'), alice.email); pg.type(pg.$('#password'), 'wrong'); pg.submit(pg.$('#loginForm'));
    await pg.until(() => /Incorrect email or password/.test(pg.$('#alertBox').textContent));
    pg.type(pg.$('#password'), alice.password); pg.submit(pg.$('#loginForm'));
    await pg.until(() => pg.navigations.length >= 1); clean(pg);
    assert.ok(!pg.$('#alertBox').textContent.includes('Incorrect')); pg.close();
  });
});

describe('shop & checkout in the browser', () => {
  test('shop lists the catalogue with correct badges, quote items link to the quote form, and add-to-cart works', async () => {
    const pg = await openPage(t, A, '/shop.html');
    await pg.until(() => pg.$$('.p-card').length === 18);
    assert.match(pg.text(), /Get a quote/); // quote-only product with no price
    const quoteBtn = pg.$$('.p-card').find((c) => /3D illuminated/.test(c.textContent)).querySelector('a'); assert.match(quoteBtn.getAttribute('href'), /quote\.html\?product=sg-illuminated/);
    const stamps = pg.$$('.p-card').find((c) => /Self-inking/.test(c.textContent)); assert.match(stamps.textContent, /Out of stock/); assert.ok(stamps.querySelector('button[data-add]').disabled);
    const pull = pg.$$('.p-card').find((c) => /Pull-up/.test(c.textContent)); pg.click(pull.querySelector('[data-add]')); pg.click(pull.querySelector('[data-add]'));
    assert.equal(pg.$('#cartCount').textContent, '(2)'); assert.ok(pg.$$('[data-fav]').length > 0, 'signed-in customers can save favourites');
    pg.click(pg.$$('[data-fav]')[0]); await pg.until(() => (pg.$$('[data-fav]')[0].textContent === '♥')); clean(pg); pg.close();
  });
  test('stale cart lines are removed with a message instead of breaking checkout', async () => {
    const cart = [{ product_id: 'pr-pullup', quantity: 2 }, { product_id: 'ghost-product', quantity: 1 }, { product_id: 'bb-static', quantity: 1 }, { product_id: 'pr-cards', quantity: 50 }];
    const pg = await openPage(t, A, '/checkout.html', { local: { nguni_cart_v1: cart } });
    await pg.until(() => /no longer available/.test(pg.$('#alertBox').textContent));
    const left = JSON.parse(pg.w.localStorage.getItem('nguni_cart_v1')); assert.deepEqual(left, [{ product_id: 'pr-pullup', quantity: 2 }, { product_id: 'pr-cards', quantity: 1 }]);
    assert.match(pg.$('#summaryTotal').textContent, /4,080\.00/); clean(pg); pg.close();
  });
  test('checkout places ONE order even if the button is clicked repeatedly, then goes to the order page', async () => {
    await AD.put('/api/admin/settings/delivery', { value: { enabled: true, flat_fee: 75, free_over: null, note: 'Windhoek only' } });
    const pg = await openPage(t, A, '/checkout.html', { local: { nguni_cart_v1: [{ product_id: 'pr-pullup', quantity: 2 }] } });
    await pg.until(() => /3,?300/.test(pg.$('#summaryTotal').textContent));
    pg.type(pg.$('#deliveryMethod'), 'delivery'); await pg.until(() => /3,?375/.test(pg.$('#summaryTotal').textContent)); assert.match(pg.$('#deliveryNote').textContent, /Windhoek only/);
    pg.type(pg.$('#deliveryMethod'), 'collection');
    pg.click(pg.$('#placeOrderBtn')); await new Promise((r) => setTimeout(r, 30)); assert.match(pg.$('#alertBox').textContent, /accept the Terms/);
    pg.$('#acceptTerms').checked = true;
    const before = (await t.sb.db.query('select count(*)::int c from orders')).rows[0].c;
    pg.click(pg.$('#placeOrderBtn')); pg.click(pg.$('#placeOrderBtn')); pg.click(pg.$('#placeOrderBtn'));
    await pg.until(() => pg.navigations.length >= 1); clean(pg);
    assert.equal((await t.sb.db.query('select count(*)::int c from orders')).rows[0].c, before + 1);
    assert.equal(JSON.parse(pg.w.localStorage.getItem('nguni_cart_v1')).length, 0, 'cart cleared only after success'); pg.close();
    await AD.put('/api/admin/settings/delivery', { value: { enabled: true, flat_fee: 0, free_over: null, note: '' } });
  });
});

describe('order page: payment, rejection reason, history', () => {
  let order;
  test('shows EFT instructions, then the finance rejection reason after a rejected proof', async () => {
    order = (await A.post('/api/orders', orderBody([{ product_id: 'pr-pullup', quantity: 1 }]))).body.order;
    let pg = await openPage(t, A, '/order.html?id=' + order.id);
    await pg.until(() => /Pay by EFT/.test(pg.text())); assert.match(pg.text(), new RegExp(order.order_number)); assert.match(pg.text(), /62000/); assert.ok(pg.$('#uploadBtn')); assert.ok(pg.$('#cancelBtn')); assert.ok(!/TBD/.test(pg.text())); clean(pg); pg.close();
    await A.upload(`/api/orders/${order.id}/proof`, 'proof', PDF, 'p.pdf', 'application/pdf');
    pg = await openPage(t, A, '/order.html?id=' + order.id); await pg.until(() => /Payment under review/.test(pg.text())); pg.close();
    await F.post(`/api/staff/payments/${order.id}/reject`, { reason: 'Reference was missing from the deposit' });
    pg = await openPage(t, A, '/order.html?id=' + order.id);
    await pg.until(() => /Payment could not be verified/.test(pg.text()));
    assert.match(pg.text(), /Reference was missing from the deposit/, 'customer sees the real rejection reason (it used to read a column that was never written)');
    assert.ok(pg.$('#uploadBtn')); assert.match(pg.text(), /Progress/); clean(pg); pg.close();
  });
  test("another customer opening someone else's order sees a clean 'not found'", async () => {
    const bob = await t.login(await t.makeUser({ name: 'Bob' }));
    const pg = await openPage(t, bob, '/order.html?id=' + order.id); await pg.until(() => /could not find that order/.test(pg.$('#alertBox').textContent)); assert.ok(!pg.text().includes(order.order_number)); pg.close();
  });
});

describe('staff dashboards', () => {
  test('finance: the review dialog needs an explicit click; closing it does NOT confirm (old prompt() bug); Confirm then works', async () => {
    const o = (await A.post('/api/orders', orderBody([{ product_id: 'pr-pullup', quantity: 1 }]))).body.order;
    await A.upload(`/api/orders/${o.id}/proof`, 'proof', PDF, 'p.pdf', 'application/pdf');
    const pg = await openPage(t, F, '/staff/index.html');
    await pg.until(() => pg.$$('.tab-btn').length >= 1); assert.deepEqual(pg.$$('.tab-btn').map((b) => b.textContent), ['Payments', 'Orders', 'Inventory'], 'finance sees only finance tabs');
    await pg.until(() => pg.$$('[data-review]').length >= 1);
    pg.click(pg.$$('[data-review]').find((b) => b.dataset.order === o.id));
    await pg.until(() => pg.$('.modal') && /Confirm payment/.test(pg.$('.modal').textContent));
    await pg.until(() => /Open proof/.test(pg.$('#proofBox').textContent));
    pg.click(pg.$('.modal-close'));                       // dismiss: nothing may happen
    assert.equal((await t.sb.db.query('select status from orders where id=$1', [o.id])).rows[0].status, 'payment_submitted');
    pg.click(pg.$$('[data-review]').find((b) => b.dataset.order === o.id));
    await pg.until(() => pg.$('.modal'));
    pg.type(pg.$('#bankRef'), 'STMT-9');
    const confirmBtn = [...pg.$$('.modal-foot button')].find((b) => /Confirm payment/.test(b.textContent)); pg.click(confirmBtn); pg.click(confirmBtn);
    await pg.until(() => /Payment confirmed for/.test(pg.$('#alertBox').textContent));
    const row = (await t.sb.db.query('select status from orders where id=$1', [o.id])).rows[0]; assert.equal(row.status, 'paid');
    assert.equal((await t.sb.db.query("select bank_statement_ref from payments where order_id=$1 and status='confirmed'", [o.id])).rows[0].bank_statement_ref, 'STMT-9'); clean(pg); pg.close();
  });
  test('rejecting needs a reason in the dialog', async () => {
    const o = (await A.post('/api/orders', orderBody([{ product_id: 'pr-pullup', quantity: 1 }]))).body.order;
    await A.upload(`/api/orders/${o.id}/proof`, 'proof', PDF, 'p.pdf', 'application/pdf');
    const pg = await openPage(t, F, '/staff/index.html'); await pg.until(() => pg.$$('[data-review]').length >= 1);
    pg.click(pg.$$('[data-review]').find((b) => b.dataset.order === o.id)); await pg.until(() => pg.$('.modal'));
    const rej = [...pg.$$('.modal-foot button')].find((b) => /Reject payment/.test(b.textContent)); pg.click(rej);
    await pg.until(() => /rejection reason/.test(pg.$('.modal').textContent)); assert.equal((await t.sb.db.query('select status from orders where id=$1', [o.id])).rows[0].status, 'payment_submitted');
    pg.type(pg.$('#rejectReason'), 'Wrong amount deposited'); pg.click(rej);
    await pg.until(() => /Payment rejected/.test(pg.$('#alertBox').textContent)); assert.equal((await t.sb.db.query('select status from orders where id=$1', [o.id])).rows[0].status, 'payment_rejected'); clean(pg); pg.close();
  });
  test('sales sees quote requests; support sees tickets; neither sees payments', async () => {
    let pg = await openPage(t, S, '/staff/index.html'); await pg.until(() => pg.$$('.tab-btn').length); assert.deepEqual(pg.$$('.tab-btn').map((b) => b.textContent), ['Quote requests', 'Orders']); clean(pg); pg.close();
    pg = await openPage(t, SU, '/staff/index.html'); await pg.until(() => pg.$$('.tab-btn').length); assert.deepEqual(pg.$$('.tab-btn').map((b) => b.textContent), ['Support tickets', 'Orders', 'Quote requests']); clean(pg); pg.close();
  });
  test('a staff member can still use the customer pages (no redirect loop)', async () => {
    const pg = await openPage(t, F, '/account.html'); await pg.until(() => /Welcome, Fin Ance/.test(pg.text()));
    assert.ok(pg.$('#dashLink').style.display !== 'none'); assert.equal(pg.navigations.length, 0); clean(pg); pg.close();
  });
});

describe('quotes & support in the account area', () => {
  test('customer sees the issued quote, chooses delivery details and accepts: order is created at the quoted price', async () => {
    const r = (await A.post('/api/quote-requests', { title: 'Shopfront sign', description: 'Lit sign', specs: { width: 3, height: 1, unit: 'm', quantity: 1 } })).body.quote_request;
    await S.post(`/api/staff/quote-requests/${r.id}/quote`, { amount: 8800, notes: 'Includes fitting', valid_until: new Date(Date.now() + 5 * 864e5).toISOString() });
    const pg = await openPage(t, A, '/account.html#quotes');
    await pg.until(() => /Quoted amount/.test(pg.text())); assert.match(pg.text(), /8,800\.00/); assert.match(pg.text(), /Includes fitting/);
    pg.click(pg.$('[data-accept]')); const form = pg.$('.accept-form'); assert.notEqual(form.style.display, 'none');
    pg.click(pg.$('[data-confirm]')); await pg.until(() => pg.navigations.length >= 1); clean(pg);
    const o = (await t.sb.db.query("select total, delivery_method from orders where quote_id is not null order by created_at desc limit 1")).rows[0]; assert.equal(Number(o.total), 8800); assert.equal(o.delivery_method, 'collection'); pg.close();
  });
  test('orders tab, support list and ticket thread (customer never sees internal notes)', async () => {
    const tk = (await A.post('/api/tickets', { category: 'general', subject: 'Opening hours?', body: 'When are you open?' })).body.ticket;
    await SU.post(`/api/staff/tickets/${tk.id}/messages`, { body: 'We open at 8.' }); await SU.post(`/api/staff/tickets/${tk.id}/messages`, { body: 'INTERNAL-ONLY remark', is_internal_note: true });
    let pg = await openPage(t, A, '/account.html'); await pg.until(() => /NGU-\d{6}/.test(pg.$('#ordersList').textContent)); assert.ok(pg.$$('#ordersList a').length >= 1); clean(pg); pg.close();
    pg = await openPage(t, A, '/support.html'); await pg.until(() => /Opening hours/.test(pg.text()));
    pg.click(pg.$('tr[data-id]')); await pg.until(() => /We open at 8/.test(pg.$('#ticketThread').textContent));
    assert.ok(!pg.text().includes('INTERNAL-ONLY')); assert.match(pg.$('#ticketThread').textContent, /Nguni support/); clean(pg); pg.close();
  });
});

describe('admin dashboard', () => {
  test('dashboard shows live numbers and setup warnings; all eleven tabs render without errors', async () => {
    const pg = await openPage(t, AD, '/admin/index.html');
    await pg.until(() => pg.$$('.stat').length >= 10); assert.match(pg.$('#tab-dashboard').textContent, /Payments to verify/);
    assert.deepEqual(pg.$$('.tab-btn').map((b) => b.textContent), ['Dashboard', 'Products', 'Inventory', 'Orders', 'Payments', 'Quotes', 'Tickets', 'Users & staff', 'Settings', 'Website messages', 'Audit log']);
    for (const b of pg.$$('.tab-btn').slice(1)) { pg.click(b); await new Promise((r) => setTimeout(r, 150)); }
    await pg.until(() => pg.$('#tab-audit table')); await pg.until(() => pg.$('#tab-users table')); await pg.until(() => pg.$('#tab-settings [data-save]')); clean(pg); pg.close();
  });
  test('edit a product price and add staff through the real forms', async () => {
    const pg = await openPage(t, AD, '/admin/index.html#products'); await pg.until(() => pg.$$('[data-edit]').length >= 18);
    const row = pg.$$('#tab-products tr').find((r) => /pr-pullup/.test(r.textContent)); pg.click(row.querySelector('[data-edit]'));
    await pg.until(() => pg.$('#pPrice')); pg.type(pg.$('#pPrice'), '1700'); pg.click([...pg.$$('.modal-foot button')].find((b) => /Save changes/.test(b.textContent)));
    await pg.until(() => /Price changed from N\$1,650\.00 to N\$1,700\.00/.test(pg.$('#alertBox').textContent));
    assert.equal(Number((await t.sb.db.query("select price from products where id='pr-pullup'")).rows[0].price), 1700);
    pg.click(pg.$$('.tab-btn').find((b) => b.dataset.tab === 'users')); await pg.until(() => pg.$('#newStaff')); pg.click(pg.$('#newStaff')); await pg.until(() => pg.$('#sName'));
    pg.type(pg.$('#sName'), 'New Finance'); pg.type(pg.$('#sEmail'), 'newfin@test.local'); pg.type(pg.$('#sPw'), 'Passw0rd!x'); pg.type(pg.$('#sRole'), 'employee'); pg.type(pg.$('#sDept'), 'finance');
    pg.click([...pg.$$('.modal-foot button')].find((b) => /Create account/.test(b.textContent))); await pg.until(() => /Staff account created/.test(pg.$('#alertBox').textContent));
    assert.equal((await t.sb.db.query("select role, department from profiles p join auth.users u on u.id=p.id where u.email='newfin@test.local'")).rows[0].department, 'finance'); clean(pg); pg.close();
  });
  test('saving settings from the form validates and persists', async () => {
    const pg = await openPage(t, AD, '/admin/index.html#settings'); await pg.until(() => pg.$('#oHours'));
    pg.type(pg.$('#oHours'), '-4'); pg.click(pg.$$('[data-save="orders"]')[0]); await pg.until(() => /not valid for this setting/.test(pg.$('#alertBox').textContent));
    pg.type(pg.$('#oHours'), '36'); pg.click(pg.$$('[data-save="orders"]')[0]); await pg.until(() => /Settings saved/.test(pg.$('#alertBox').textContent));
    assert.equal((await t.sb.db.query("select value from settings where key='order_expiry_hours'")).rows[0].value, 36); clean(pg); pg.close();
  });
});
