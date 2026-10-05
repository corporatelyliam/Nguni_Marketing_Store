const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { boot, PDF, PNG, JPG, EXE } = require('../support/app');

let t; let admin; let finance; let sales; let ops; let support; let alice; let bob; let support2;
let A; let B; let F; let S; let O; let SU; let AD; let SU2;

before(async () => {
  t = await boot('nguni_test_api_qta');
  [admin, finance, sales, ops, support, support2, alice, bob] = await Promise.all([
    t.makeUser({ role: 'admin' }), t.makeUser({ role: 'employee', department: 'finance' }), t.makeUser({ role: 'employee', department: 'sales', name: 'Sam Sales' }),
    t.makeUser({ role: 'employee', department: 'operations' }), t.makeUser({ role: 'support', name: 'Sue Support' }), t.makeUser({ role: 'support', name: 'Other Support' }),
    t.makeUser({ name: 'Alice' }), t.makeUser({ name: 'Bob' }),
  ]);
  [AD, F, S, O, SU, SU2, A, B] = await Promise.all([admin, finance, sales, ops, support, support2, alice, bob].map((u) => t.login(u)));
});
after(async () => { await t.stop(); });

const future = (days = 7) => new Date(Date.now() + days * 864e5).toISOString();

describe('quotes: request -> sales -> quote -> accept -> order -> EFT', () => {
  let request; let quote; let order;
  test('customer submits a request with measurements and an attachment (validated)', async () => {
    assert.equal((await A.post('/api/quote-requests', { title: 'x' })).status, 400);
    assert.equal((await A.post('/api/quote-requests', { title: 'Shop sign', product_id: 'nope' })).body.error.code, 'INVALID_PRODUCT');
    assert.equal((await A.post('/api/quote-requests', { title: 'Shop sign', specs: { width: -5 } })).status, 400);
    assert.equal((await A.post('/api/quote-requests', { title: 'Shop sign', status: 'closed' })).status, 400, 'no mass assignment');
    const r = await A.post('/api/quote-requests', { title: 'Illuminated shop sign', description: 'Front of our store', product_id: 'sg-illuminated', specs: { width: 2400, height: 600, unit: 'mm', quantity: 1, notes: 'warm white' } });
    assert.equal(r.status, 201); request = r.body.quote_request; assert.equal(request.status, 'submitted');
    assert.equal((await A.upload(`/api/quote-requests/${request.id}/attachments`, 'file', EXE, 'a.pdf', 'application/pdf')).status, 400);
    const up = await A.upload(`/api/quote-requests/${request.id}/attachments`, 'file', PDF, 'artwork.pdf', 'application/pdf'); assert.equal(up.status, 201);
    assert.equal((await B.upload(`/api/quote-requests/${request.id}/attachments`, 'file', PDF, 'x.pdf', 'application/pdf')).status, 404);
  });
  test('sales/admin/support can read it; support is read-only; clients cannot use staff routes; attachments open via signed URL', async () => {
    for (const br of [S, SU, AD]) assert.equal((await br.get('/api/staff/quote-requests')).status, 200);
    assert.equal((await F.get('/api/staff/quote-requests')).status, 403); assert.equal((await O.get('/api/staff/quote-requests')).status, 403);
    assert.equal((await B.get('/api/staff/quote-requests')).status, 403);
    const d = (await S.get(`/api/staff/quote-requests/${request.id}`)).body;
    assert.equal(d.quote_request.specs.width, 2400); assert.equal(d.attachments.length, 1);
    assert.equal(Buffer.from(await (await fetch(d.attachments[0].url)).arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    assert.equal((await SU.patch(`/api/staff/quote-requests/${request.id}`, { status: 'in_review' })).status, 403, 'support cannot modify');
    assert.equal((await SU.post(`/api/staff/quote-requests/${request.id}/quote`, { amount: 1, valid_until: future() })).status, 403);
  });
  test('sales assigns (only to sales staff) and moves it to in_review', async () => {
    assert.equal((await S.patch(`/api/staff/quote-requests/${request.id}`, { assigned_to: support.id })).body.error.code, 'INVALID_ASSIGNEE');
    const r = await S.patch(`/api/staff/quote-requests/${request.id}`, { assigned_to: sales.id, status: 'in_review' });
    assert.equal(r.body.quote_request.assigned_to, sales.id); assert.equal(r.body.quote_request.status, 'in_review');
  });
  test('issuing validates amount/validity, notifies the customer, and a re-issue supersedes the old quote', async () => {
    assert.equal((await S.post(`/api/staff/quote-requests/${request.id}/quote`, { amount: 0, valid_until: future() })).status, 400);
    assert.equal((await S.post(`/api/staff/quote-requests/${request.id}/quote`, { amount: 100, valid_until: future(-1) })).body.error.code, 'INVALID_VALIDITY');
    assert.equal((await S.post(`/api/staff/quote-requests/${request.id}/quote`, { amount: 100, valid_until: 'tomorrow' })).status, 400);
    const q1 = (await S.post(`/api/staff/quote-requests/${request.id}/quote`, { amount: 9000, notes: 'first', valid_until: future() })).body.quote;
    const q2 = (await S.post(`/api/staff/quote-requests/${request.id}/quote`, { amount: 12345.67, notes: 'Includes install', valid_until: future(14) }));
    assert.equal(q2.status, 201); quote = q2.body.quote;
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(t.outbox().some((m) => m.to === alice.email && /quote .* is ready/i.test(m.subject)), 'customer emailed the quote');
    const mine = (await A.get('/api/quote-requests')).body.quote_requests.find((r) => r.id === request.id);
    assert.equal(mine.status, 'quoted'); assert.equal(mine.quotes.find((q) => q.id === q1.id).status, 'expired');
    assert.ok(mine.quotes.every((q) => !('prepared_by' in q)), 'staff identity not exposed');
    assert.equal(mine.files.length, 1);
  });
  test("another customer cannot see, accept or decline someone else's quote", async () => {
    assert.equal((await B.get(`/api/quote-requests/${request.id}`)).status, 404);
    assert.equal((await B.post(`/api/quotes/${quote.id}/accept`, { delivery_method: 'collection' })).status, 404);
    assert.equal((await B.post(`/api/quotes/${quote.id}/decline`)).status, 404);
    assert.equal((await A.post(`/api/quotes/not-a-uuid/accept`, { delivery_method: 'collection' })).status, 404);
    assert.equal((await A.post(`/api/quotes/${quote.id}/accept`, { delivery_method: 'collection', amount: 1 })).status, 400, 'cannot send an amount');
    assert.equal((await A.post(`/api/quotes/${quote.id}/accept`, {})).status, 400);
  });
  test('accepting (double-click) creates ONE order at the quoted amount, not a catalogue price', async () => {
    const rs = await Promise.all([1, 2, 3].map(() => A.post(`/api/quotes/${quote.id}/accept`, { delivery_method: 'collection', notes: 'Please call first' })));
    assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs.map((r) => r.status)));
    assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.body.error.code === 'QUOTE_NOT_OPEN'));
    order = rs.find((r) => r.status === 200).body.order;
    assert.equal(Number(order.total), 12345.67); assert.equal(order.status, 'pending_payment'); assert.match(order.items[0].product_name, /Illuminated shop sign/);
    assert.equal((await A.get('/api/quote-requests')).body.quote_requests.find((r) => r.id === request.id).status, 'closed');
    assert.equal((await t.sb.db.query('select count(*)::int c from orders where quote_id=$1', [quote.id])).rows[0].c, 1);
  });
  test('the quote order follows the normal EFT flow through to completion', async () => {
    assert.equal((await A.upload(`/api/orders/${order.id}/proof`, 'proof', JPG, 'p.jpg', 'image/jpeg')).body.order.status, 'payment_submitted');
    assert.equal((await F.post(`/api/staff/payments/${order.id}/confirm`, { bank_statement_ref: 'Q-1' })).body.order.status, 'paid');
    for (const s of ['processing', 'ready', 'completed']) assert.equal((await O.patch(`/api/staff/orders/${order.id}/status`, { status: s })).body.order.status, s);
  });
  test('declining closes the request; expired quotes cannot be accepted; the sweep returns the request to sales', async () => {
    const r = (await B.post('/api/quote-requests', { title: 'Decline me' })).body.quote_request;
    const q = (await S.post(`/api/staff/quote-requests/${r.id}/quote`, { amount: 500, valid_until: future() })).body.quote;
    assert.equal((await B.post(`/api/quotes/${q.id}/decline`)).body.declined, true);
    assert.equal((await B.post(`/api/quotes/${q.id}/accept`, { delivery_method: 'collection' })).body.error.code, 'QUOTE_NOT_OPEN');
    const r2 = (await B.post('/api/quote-requests', { title: 'Expire me' })).body.quote_request;
    const q2 = (await S.post(`/api/staff/quote-requests/${r2.id}/quote`, { amount: 700, valid_until: future() })).body.quote;
    await t.sb.db.query("update quotes set valid_until = now() - interval '1 hour' where id=$1", [q2.id]);
    assert.equal((await B.post(`/api/quotes/${q2.id}/accept`, { delivery_method: 'collection' })).body.error.code, 'QUOTE_EXPIRED');
    await t.browser().req('POST', '/internal/jobs/expire-orders', { headers: { 'x-jobs-secret': process.env.JOBS_SECRET }, csrf: false });
    assert.equal((await S.get(`/api/staff/quote-requests/${r2.id}`)).body.quote_request.status, 'in_review');
  });
});

