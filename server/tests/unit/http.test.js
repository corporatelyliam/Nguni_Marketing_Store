const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { describeError, pageParams, pageMeta, likeEscape, customerOrder, customerPayment, DB_ERRORS, HttpError } = require('../../src/lib/http');

describe('database error mapping', () => {
  test('every database error code becomes a safe, friendly HTTP error', () => {
    for (const [code, [status, msg]] of Object.entries(DB_ERRORS)) {
      const r = describeError(new Error(`${code}: some-detail`));
      assert.equal(r.status, status, code); assert.equal(r.code, code); assert.equal(r.message, msg);
      assert.ok(!/some-detail/.test(r.message), 'internal detail never reaches the user');
    }
  });
  test('postgres constraint errors map to 4xx, unknown errors to null (handled as 500)', () => {
    assert.equal(describeError({ code: '23505', message: 'duplicate key value violates unique constraint "x"' }).status, 409);
    assert.equal(describeError({ code: '23503', message: 'fk' }).status, 400);
    assert.equal(describeError({ code: '22P02', message: 'invalid input syntax for type uuid' }).status, 400);
    assert.equal(describeError({ code: '42501', message: 'rls' }).status, 403);
    assert.equal(describeError(new Error('connect ECONNREFUSED 10.0.0.1:5432')), null);
    assert.equal(describeError(new HttpError(418, 'TEAPOT', 'short')).status, 418);
  });
});

describe('helpers', () => {
  test('pagination is bounded', () => {
    assert.deepEqual(pageParams({}), { page: 1, pageSize: 25, from: 0, to: 24 });
    assert.equal(pageParams({ page: '3', pageSize: '10' }).from, 20);
    assert.throws(() => pageParams({ pageSize: '100000' })); assert.throws(() => pageParams({ page: '0' })); assert.throws(() => pageParams({ page: 'x' }));
    assert.deepEqual(pageMeta({ page: 2, pageSize: 10 }, 35), { page: 2, pageSize: 10, total: 35, pages: 4 });
  });
  test('search text cannot inject filter syntax or wildcards', () => {
    assert.equal(likeEscape('50%_off,(a)'), '50\\%\\_off\\,\\(a\\)'); assert.equal(likeEscape('x'.repeat(500)).length, 80);
  });
  test('customers never receive internal order/payment fields', () => {
    assert.deepEqual(customerOrder({ id: 1, idempotency_key: 'k', replayed: true, total: 5 }), { id: 1, total: 5 });
    const p = customerPayment({ id: 1, status: 'confirmed', submitted_at: 't', reject_reason: 'x', bank_statement_ref: 'SECRET', verified_by: 'staff-id' });
    assert.deepEqual(p, { id: 1, status: 'confirmed', submitted_at: 't', reject_reason: null });
  });
});
