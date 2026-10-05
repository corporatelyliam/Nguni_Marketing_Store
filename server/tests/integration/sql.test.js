// Database-level tests against REAL PostgreSQL with the project's real migrations.
// These prove the atomicity / concurrency / permission guarantees that the Node layer relies on.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase, urlFor, makeUser, asRole, Pool } = require('../support/pg');

let pool; let client; let admin;
const items = (...pairs) => JSON.stringify(pairs.map(([product_id, quantity]) => ({ product_id, quantity })));
const errCode = (err) => String(err.message).split(':')[0];

async function rpc(name, args) {
  const keys = Object.keys(args);
  const sql = `select ${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
  const { rows } = await pool.query(sql, keys.map((k) => args[k]));
  return rows[0].r;
}
const placeOrder = (profile, lines, extra = {}) => rpc('create_order_tx', {
  p_profile_id: profile, p_items: items(...lines), p_delivery_method: extra.method || 'collection',
  p_address_id: extra.address || null, p_notes: null, p_idempotency_key: extra.key || null,
});
const stock = async (id) => (await pool.query('select stock_on_hand h, stock_reserved r from inventory where product_id=$1', [id])).rows[0];
async function setStock(id, onHand) {
  // Clear any live reservations left by earlier tests so each test starts from a known state.
  const open = (await pool.query("select distinct o.id from orders o join order_items i on i.order_id=o.id where i.product_id=$1 and i.stock_state='reserved' and o.status in ('pending_payment','payment_submitted','payment_rejected')", [id])).rows;
  for (const o of open) await rpc('cancel_order_tx', { p_order_id: o.id, p_actor: admin.id, p_is_staff: true, p_reason: 'test reset' });
  const cur = (await stock(id)).h;
  if (onHand !== cur) await pool.query("select adjust_stock($1,$2,$3::stock_reason,null,'test')", [id, onHand - cur, onHand > cur ? 'restock' : 'correction']);
}
async function payAndPay(orderId, actor) {
  await pool.query("insert into files(owner_id,bucket_path,original_name,mime_type,size_bytes,purpose) select profile_id,'x/'||id,'p.pdf','application/pdf',10,'payment_proof' from orders where id=$1", [orderId]);
  const f = (await pool.query('select id from files order by created_at desc limit 1')).rows[0].id;
  const o = (await pool.query('select profile_id from orders where id=$1', [orderId])).rows[0];
  await rpc('submit_payment_tx', { p_order_id: orderId, p_profile_id: o.profile_id, p_file_id: f });
}

before(async () => {
  const url = await createDatabase('nguni_test_sql');
  pool = new Pool({ connectionString: url, max: 30 });
  admin = await makeUser(pool, { role: 'admin', name: 'Root' });
  client = await makeUser(pool);
});
after(async () => { await pool.end(); });

describe('migrations & seed', () => {
  test('catalogue is seeded from the real product list', async () => {
    const { rows } = await pool.query('select fulfilment_type t, count(*)::int c from products group by 1 order by 1');
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.t, r.c])), { made_to_order: 6, quote_only: 8, stocked: 4 });
  });
  test('inventory rows exist for stocked products only', async () => {
    const { rows } = await pool.query('select p.fulfilment_type t from inventory i join products p on p.id=i.product_id');
    assert.ok(rows.length === 4 && rows.every((r) => r.t === 'stocked'));
  });
});

describe('order creation', () => {
  test('server prices the order from the database and ignores any client price', async () => {
    await setStock('pr-pullup', 10);
    const raw = JSON.stringify([{ product_id: 'pr-pullup', quantity: 2, unit_price: 1, line_total: 1, price: 1 }]);
    const o = await rpc('create_order_tx', { p_profile_id: client.id, p_items: raw, p_delivery_method: 'collection' });
    assert.equal(Number(o.subtotal), 3300); assert.equal(Number(o.total), 3300);
    assert.match(o.order_number, /^NGU-\d{6}$/);
    assert.equal(o.items[0].stock_state, 'reserved');
    assert.deepEqual(await stock('pr-pullup'), { h: 10, r: 2 });
  });
  test('rejects quote-only, unknown, inactive, empty and bad-quantity orders with clear codes', async () => {
    const bad = async (lines, code) => await assert.rejects(() => placeOrder(client.id, lines), (e) => errCode(e) === code, code);
    await bad([['bb-static', 1]], 'QUOTE_ONLY_PRODUCT');
    await bad([['nope', 1]], 'PRODUCT_UNAVAILABLE');
    await bad([['pr-cards', 0]], 'INVALID_QUANTITY');
    await bad([['pr-cards', -3]], 'INVALID_QUANTITY');
    await assert.rejects(() => rpc('create_order_tx', { p_profile_id: client.id, p_items: '[]', p_delivery_method: 'collection' }), (e) => errCode(e) === 'EMPTY_ORDER');
    await pool.query("update products set is_active=false where id='sg-reception'");
    await bad([['sg-reception', 1]], 'PRODUCT_UNAVAILABLE');
    await pool.query("update products set is_active=true where id='sg-reception'");
  });
  test('made-to-order lines reserve no stock', async () => {
    const before = await stock('pr-pullup');
    const o = await placeOrder(client.id, [['sg-reception', 1]]);
    assert.equal(o.items[0].stock_state, 'none');
    assert.deepEqual(await stock('pr-pullup'), before);
  });
  test('a failed line rolls the WHOLE order back (no partial state)', async () => {
    await setStock('pr-cards', 1); await setStock('pr-flyers', 5);
    const before = (await pool.query('select count(*)::int c from orders')).rows[0].c;
    const f0 = await stock('pr-flyers');
    await assert.rejects(() => placeOrder(client.id, [['pr-flyers', 2], ['pr-cards', 5]]), (e) => errCode(e) === 'INSUFFICIENT_STOCK');
    assert.equal((await pool.query('select count(*)::int c from orders')).rows[0].c, before);
    assert.deepEqual(await stock('pr-flyers'), f0);
  });
  test('idempotency key: a repeated submit returns the same order and reserves once', async () => {
    await setStock('pr-pullup', 10);
    const base = await stock('pr-pullup');
    const key = 'abc-123';
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => placeOrder(client.id, [['pr-pullup', 1]], { key }).catch((e) => ({ err: e }))));
    const ok = results.filter((r) => r.id); const dup = results.filter((r) => r.err);
    for (const d of dup) assert.match(String(d.err.message), /uq_orders_idempotency/); // race loser: the app layer turns this into a replay
    const ids = new Set(ok.map((r) => r.id)); assert.equal(ids.size, 1);
    const again = await placeOrder(client.id, [['pr-pullup', 1]], { key });
    assert.equal(again.replayed, true); assert.equal(again.id, [...ids][0]);
    const after = await stock('pr-pullup'); assert.equal(after.r - base.r, 1);
  });
  test('delivery needs one of the customer\'s own addresses; fee comes from settings', async () => {
    await assert.rejects(() => placeOrder(client.id, [['sg-reception', 1]], { method: 'delivery' }), (e) => errCode(e) === 'ADDRESS_REQUIRED');
    const other = await makeUser(pool);
    const a = (await pool.query("insert into addresses(profile_id,line1,town) values ($1,'1 Test St','Windhoek') returning id", [other.id])).rows[0].id;
    await assert.rejects(() => placeOrder(client.id, [['sg-reception', 1]], { method: 'delivery', address: a }), (e) => errCode(e) === 'ADDRESS_REQUIRED', 'someone else\'s address');
    const mine = (await pool.query("insert into addresses(profile_id,line1,town) values ($1,'9 My St','Windhoek') returning id", [client.id])).rows[0].id;
    await pool.query(`update settings set value='{"enabled":true,"flat_fee":150,"free_over":5000}' where key='delivery'`);
    const small = await placeOrder(client.id, [['sg-reception', 1]], { method: 'delivery', address: mine });
    assert.equal(Number(small.delivery_fee), 150); assert.equal(Number(small.total), 2550); assert.equal(small.delivery_status, 'pending');
    const big = await placeOrder(client.id, [['sg-reception', 3]], { method: 'delivery', address: mine });
    assert.equal(Number(big.delivery_fee), 0);
    await pool.query(`update settings set value='{"enabled":false}' where key='delivery'`);
    await assert.rejects(() => placeOrder(client.id, [['sg-reception', 1]], { method: 'delivery', address: mine }), (e) => errCode(e) === 'DELIVERY_UNAVAILABLE');
    await pool.query(`update settings set value='{"enabled":true,"flat_fee":0,"free_over":null}' where key='delivery'`);
  });
});

describe('concurrency: never oversell', () => {
  test('20 simultaneous checkouts for the LAST unit: exactly one wins', async () => {
    await setStock('sg-stamps', 1);
    const buyers = await Promise.all(Array.from({ length: 20 }, () => makeUser(pool)));
    const results = await Promise.all(buyers.map((b) => placeOrder(b.id, [['sg-stamps', 1]]).then(() => 'ok', (e) => errCode(e))));
    assert.equal(results.filter((r) => r === 'ok').length, 1);
    assert.equal(results.filter((r) => r === 'INSUFFICIENT_STOCK').length, 19);
    assert.deepEqual(await stock('sg-stamps'), { h: 1, r: 1 });
  });
  test('opposite line orders do not deadlock (locks taken in a fixed order)', async () => {
    await setStock('pr-cards', 100); await setStock('pr-flyers', 100);
    const rs = await Promise.all(Array.from({ length: 24 }, (_, i) =>
      placeOrder(client.id, i % 2 ? [['pr-cards', 1], ['pr-flyers', 1]] : [['pr-flyers', 1], ['pr-cards', 1]]).then(() => 'ok', (e) => e.code || errCode(e))));
    assert.equal(rs.filter((r) => r === 'ok').length, 24, JSON.stringify(rs));
  });
});

describe('payment confirmation', () => {
  test('confirm is atomic, deducts stock once, and a concurrent double-click cannot double-commit', async () => {
    await setStock('pr-cards', 20);
    const o = await placeOrder(client.id, [['pr-cards', 3]]);
    const other = await placeOrder(client.id, [['pr-cards', 4]]);          // someone else's reservation must stay intact
    await payAndPay(o.id, admin.id);
    const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => rpc('confirm_payment_tx', { p_order_id: o.id, p_actor: admin.id, p_bank_ref: 'REF1' }).then(() => 'ok', (e) => errCode(e))));
    assert.equal(rs.filter((r) => r === 'ok').length, 1, JSON.stringify(rs));
    assert.ok(rs.filter((r) => r !== 'ok').every((r) => r === 'ALREADY_CONFIRMED'));
    assert.deepEqual(await stock('pr-cards'), { h: 17, r: 4 });             // 20-3 on hand; only `other`'s 4 reserved
    const row = (await pool.query('select status, paid_at from orders where id=$1', [o.id])).rows[0];
    assert.equal(row.status, 'paid'); assert.ok(row.paid_at);
    const pay = (await pool.query('select status, bank_statement_ref, verified_by from payments where order_id=$1', [o.id])).rows;
    assert.equal(pay.length, 1); assert.equal(pay[0].status, 'confirmed'); assert.equal(pay[0].bank_statement_ref, 'REF1');
  });
  test('cannot confirm an order with no submitted proof or in the wrong state', async () => {
    const o = await placeOrder(client.id, [['sg-reception', 1]]);
    await assert.rejects(() => rpc('confirm_payment_tx', { p_order_id: o.id, p_actor: admin.id }), (e) => errCode(e) === 'INVALID_STATE');
    await assert.rejects(() => rpc('confirm_payment_tx', { p_order_id: '00000000-0000-0000-0000-000000000000', p_actor: admin.id }), (e) => errCode(e) === 'NOT_FOUND');
  });
  test('reject -> customer re-uploads -> confirm; reason is stored and expiry window restarts', async () => {
    await setStock('pr-cards', 20);
    const o = await placeOrder(client.id, [['pr-cards', 2]]);
    await payAndPay(o.id, admin.id);
    await assert.rejects(() => rpc('reject_payment_tx', { p_order_id: o.id, p_actor: admin.id, p_reason: 'x' }), (e) => errCode(e) === 'REASON_REQUIRED');
    await pool.query("update orders set expires_at = now() - interval '1 hour' where id=$1", [o.id]);
    const r = await rpc('reject_payment_tx', { p_order_id: o.id, p_actor: admin.id, p_reason: 'Amount does not match' });
    assert.equal(r.status, 'payment_rejected'); assert.ok(new Date(r.expires_at) > new Date());
    assert.equal((await pool.query('select reject_reason from payments where order_id=$1', [o.id])).rows[0].reject_reason, 'Amount does not match');
    await assert.rejects(() => rpc('reject_payment_tx', { p_order_id: o.id, p_actor: admin.id, p_reason: 'again please' }), (e) => errCode(e) === 'INVALID_STATE');
    await payAndPay(o.id, admin.id);
    const c = await rpc('confirm_payment_tx', { p_order_id: o.id, p_actor: admin.id });
    assert.equal(c.status, 'paid');
    assert.equal((await pool.query('select count(*)::int c from payments where order_id=$1', [o.id])).rows[0].c, 2);
  });
});

describe('cancellation & expiry never corrupt stock', () => {
  test('cancelling a PAID order leaves stock and OTHER orders\' reservations untouched (original bug)', async () => {
    await setStock('pr-flyers', 10);
    const a = await placeOrder(client.id, [['pr-flyers', 2]]);
    await payAndPay(a.id, admin.id); await rpc('confirm_payment_tx', { p_order_id: a.id, p_actor: admin.id });
    const b = await placeOrder(client.id, [['pr-flyers', 3]]);
    const before = await stock('pr-flyers'); assert.deepEqual(before, { h: 8, r: 3 });
    const c = await rpc('cancel_order_tx', { p_order_id: a.id, p_actor: admin.id, p_is_staff: true, p_reason: 'Customer withdrew' });
    assert.equal(c.status, 'cancelled');
    assert.deepEqual(await stock('pr-flyers'), before);
    // the other order can still be paid and committed
    await payAndPay(b.id, admin.id);
    assert.equal((await rpc('confirm_payment_tx', { p_order_id: b.id, p_actor: admin.id })).status, 'paid');
    assert.deepEqual(await stock('pr-flyers'), { h: 5, r: 0 });
  });
  test('client cancel only while pending_payment; stock returns; second cancel is refused', async () => {
    await setStock('pr-flyers', 10);
    const o = await placeOrder(client.id, [['pr-flyers', 4]]);
    const stranger = await makeUser(pool);
    await assert.rejects(() => rpc('cancel_order_tx', { p_order_id: o.id, p_actor: stranger.id, p_is_staff: false }), (e) => errCode(e) === 'NOT_FOUND');
    const rs = await Promise.all([1, 2, 3].map(() => rpc('cancel_order_tx', { p_order_id: o.id, p_actor: client.id, p_is_staff: false }).then(() => 'ok', (e) => errCode(e))));
    assert.equal(rs.filter((r) => r === 'ok').length, 1, JSON.stringify(rs));
    assert.deepEqual(await stock('pr-flyers'), { h: 10, r: 0 });
    await payAndPay((await placeOrder(client.id, [['sg-reception', 1]])).id, admin.id);
  });
  test('staff cancel needs a reason; client cannot cancel once payment is submitted', async () => {
    const o = await placeOrder(client.id, [['sg-reception', 1]]);
    await payAndPay(o.id, admin.id);
    await assert.rejects(() => rpc('cancel_order_tx', { p_order_id: o.id, p_actor: client.id, p_is_staff: false }), (e) => errCode(e) === 'CANNOT_CANCEL');
    await assert.rejects(() => rpc('cancel_order_tx', { p_order_id: o.id, p_actor: admin.id, p_is_staff: true, p_reason: '' }), (e) => errCode(e) === 'REASON_REQUIRED');
    const c = await rpc('cancel_order_tx', { p_order_id: o.id, p_actor: admin.id, p_is_staff: true, p_reason: 'duplicate order' });
    assert.equal(c.status, 'cancelled');
    assert.equal((await pool.query('select status from payments where order_id=$1', [o.id])).rows[0].status, 'rejected');
  });
  test('expiry job: releases stock once, is safe to run repeatedly and concurrently, covers rejected orders', async () => {
    await setStock('pr-pullup', 10);
    const base = await stock('pr-pullup');
    const o1 = await placeOrder(client.id, [['pr-pullup', 3]]);
    const o2 = await placeOrder(client.id, [['pr-pullup', 2]]);
    const live = await placeOrder(client.id, [['pr-pullup', 1]]);
    await payAndPay(o2.id, admin.id); await rpc('reject_payment_tx', { p_order_id: o2.id, p_actor: admin.id, p_reason: 'unreadable proof' });
    await pool.query("update orders set expires_at = now() - interval '1 minute' where id = any($1)", [[o1.id, o2.id]]);
    const counts = await Promise.all(Array.from({ length: 6 }, () => pool.query('select expire_unpaid_orders() n').then((r) => r.rows[0].n)));
    assert.equal(counts.reduce((a, b) => a + b, 0), 2, JSON.stringify(counts));
    assert.equal((await pool.query('select expire_unpaid_orders() n')).rows[0].n, 0);
    const s = await stock('pr-pullup'); assert.equal(s.r - base.r, 1, 'only the still-live order keeps its reservation');
    const st = (await pool.query('select id,status from orders where id = any($1)', [[o1.id, o2.id, live.id]])).rows;
    assert.deepEqual(Object.fromEntries(st.map((r) => [r.id, r.status])), { [o1.id]: 'expired', [o2.id]: 'expired', [live.id]: 'pending_payment' });
    const moves = (await pool.query("select count(*)::int c from stock_movements where reason='reservation_expired' and order_id = any($1)", [[o1.id, o2.id]])).rows[0].c;
    assert.equal(moves, 2);
    assert.ok((await pool.query("select count(*)::int c from audit_log where action='order.expire'")).rows[0].c >= 2);
  });
});

describe('order state machine', () => {
  test('only paid->processing->ready->completed; no jumps; completed delivery orders become delivered', async () => {
    const o = await placeOrder(client.id, [['sg-reception', 1]]);
    const t = (to) => rpc('set_order_status_tx', { p_order_id: o.id, p_actor: admin.id, p_to: to });
    await assert.rejects(() => t('completed'), (e) => errCode(e) === 'INVALID_TRANSITION');
    await assert.rejects(() => t('processing'), (e) => errCode(e) === 'INVALID_TRANSITION');
    await payAndPay(o.id, admin.id); await rpc('confirm_payment_tx', { p_order_id: o.id, p_actor: admin.id });
    await assert.rejects(() => t('ready'), (e) => errCode(e) === 'INVALID_TRANSITION');
    await assert.rejects(() => t('paid'), (e) => errCode(e) === 'INVALID_TRANSITION');
    assert.equal((await t('processing')).status, 'processing');
    assert.equal((await t('ready')).status, 'ready');
    assert.equal((await t('completed')).status, 'completed');
    await assert.rejects(() => t('processing'), (e) => errCode(e) === 'INVALID_TRANSITION');
    await assert.rejects(() => rpc('cancel_order_tx', { p_order_id: o.id, p_actor: admin.id, p_is_staff: true, p_reason: 'too late' }), (e) => errCode(e) === 'CANNOT_CANCEL');
    const hist = (await pool.query('select to_status from order_status_history where order_id=$1 order by created_at, id', [o.id])).rows.map((r) => r.to_status);
    assert.deepEqual(hist, ['pending_payment', 'payment_submitted', 'paid', 'processing', 'ready', 'completed']);
  });
});

describe('stock adjustments', () => {
  test('reasons, signs and the on-hand/reserved invariants are enforced; every change is a ledger row', async () => {
    await setStock('pr-cards', 50);
    const hold = await placeOrder(client.id, [['pr-cards', 10]]);
    const adj = (d, r) => pool.query('select adjust_stock($1,$2,$3::stock_reason,$4,$5)', ['pr-cards', d, r, admin.id, 'note']);
    await assert.rejects(() => adj(0, 'restock'), (e) => errCode(e) === 'INVALID_ADJUSTMENT');
    await assert.rejects(() => adj(-5, 'restock'), (e) => errCode(e) === 'INVALID_ADJUSTMENT');
    await assert.rejects(() => adj(5, 'damage'), (e) => errCode(e) === 'INVALID_ADJUSTMENT');
    await assert.rejects(() => adj(-1000, 'correction'), (e) => errCode(e) === 'INVALID_ADJUSTMENT');
    await assert.rejects(() => adj(-45, 'correction'), (e) => errCode(e) === 'INVALID_ADJUSTMENT', 'cannot drop below what is reserved');
    await assert.rejects(() => pool.query("select adjust_stock('pr-cards',1,'order_paid',null,'x')"), (e) => errCode(e) === 'INVALID_ADJUSTMENT', 'system reasons are not manual');
    const before = (await pool.query("select count(*)::int c from stock_movements where product_id='pr-cards'")).rows[0].c;
    await adj(-5, 'damage'); await adj(20, 'restock'); await adj(-2, 'expiry');
    assert.equal((await pool.query("select count(*)::int c from stock_movements where product_id='pr-cards'")).rows[0].c, before + 3);
    assert.deepEqual(await stock('pr-cards'), { h: 63, r: 10 });
    // the ledger reconciles: running sum of `delta` equals current available stock
    const sum = (await pool.query("select coalesce(sum(delta),0)::int s from stock_movements where product_id='pr-cards'")).rows[0].s;
    assert.equal(sum, 63 - 10);
    void hold;
  });
});

describe('quotes', () => {
  let request;
  async function newRequest(owner, extra = {}) {
    return (await pool.query("insert into quote_requests(profile_id,title,description,specs) values ($1,$2,'d','{}') returning id", [owner.id, extra.title || 'Fleet wrap x3'])).rows[0];
  }
  const issue = (id, amount = 12345.67, days = 7) => rpc('issue_quote_tx', { p_request_id: id, p_actor: admin.id, p_amount: amount, p_notes: 'n', p_valid_until: new Date(Date.now() + days * 864e5).toISOString() });
  test('issue validates, supersedes older quotes, and allows only one live quote per request', async () => {
    request = await newRequest(client);
    await assert.rejects(() => issue(request.id, 0), (e) => errCode(e) === 'INVALID_AMOUNT');
    await assert.rejects(() => issue(request.id, 100, -1), (e) => errCode(e) === 'INVALID_VALIDITY');
    const q1 = await issue(request.id, 1000); const q2 = await issue(request.id, 2000);
    const live = (await pool.query("select id from quotes where quote_request_id=$1 and status='issued'", [request.id])).rows;
    assert.deepEqual(live.map((r) => r.id), [q2.id]);
    assert.equal((await pool.query('select status from quotes where id=$1', [q1.id])).rows[0].status, 'expired');
    assert.equal((await pool.query('select status from quote_requests where id=$1', [request.id])).rows[0].status, 'quoted');
  });
  test('accepting creates exactly ONE order at the QUOTED amount, even under a double-click', async () => {
    const r = await newRequest(client, { title: 'Illuminated sign' });
    const q = await issue(r.id, 12345.67);
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => rpc('respond_quote_tx', { p_quote_id: q.id, p_profile_id: client.id, p_accept: true, p_delivery_method: 'collection' }).then((x) => x, (e) => errCode(e))));
    const ok = rs.filter((x) => typeof x === 'object');
    assert.equal(ok.length, 1, JSON.stringify(rs));
    assert.ok(rs.filter((x) => typeof x === 'string').every((x) => x === 'QUOTE_NOT_OPEN'));
    const o = ok[0].order;
    assert.equal(Number(o.total), 12345.67); assert.equal(o.quote_id, q.id);
    assert.equal(o.items.length, 1); assert.equal(o.items[0].is_custom, true); assert.equal(o.items[0].product_id, null);
    assert.equal(o.items[0].product_name, 'Custom quote: Illuminated sign');
    assert.equal((await pool.query('select count(*)::int c from orders where quote_id=$1', [q.id])).rows[0].c, 1);
    assert.equal((await pool.query('select status from quote_requests where id=$1', [r.id])).rows[0].status, 'closed');
    // the quote-order flows through payment like any other
    await payAndPay(o.id, admin.id);
    assert.equal((await rpc('confirm_payment_tx', { p_order_id: o.id, p_actor: admin.id })).status, 'paid');
  });
  test('only the owner can respond; expired quotes cannot be accepted; decline closes the request', async () => {
    const r = await newRequest(client); const q = await issue(r.id, 500);
    const stranger = await makeUser(pool);
    await assert.rejects(() => rpc('respond_quote_tx', { p_quote_id: q.id, p_profile_id: stranger.id, p_accept: true, p_delivery_method: 'collection' }), (e) => errCode(e) === 'NOT_FOUND');
    await assert.rejects(() => rpc('respond_quote_tx', { p_quote_id: q.id, p_profile_id: client.id, p_accept: true }), (e) => errCode(e) === 'DELIVERY_METHOD_REQUIRED');
    await pool.query("update quotes set valid_until = now() - interval '1 minute' where id=$1", [q.id]);
    await assert.rejects(() => rpc('respond_quote_tx', { p_quote_id: q.id, p_profile_id: client.id, p_accept: true, p_delivery_method: 'collection' }), (e) => errCode(e) === 'QUOTE_EXPIRED');
    assert.equal((await pool.query('select expire_quotes() n')).rows[0].n, 1);
    assert.equal((await pool.query('select status from quote_requests where id=$1', [r.id])).rows[0].status, 'in_review');
    const q2 = await issue(r.id, 600);
    assert.deepEqual(await rpc('respond_quote_tx', { p_quote_id: q2.id, p_profile_id: client.id, p_accept: false }), { declined: true });
    assert.equal((await pool.query('select status from quote_requests where id=$1', [r.id])).rows[0].status, 'closed');
    await assert.rejects(() => issue(r.id, 700), (e) => errCode(e) === 'REQUEST_CLOSED');
  });
});

describe('database-level security', () => {
  test('a signed-in user CANNOT promote themselves (original critical RLS hole)', async () => {
    await assert.rejects(() => asRole(pool, 'authenticated', client.id, (c) => c.query("update profiles set role='admin' where id=$1", [client.id])), /FORBIDDEN/);
    await assert.rejects(() => asRole(pool, 'authenticated', client.id, (c) => c.query("update profiles set is_active=true, department='finance' where id=$1", [client.id])), /FORBIDDEN|department_requires/);
    const ok = await asRole(pool, 'authenticated', client.id, async (c) => { await c.query("update profiles set full_name='New Name' where id=$1", [client.id]); return (await c.query('select full_name from profiles where id=$1', [client.id])).rows[0].full_name; });
    assert.equal(ok, 'New Name');
    assert.equal((await pool.query('select role from profiles where id=$1', [client.id])).rows[0].role, 'client');
  });
  test('a user cannot read or touch another user\'s rows through the data API', async () => {
    const mine = await placeOrder(client.id, [['sg-reception', 1]]);
    const stranger = await makeUser(pool);
    const seen = await asRole(pool, 'authenticated', stranger.id, (c) => c.query('select id from orders'));
    assert.equal(seen.rows.length, 0);
    const own = await asRole(pool, 'authenticated', client.id, (c) => c.query('select id from orders where id=$1', [mine.id]));
    assert.equal(own.rows.length, 1);
    assert.equal((await asRole(pool, 'anon', null, (c) => c.query('select * from payments'))).rows.length, 0);
    await assert.rejects(() => asRole(pool, 'anon', null, (c) => c.query('select * from audit_log')).then((r) => { if (r.rows.length) return r; throw new Error('empty'); }));
  });
  test('NO function in public is executable by anon or authenticated', async () => {
    const { rows } = await pool.query(`
      select p.oid::regprocedure::text as sig,
             has_function_privilege('anon', p.oid, 'execute') as anon_x,
             has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
             has_function_privilege('service_role', p.oid, 'execute') as svc_x
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f'`);
    assert.ok(rows.length > 15);
    assert.deepEqual(rows.filter((r) => r.anon_x || r.auth_x), []);
    assert.deepEqual(rows.filter((r) => !r.svc_x), []);
  });
  test('audit log, stock ledger and status history are append-only; orders/payments/quotes cannot be deleted', async () => {
    await assert.rejects(() => pool.query("update audit_log set action='x'"), /append-only/);
    await assert.rejects(() => pool.query('delete from audit_log'), /append-only/);
    await assert.rejects(() => pool.query('truncate audit_log'), /append-only/);
    await assert.rejects(() => pool.query('update stock_movements set delta=0'), /append-only/);
    await assert.rejects(() => pool.query('delete from order_status_history'), /append-only/);
    await assert.rejects(() => pool.query('delete from orders'), /not permitted/);
    await assert.rejects(() => pool.query('delete from payments'), /not permitted/);
    await assert.rejects(() => pool.query('delete from quotes'), /not permitted/);
  });
  test('a product cannot stop being "stocked" while reservations exist; becoming stocked creates its inventory row', async () => {
    await setStock('pr-cards', 10);
    await placeOrder(client.id, [['pr-cards', 1]]);
    await assert.rejects(() => pool.query("update products set fulfilment_type='made_to_order' where id='pr-cards'"), /PRODUCT_HAS_RESERVATIONS/);
    await pool.query("update products set fulfilment_type='stocked' where id='sg-reception'");
    assert.equal((await pool.query("select count(*)::int c from inventory where product_id='sg-reception'")).rows[0].c, 1);
    await pool.query("update products set fulfilment_type='made_to_order' where id='sg-reception'");
  });
  test('historical orders keep their name/price when a product is renamed, repriced or deactivated', async () => {
    const o = await placeOrder(client.id, [['sg-reception', 1]]);
    await pool.query("update products set price=9999, name='Renamed', is_active=false where id='sg-reception'");
    const row = (await pool.query('select product_name, unit_price, line_total from order_items where order_id=$1', [o.id])).rows[0];
    assert.equal(row.product_name, 'Reception sign package'); assert.equal(Number(row.unit_price), 2400);
    await pool.query("update products set price=2400, name='Reception sign package', is_active=true where id='sg-reception'");
  });
  test('stock invariants are enforced by the database even against direct writes', async () => {
    await assert.rejects(() => pool.query("update inventory set stock_reserved = stock_on_hand + 1 where product_id='pr-cards'"), /stock_reserved_le_on_hand/);
    await assert.rejects(() => pool.query("update inventory set stock_on_hand = -1 where product_id='pr-cards'"), /stock_on_hand_nonneg|stock_reserved_le/);
  });
});

test('dashboard_stats returns the headline numbers', async () => {
  const s = (await pool.query('select dashboard_stats() s')).rows[0].s;
  for (const k of ['orders_by_status', 'pending_payments', 'revenue_total', 'low_stock', 'customers', 'tickets_open']) assert.ok(k in s, k);
  assert.ok(Number(s.revenue_total) > 0);
});