describe('support tickets', () => {
  let ticket; let orderId;
  test('customer opens a ticket (optionally about their own order only)', async () => {
    orderId = (await A.get('/api/orders')).body.orders[0].id;
    assert.equal((await A.post('/api/tickets', { category: 'order', subject: 'Where is it', body: 'Help', order_id: (await B.get('/api/orders')).body.orders[0]?.id || '00000000-0000-4000-8000-000000000000' })).status, 400, "someone else's order");
    assert.equal((await A.post('/api/tickets', { category: 'bogus', subject: 'x y z', body: 'b' })).status, 400);
    const r = await A.post('/api/tickets', { category: 'order', subject: 'Question about my order', body: 'When will it be ready?', order_id: orderId });
    assert.equal(r.status, 201); ticket = r.body.ticket; assert.match(ticket.ticket_number, /^TCK-\d{5}$/); assert.equal(ticket.status, 'open');
  });
  test('only support/admin can work tickets; customers see only their own', async () => {
    for (const [n, br] of [['finance', F], ['sales', S], ['ops', O], ['client', A]]) assert.equal((await br.get('/api/staff/tickets')).status, 403, n);
    assert.equal((await SU.get('/api/staff/tickets')).body.tickets.length >= 1, true);
    assert.equal((await B.get(`/api/tickets/${ticket.id}`)).status, 404);
    assert.equal((await B.post(`/api/tickets/${ticket.id}/messages`, { body: 'hi' })).status, 404);
    assert.equal((await B.get('/api/tickets')).body.tickets.length, 0);
    const d = (await SU.get(`/api/staff/tickets/${ticket.id}`)).body; assert.equal(d.order.id, orderId);
    assert.ok(!('payments' in d.order), 'ticket order lookup carries no payment data');
  });
  test('staff reply is visible; internal notes NEVER reach the customer', async () => {
    assert.equal((await SU.post(`/api/staff/tickets/${ticket.id}/messages`, { body: 'It is ready tomorrow.' })).status, 201);
    assert.equal((await SU.post(`/api/staff/tickets/${ticket.id}/messages`, { body: 'SECRET: customer is a VIP, discount ok', is_internal_note: true })).status, 201);
    const view = (await A.get(`/api/tickets/${ticket.id}`)).body;
    assert.deepEqual(view.messages.map((m) => m.body), ['When will it be ready?', 'It is ready tomorrow.']);
    assert.ok(!JSON.stringify(view).includes('SECRET')); assert.ok(!JSON.stringify(view).includes(support.id), 'no staff ids exposed');
    assert.equal(view.messages.filter((m) => m.mine).length, 1);
    assert.equal((await SU.get(`/api/staff/tickets/${ticket.id}`)).body.messages.filter((m) => m.is_internal_note).length, 1);
    assert.equal((await A.post(`/api/tickets/${ticket.id}/messages`, { body: 'note', is_internal_note: true })).status, 400, 'customers cannot post notes');
    assert.equal((await t.sb.db.query("select count(*)::int c from ticket_messages where ticket_id=$1 and is_internal_note", [ticket.id])).rows[0].c, 1);
    assert.equal((await SU.get(`/api/staff/tickets/${ticket.id}`)).body.ticket.status, 'in_progress');
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(t.outbox().some((m) => m.to === alice.email && /New reply/.test(m.subject)));
  });
  test('assign (support/admin only), status changes, customer reply reopens, closing blocks replies', async () => {
    assert.equal((await SU.patch(`/api/staff/tickets/${ticket.id}`, { assigned_to: alice.id })).body.error.code, 'INVALID_ASSIGNEE');
    assert.equal((await SU.patch(`/api/staff/tickets/${ticket.id}`, { assigned_to: support2.id })).body.ticket.assigned_to, support2.id);
    assert.equal((await SU.patch(`/api/staff/tickets/${ticket.id}`, { status: 'bogus' })).status, 400);
    assert.equal((await SU.patch(`/api/staff/tickets/${ticket.id}`, { status: 'waiting_client' })).body.ticket.status, 'waiting_client');
    await A.post(`/api/tickets/${ticket.id}/messages`, { body: 'Thanks, any update?' });
    assert.equal((await SU.get(`/api/staff/tickets/${ticket.id}`)).body.ticket.status, 'in_progress', 'customer reply reopens');
    assert.equal((await SU.patch(`/api/staff/tickets/${ticket.id}`, { status: 'resolved' })).body.ticket.status, 'resolved');
    assert.equal((await SU.patch(`/api/staff/tickets/${ticket.id}`, { status: 'closed' })).body.ticket.status, 'closed');
    assert.equal((await A.post(`/api/tickets/${ticket.id}/messages`, { body: 'hello?' })).body.error.code, 'TICKET_CLOSED');
    assert.equal((await SU.post(`/api/staff/tickets/${ticket.id}/messages`, { body: 'late' })).status, 409);
    assert.equal((await SU2.get('/api/staff/support-users')).body.users.length >= 3, true);
  });
  test('customer can close their own ticket', async () => {
    const tk = (await B.post('/api/tickets', { category: 'general', subject: 'Opening hours', body: 'When do you open?' })).body.ticket;
    assert.equal((await B.post(`/api/tickets/${tk.id}/close`)).body.ticket.status, 'closed');
    assert.equal((await A.post(`/api/tickets/${tk.id}/close`)).status, 404);
  });
});

