// server/src/lib/http.js: shared HTTP helpers (error mapping, async wrapper, pagination, response shaping).
const { z } = require('zod');

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; this.expose = true; }
}

// Database function error codes (raised as 'CODE' or 'CODE: detail') -> HTTP status + friendly text.
const DB_ERRORS = {
  NOT_FOUND: [404, 'We could not find that item.'],
  INSUFFICIENT_STOCK: [409, 'One or more items no longer have enough stock available.'],
  PRODUCT_UNAVAILABLE: [409, 'One or more items are no longer available.'],
  QUOTE_ONLY_PRODUCT: [400, 'This item needs a quote before it can be ordered.'],
  EMPTY_ORDER: [400, 'Your cart is empty.'],
  TOO_MANY_LINES: [400, 'Too many different items in one order.'],
  INVALID_QUANTITY: [400, 'Please check the item quantities.'],
  ADDRESS_REQUIRED: [400, 'Please choose one of your saved delivery addresses.'],
  DELIVERY_UNAVAILABLE: [409, 'Delivery is not currently available. Please choose collection.'],
  DELIVERY_METHOD_REQUIRED: [400, 'Please choose collection or delivery.'],
  INVALID_STATE: [409, 'This action is not valid for the current status.'],
  CANNOT_CANCEL: [409, 'This order can no longer be cancelled.'],
  ALREADY_CONFIRMED: [409, 'This payment has already been confirmed.'],
  NO_PAYMENT_SUBMITTED: [409, 'No proof of payment is awaiting review for this order.'],
  REASON_REQUIRED: [400, 'A reason (at least 3 characters) is required.'],
  INVALID_TRANSITION: [409, 'That status change is not allowed from the current status.'],
  INVALID_ADJUSTMENT: [409, 'That stock change is not allowed (it would go below zero or below the amount reserved).'],
  NO_INVENTORY: [409, 'This product does not track stock.'],
  STOCK_INVARIANT: [409, 'That change would leave stock in an invalid state.'],
  QUOTE_NOT_OPEN: [409, 'This quote has already been answered or replaced.'],
  QUOTE_EXPIRED: [409, 'This quote has expired. Please ask us to re-issue it.'],
  REQUEST_CLOSED: [409, 'This quote request is closed.'],
  INVALID_AMOUNT: [400, 'The quote amount must be greater than zero.'],
  INVALID_VALIDITY: [400, 'The quote validity date must be in the future.'],
  PRODUCT_HAS_RESERVATIONS: [409, 'This product has open orders holding stock, so its fulfilment type cannot change yet.'],
  INVALID_DELIVERY_STATUS: [400, 'Invalid delivery status.'],
  NOT_A_DELIVERY_ORDER: [409, 'This order is for collection.'],
  FORBIDDEN: [403, 'You do not have access to this action.'],
};

// Turn any thrown value into { status, code, message } safe to show a user.
function describeError(err) {
  if (!err) return { status: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' };
  if (err instanceof HttpError) return { status: err.status, code: err.code, message: err.message };
  const raw = String(err.message || '');
  const head = raw.split(':')[0].trim();
  if (DB_ERRORS[head]) return { status: DB_ERRORS[head][0], code: head, message: DB_ERRORS[head][1] };
  if (err.code === '23505') return { status: 409, code: 'CONFLICT', message: 'That already exists.' };
  if (err.code === '23503') return { status: 400, code: 'INVALID_REFERENCE', message: 'A referenced item does not exist.' };
  if (err.code === '23514' || err.code === '22P02' || err.code === '22003') return { status: 400, code: 'INVALID_DATA', message: 'Some of the data is not valid.' };
  if (err.code === '42501') return { status: 403, code: 'FORBIDDEN', message: 'You do not have access to this action.' };
  return null;
}

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Pagination: ?page=1&pageSize=25 (max 100). Returns the range for supabase .range().
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
function pageParams(query) {
  const { page, pageSize } = pageSchema.parse(query);
  return { page, pageSize, from: (page - 1) * pageSize, to: page * pageSize - 1 };
}
const pageMeta = (p, count) => ({ page: p.page, pageSize: p.pageSize, total: count ?? 0, pages: Math.max(1, Math.ceil((count ?? 0) / p.pageSize)) });

// Escape user text for use inside a PostgREST ilike pattern.
const likeEscape = (s) => String(s).replace(/[\\%_,()*]/g, (c) => `\\${c}`).slice(0, 80);

// Remove internal-only fields before an order is shown to the customer who owns it.
function customerOrder(o) {
  if (!o) return o;
  const { idempotency_key, replayed, ...rest } = o; // eslint-disable-line no-unused-vars
  return rest;
}
// Only the fields a customer should see about a payment attempt.
const customerPayment = (p) => ({ id: p.id, status: p.status, submitted_at: p.submitted_at, reject_reason: p.status === 'rejected' ? p.reject_reason : null });

module.exports = { HttpError, describeError, ah, pageParams, pageMeta, likeEscape, customerOrder, customerPayment, DB_ERRORS };