describe('admin: products, images, inventory', () => {
  test('every admin endpoint refuses non-admins (deny by default)', async () => {
    const paths = [['get', '/api/admin/dashboard'], ['get', '/api/admin/products'], ['get', '/api/admin/users'], ['get', '/api/admin/settings'], ['get', '/api/admin/audit-log'], ['get', '/api/admin/contact-messages']];
    for (const [n, br] of [['client', A], ['finance', F], ['sales', S], ['ops', O], ['support', SU]]) {
      for (const [m, p] of paths) assert.equal((await br[m](p)).status, 403, `${n} ${p}`);
      assert.equal((await br.post('/api/admin/products', { id: 'zz', category_id: 'print', name: 'Z', price: 1, fulfilment_type: 'stocked' })).status, 403, `${n} create`);
      assert.equal((await br.post('/api/admin/users', {})).status, 403, `${n} create user`);
      assert.equal((await br.put('/api/admin/settings/delivery', { value: {} })).status, 403, `${n} settings`);
    }
    assert.equal((await t.browser().get('/api/admin/dashboard')).status, 401);
  });
  test('dashboard shows headline numbers and setup hints', async () => {
    const d = (await AD.get('/api/admin/dashboard')).body;
    for (const k of ['orders_by_status', 'pending_payments', 'revenue_total', 'low_stock', 'customers', 'quote_requests_open', 'tickets_open', 'products_active']) assert.ok(k in d.stats, k);
    assert.equal(d.setup.bank_details_configured, false);
    assert.ok(d.stats.customers >= 2);
  });
  test('create a product (validation, duplicate id, opening stock), edit it, change price (audited), deactivate/reactivate', async () => {
    const bad = (b) => AD.post('/api/admin/products', b);
    assert.equal((await bad({ id: 'Bad Id!', category_id: 'print', name: 'X', price: 1, fulfilment_type: 'stocked' })).status, 400);
    assert.equal((await bad({ id: 'p-new', category_id: 'print', name: 'Tote bags', price: -5, fulfilment_type: 'stocked' })).status, 400);
    assert.equal((await bad({ id: 'p-new', category_id: 'nope', name: 'Tote bags', price: 5, fulfilment_type: 'stocked' })).status, 400, 'unknown category');
    assert.equal((await bad({ id: 'p-new', category_id: 'print', name: 'Tote bags', price: 5, fulfilment_type: 'stocked', image_url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await bad({ id: 'p-new', category_id: 'print', name: 'Tote bags', price: 5, fulfilment_type: 'stocked', is_admin: true })).status, 400);
    const ok = await bad({ id: 'p-tote', category_id: 'print', name: 'Tote bags', description: 'Cotton', price: 85.5, unit: 'each', fulfilment_type: 'stocked', initial_stock: 20 });
    assert.equal(ok.status, 201); assert.equal((await bad({ id: 'p-tote', category_id: 'print', name: 'Dup', price: 1, fulfilment_type: 'stocked' })).status, 409);
    assert.equal((await t.browser().get('/api/products/p-tote')).body.product.stock.status, 'in_stock');
    const edit = await AD.patch('/api/admin/products/p-tote', { price: 99, name: 'Canvas tote bags', category_id: 'signage', description: 'Heavy canvas', unit: 'per 10', low_stock_threshold: 8 });
    assert.equal(edit.status, 200); assert.equal(Number(edit.body.product.price), 99);
    assert.equal((await AD.patch('/api/admin/products/p-tote', { price: -1 })).status, 400);
    assert.equal((await AD.patch('/api/admin/products/p-tote', { id: 'hack' })).status, 400);
    assert.equal((await AD.patch('/api/admin/products/p-tote', {})).status, 400);
    assert.equal((await AD.patch('/api/admin/products/missing', { price: 1 })).status, 404);
    const audit = (await AD.get('/api/admin/audit-log?entity=product')).body.audit_log;
    const pc = audit.find((a) => a.action === 'product.price_change' && a.entity_id === 'p-tote');
    assert.ok(pc); assert.equal(Number(pc.before.price), 85.5); assert.equal(Number(pc.after.price), 99); assert.ok(pc.profiles.full_name);
    assert.equal((await AD.post('/api/admin/products/p-tote/deactivate')).body.product.is_active, false);
    assert.equal((await t.browser().get('/api/products/p-tote')).status, 404);
    assert.equal((await AD.post('/api/admin/products/p-tote/activate')).body.product.is_active, true);
    assert.ok((await AD.get('/api/admin/audit-log?action=product.')).body.audit_log.length >= 4);
  });
  test('changing a product type is blocked while orders hold its stock; made-to-order -> stocked gets an inventory row', async () => {
    await AD.post('/api/staff/stock/adjust', { product_id: 'pr-cards', delta: 5, reason: 'restock' });
    const o = await A.post('/api/orders', { items: [{ product_id: 'pr-cards', quantity: 1 }], delivery_method: 'collection', accept_terms: true });
    assert.equal((await AD.patch('/api/admin/products/pr-cards', { fulfilment_type: 'made_to_order' })).body.error.code, 'PRODUCT_HAS_RESERVATIONS');
    await A.post(`/api/orders/${o.body.order.id}/cancel`);
    assert.equal((await AD.patch('/api/admin/products/pr-cards', { fulfilment_type: 'made_to_order' })).status, 200);
    await AD.patch('/api/admin/products/pr-cards', { fulfilment_type: 'stocked' });
    assert.equal((await AD.patch('/api/admin/products/sg-reception', { fulfilment_type: 'stocked' })).status, 200);
    assert.ok((await AD.get('/api/staff/stock')).body.stock.some((s) => s.productId === 'sg-reception'));
    await AD.patch('/api/admin/products/sg-reception', { fulfilment_type: 'made_to_order' });
  });
  test('price changes never touch existing orders (history stays accurate)', async () => {
    const o = (await A.post('/api/orders', { items: [{ product_id: 'sg-reception', quantity: 1 }], delivery_method: 'collection', accept_terms: true })).body.order;
    await AD.patch('/api/admin/products/sg-reception', { price: 5000, name: 'Reception sign (new)' });
    const seen = (await A.get(`/api/orders/${o.id}`)).body.order;
    assert.equal(Number(seen.total), 2400); assert.equal(seen.order_items[0].product_name, 'Reception sign package');
    await AD.patch('/api/admin/products/sg-reception', { price: 2400, name: 'Reception sign package' });
  });
  test('product image: upload, preview URL, replace (old file deleted), reject bad files, remove', async () => {
    const up = (buf, name, type) => AD.upload('/api/admin/products/pr-pullup/image', 'image', buf, name, type);
    assert.equal((await up(EXE, 'a.png', 'image/png')).body.error.code, 'INVALID_FILE_CONTENT');
    assert.equal((await up(PDF, 'a.pdf', 'application/pdf')).body.error.code, 'UNSUPPORTED_FILE_TYPE');
    assert.equal((await up(Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]), 'big.png', 'image/png')).body.error.code, 'FILE_TOO_LARGE');
    const r1 = await up(PNG, 'banner.png', 'image/png'); assert.equal(r1.status, 200);
    const url1 = r1.body.product.image_url; const path1 = r1.body.product.image_path;
    assert.match(url1, /product-images\/products\/pr-pullup\/[0-9a-f-]{36}\.png$/);
    assert.equal((await fetch(url1)).status, 200, 'public preview works');
    assert.equal((await t.browser().get('/api/products/pr-pullup')).body.product.image_url, url1);
    const r2 = await up(JPG, 'banner.jpg', 'image/jpeg'); assert.notEqual(r2.body.product.image_url, url1);
    assert.equal((await fetch(url1)).status, 404, 'replaced file removed from storage'); assert.ok(path1);
    assert.equal((await AD.upload('/api/admin/products/nope/image', 'image', PNG, 'a.png', 'image/png')).status, 404);
    assert.equal((await S.upload('/api/admin/products/pr-pullup/image', 'image', PNG, 'a.png', 'image/png')).status, 403);
    assert.equal((await AD.del('/api/admin/products/pr-pullup/image')).body.product.image_url, null);
    assert.equal((await fetch(r2.body.product.image_url)).status, 404);
  });
  test('inventory view and movements ledger (admin)', async () => {
    const s = (await AD.get('/api/staff/stock')).body.stock; assert.ok(s.length >= 4 && s.every((x) => x.available === x.onHand - x.reserved));
    assert.ok((await AD.get('/api/staff/stock/p-tote/movements')).body.movements.some((m) => m.reason === 'initial_stock'));
  });
});

describe('admin: users, roles, staff', () => {
  test('create staff of each kind; validation; employee needs a department', async () => {
    const mk = (b) => AD.post('/api/admin/users', b);
    assert.equal((await mk({ fullName: 'Fin', email: 'fin2@test.local', password: 'Passw0rd!x', role: 'employee' })).status, 400);
    assert.equal((await mk({ fullName: 'Fin', email: 'fin2@test.local', password: 'Passw0rd!x', role: 'client' })).status, 400, 'staff endpoint cannot make clients');
    assert.equal((await mk({ fullName: 'Fin', email: 'fin2@test.local', password: 'Passw0rd!x', role: 'employee', department: 'finance' })).status, 201);
    assert.equal((await mk({ fullName: 'Fin', email: 'fin2@test.local', password: 'Passw0rd!x', role: 'support' })).body.error.code, 'EMAIL_IN_USE');
    const sup = await mk({ fullName: 'Help Desk', email: 'help@test.local', password: 'Passw0rd!x', role: 'support' }); assert.equal(sup.body.user.department, null);
    assert.equal((await mk({ fullName: 'Second Admin', email: 'admin2@test.local', password: 'Passw0rd!x', role: 'admin' })).status, 201);
    const login = await t.browser().post('/api/auth/login', { email: 'fin2@test.local', password: 'Passw0rd!x' }); assert.equal(login.body.user.department, 'finance');
    assert.equal((await t.sb.db.query("select count(*)::int c from profiles p left join auth.users u on u.id=p.id where u.id is null")).rows[0].c, 0, 'no orphan profiles');
  });
  test('list/filter users with emails and pagination', async () => {
    const r = (await AD.get('/api/admin/users?role=employee&pageSize=2')).body;
    assert.equal(r.users.length, 2); assert.ok(r.total >= 4 && r.pages >= 2); assert.ok(r.users.every((u) => u.email && u.role === 'employee'));
    assert.ok((await AD.get('/api/admin/users?q=Alice')).body.users.some((u) => u.email === alice.email));
  });
  test('role changes: department rules, self-protection, last-admin protection, audited', async () => {
    const u = await t.makeUser({ name: 'Promote Me' });
    assert.equal((await AD.patch(`/api/admin/users/${u.id}`, { role: 'employee' })).body.error.code, 'DEPARTMENT_REQUIRED');
    const ok = await AD.patch(`/api/admin/users/${u.id}`, { role: 'employee', department: 'sales' }); assert.equal(ok.body.user.department, 'sales');
    const sw = await AD.patch(`/api/admin/users/${u.id}`, { department: 'finance' }); assert.equal(sw.body.user.department, 'finance');
    const sup = await AD.patch(`/api/admin/users/${u.id}`, { role: 'support' }); assert.equal(sup.body.user.department, null, 'department cleared for non-employees');
    assert.equal((await AD.patch(`/api/admin/users/${u.id}`, { role: 'superuser' })).status, 400);
    assert.equal((await AD.patch(`/api/admin/users/${u.id}`, { email: 'x@y.z' })).status, 400);
    assert.equal((await AD.patch(`/api/admin/users/${admin.id}`, { role: 'client' })).body.error.code, 'CANNOT_MODIFY_SELF');
    assert.equal((await AD.patch(`/api/admin/users/${admin.id}`, { is_active: false })).body.error.code, 'CANNOT_MODIFY_SELF');
    assert.equal((await AD.patch('/api/admin/users/not-a-uuid', { is_active: false })).status, 404);
    const log = (await AD.get('/api/admin/audit-log?entity=profile')).body.audit_log;
    assert.ok(log.some((a) => a.action === 'user.role_change' && a.entity_id === u.id && a.before.role === 'client'));
    // last admin: with a second admin present, demoting one is allowed; demoting the final one is not
    const a2 = (await AD.get('/api/admin/users?role=admin')).body.users.find((x) => x.id !== admin.id);
    const B2 = await t.login({ email: a2.email, password: 'Passw0rd!x' });
    assert.equal((await AD.patch(`/api/admin/users/${a2.id}`, { is_active: false })).status, 200);
    assert.equal((await B2.get('/api/admin/dashboard')).status, 401, 'deactivated admin locked out');
    assert.equal((await AD.patch(`/api/admin/users/${a2.id}`, { is_active: true })).status, 200);
    assert.equal((await B2.get('/api/admin/dashboard')).status, 200, 'reactivated admin can work again');
  });
  test('promoting yourself through the data API is impossible', async () => {
    const s = await t.sb.db.query("select id from profiles where role='client' limit 1");
    await assert.rejects(() => t.sb.db.query(`begin; set local role authenticated; select set_config('request.jwt.claim.sub','${s.rows[0].id}',true); update profiles set role='admin' where id='${s.rows[0].id}'; commit;`), /FORBIDDEN/);
    await t.sb.db.query('rollback').catch(() => {});
  });
});

describe('admin: settings, audit, contact inbox', () => {
  let AD2;
  test('settings are validated per key; unknown keys refused; changes audited with before/after', async () => {
    AD2 = await t.login(await t.makeUser({ role: 'admin' }));
    assert.equal((await AD2.put('/api/admin/settings/evil_key', { value: 1 })).status, 404);
    assert.equal((await AD2.put('/api/admin/settings/order_expiry_hours', { value: -5 })).status, 400);
    assert.equal((await AD2.put('/api/admin/settings/order_expiry_hours', { value: 'abc' })).status, 400);
    assert.equal((await AD2.put('/api/admin/settings/delivery', { value: { enabled: true, flat_fee: -1, free_over: null, note: '' } })).status, 400);
    assert.equal((await AD2.put('/api/admin/settings/notifications', { value: { finance_email: 'not-email', sales_email: '', support_email: '', contact_email: '' } })).status, 400);
    assert.equal((await AD2.put('/api/admin/settings/order_expiry_hours', { value: 24 })).status, 200);
    assert.equal((await AD2.put('/api/admin/settings/terms_version', { value: '2.0' })).status, 200);
    assert.equal((await AD2.put('/api/admin/settings/bank_details', { value: { bank: 'Bank Windhoek', account_name: 'Nguni', account_number: '123', branch_code: '483' } })).status, 200);
    const cfg = (await t.browser().get('/api/config/public')).body.config;
    assert.equal(cfg.terms_version, '2.0'); assert.equal(cfg.order_expiry_hours, 24); assert.ok(!('bank_details' in cfg));
    const a = (await AD2.get('/api/admin/audit-log?entity=settings')).body.audit_log.find((x) => x.entity_id === 'order_expiry_hours');
    assert.equal(a.before, 48); assert.equal(a.after, 24);
    const o = (await A.post('/api/orders', { items: [{ product_id: 'sg-reception', quantity: 1 }], delivery_method: 'collection', accept_terms: true })).body.order;
    assert.equal(o.terms_version, '2.0'); const hours = (new Date(o.expires_at) - Date.now()) / 36e5; assert.ok(hours > 23 && hours <= 24.01, `expiry ${hours}h`);
    assert.equal((await AD2.get('/api/admin/dashboard')).body.setup.bank_details_configured, true);
  });
  test('audit log is filterable, paginated and covers key actions', async () => {
    const r = (await AD2.get('/api/admin/audit-log?pageSize=5&page=1')).body; assert.equal(r.audit_log.length, 5); assert.ok(r.total > 20);
    const have = new Set((await t.sb.db.query('select distinct action from audit_log')).rows.map((r) => r.action));
    for (const a of ['payment.confirm', 'payment.submit', 'order.create', 'order.status', 'user.create', 'user.role_change', 'user.deactivate', 'settings.update', 'product.create', 'product.price_change', 'product.deactivate', 'stock.adjust', 'quote.issue', 'quote.accept', 'quote.decline', 'ticket.update', 'auth.login']) assert.ok(have.has(a), `audit action missing: ${a}`);
    assert.equal((await AD2.get('/api/admin/audit-log?actor=not-a-uuid')).status, 200);
    assert.equal((await t.sb.db.query("select count(*)::int c from audit_log where action='payment.confirm'")).rows[0].c >= 1, true);
  });
  test('contact form: stored, validated, honeypot-protected, visible to admin only', async () => {
    const b = t.browser();
    assert.equal((await b.post('/api/contact', { name: 'X', email: 'bad', message: 'hi' })).status, 400);
    assert.equal((await b.post('/api/contact', { name: 'Bot', email: 'bot@x.com', message: 'buy now please', website: 'http://spam' })).status, 400);
    const ok = await b.post('/api/contact', { name: 'Jo Visitor', email: 'jo@example.com', phone: '0811234567', service: 'Signage', message: '<b>Need a quote</b> for 3 signs' });
    assert.equal(ok.status, 201);
    const inbox = (await AD2.get('/api/admin/contact-messages?status=new')).body.messages; const m = inbox.find((x) => x.email === 'jo@example.com');
    assert.ok(m); assert.equal(m.message, '<b>Need a quote</b> for 3 signs');
    assert.equal((await AD2.post(`/api/admin/contact-messages/${m.id}/handled`)).body.message.status, 'handled');
    assert.equal((await A.get('/api/admin/contact-messages')).status, 403);
    assert.equal((await AD2.get('/api/admin/dashboard')).body.stats.messages_new, 0);
  });
  test('favourites: save/list/remove, own only, active products only', async () => {
    assert.equal((await A.put('/api/me/favourites/pr-cards')).status, 200); assert.equal((await A.put('/api/me/favourites/nope')).status, 404);
    assert.deepEqual((await A.get('/api/me/favourites')).body.product_ids, ['pr-cards']); assert.deepEqual((await B.get('/api/me/favourites')).body.product_ids, []);
    assert.equal((await A.del('/api/me/favourites/pr-cards')).status, 200); assert.deepEqual((await A.get('/api/me/favourites')).body.product_ids, []);
    assert.equal((await t.browser().get('/api/me/favourites')).status, 401);
  });
});
