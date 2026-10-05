// server/src/routes/staff.js
// Staff back-office. Every route is deny-by-default: requireAuth + an explicit department/role rule.
// Matrix (docs/02-SRS.md section 1): finance=payments, operations=order progress+stock, sales=quotes,
// support=tickets (+read-only order/quote lookup), admin=everything.
const express = require('express');
const { z } = require('zod');
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');
const { allow, requireDepartment, requireSupport, requireAnyStaff, canSeePayments } = require('../middleware/rbac');
const { validateBody } = require('../middleware/validate');
const orders = require('../services/orders');
const stock = require('../services/stock');
const tickets = require('../services/tickets');
const files = require('../services/files');
const { notify, emailOf } = require('../services/notify');
const { logAction } = require('../services/audit');
const { ah, HttpError, pageParams, pageMeta, likeEscape } = require('../lib/http');

const router = express.Router();
router.use(requireAuth, requireAnyStaff());

const uuid = z.string().uuid();
const guard = (name = 'id') => (req, res, next) => (uuid.safeParse(req.params[name]).success ? next() : next(new HttpError(404, 'NOT_FOUND', 'Not found.')));
const ORDER_STATUSES = ['pending_payment', 'payment_submitted', 'payment_rejected', 'paid', 'processing', 'ready', 'completed', 'cancelled', 'expired'];

// ------------------------------------------------------------------ orders
router.get('/orders', ah(async (req, res) => {
  const p = pageParams(req.query);
  const status = ORDER_STATUSES.includes(req.query.status) ? req.query.status : null;
  let q = supabase.from('orders')
    .select('id, order_number, status, total, delivery_method, delivery_status, created_at, paid_at, profiles(full_name, company), order_items(product_name, quantity)', { count: 'exact' })
    .order('created_at', { ascending: false }).range(p.from, p.to);
  if (status) q = q.eq('status', status);
  if (req.query.q) q = q.ilike('order_number', `%${likeEscape(req.query.q)}%`);
  const { data, count, error } = await q;
  if (error) throw error;
  res.json({ orders: data, ...pageMeta(p, count) });
}));

router.get('/orders/:id', guard(), ah(async (req, res) => {
  const { data: o, error } = await supabase.from('orders')
    .select('*, order_items(*), profiles(full_name, phone, company), payments(id, status, submitted_at, verified_at, reject_reason, bank_statement_ref, verified_by), order_status_history(from_status, to_status, note, created_at, actor_id)')
    .eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!o) throw new HttpError(404, 'NOT_FOUND', 'Order not found.');
  const finance = canSeePayments(req.user.profile);
  const { payments, order_status_history: history, idempotency_key, ...rest } = o; // eslint-disable-line no-unused-vars
  res.json({
    order: rest,
    customer_email: await emailOf(o.profile_id),
    // Support/sales/operations learn only the payment STATUS, not references or who verified it.
    payments: payments.sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at)).map((x) => (finance ? x : { id: x.id, status: x.status, submitted_at: x.submitted_at })),
    history: history.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
  });
}));

router.patch('/orders/:id/status', guard(), requireDepartment('operations'), validateBody(z.object({
  status: z.enum(['processing', 'ready', 'completed']), note: z.string().trim().max(300).optional(),
}).strict()), ah(async (req, res) => {
  res.json({ order: await orders.setStatus({ orderId: req.params.id, actorId: req.user.id, status: req.body.status, note: req.body.note }) });
}));

router.post('/orders/:id/cancel', guard(), requireDepartment('operations'), validateBody(z.object({ reason: z.string().trim().min(3).max(300) }).strict()), ah(async (req, res) => {
  res.json({ order: await orders.cancelOrder({ orderId: req.params.id, actorId: req.user.id, isStaff: true, reason: req.body.reason }) });
}));

router.patch('/orders/:id/delivery', guard(), requireDepartment('operations'), validateBody(z.object({ delivery_status: z.enum(['pending', 'dispatched', 'delivered']) }).strict()), ah(async (req, res) => {
  res.json({ order: await orders.setDeliveryStatus({ orderId: req.params.id, actorId: req.user.id, status: req.body.delivery_status }) });
}));

// ---------------------------------------------------------------- payments
router.get('/payments', requireDepartment('finance'), ah(async (req, res) => {
  const p = pageParams(req.query);
  const status = ['pending', 'confirmed', 'rejected'].includes(req.query.status) ? req.query.status : null;
  let q = supabase.from('payments')
    .select('id, order_id, status, submitted_at, verified_at, reject_reason, bank_statement_ref, orders(order_number, total, status, profiles(full_name))', { count: 'exact' })
    .order('submitted_at', { ascending: status === 'pending' }).range(p.from, p.to);
  if (status) q = q.eq('status', status);
  const { data, count, error } = await q;
  if (error) throw error;
  res.json({ payments: data, ...pageMeta(p, count) });
}));

router.get('/payments/:id/proof-url', guard(), requireDepartment('finance'), ah(async (req, res) => {
  const { data: pay } = await supabase.from('payments').select('id, files(bucket_path, original_name)').eq('id', req.params.id).maybeSingle();
  if (!pay?.files) throw new HttpError(404, 'NOT_FOUND', 'No proof file found.');
  await logAction({ actorId: req.user.id, action: 'payment.view_proof', entity: 'payment', entityId: pay.id });
  res.json({ url: await files.signedUrl(pay.files.bucket_path, 300), name: pay.files.original_name, expires_in_seconds: 300 });
}));

router.post('/payments/:orderId/confirm', guard('orderId'), requireDepartment('finance'), validateBody(z.object({ bank_statement_ref: z.string().trim().max(120).optional() }).strict()), ah(async (req, res) => {
  res.json({ order: await orders.confirmPayment({ orderId: req.params.orderId, actorId: req.user.id, bankRef: req.body.bank_statement_ref }) });
}));
router.post('/payments/:orderId/reject', guard('orderId'), requireDepartment('finance'), validateBody(z.object({ reason: z.string().trim().min(3).max(300) }).strict()), ah(async (req, res) => {
  res.json({ order: await orders.rejectPayment({ orderId: req.params.orderId, actorId: req.user.id, reason: req.body.reason }) });
}));

// ------------------------------------------------------------------- stock
router.get('/stock', ah(async (req, res) => res.json({ stock: await stock.getStockOverview() })));
router.get('/stock/:productId/movements', requireDepartment('operations'), ah(async (req, res) => {
  res.json({ movements: await stock.getMovements(req.params.productId.slice(0, 60)) });
}));
router.post('/stock/adjust', requireDepartment('operations'), validateBody(z.object({
  product_id: z.string().min(1).max(60), delta: z.number().int().min(-100000).max(100000).refine((v) => v !== 0, 'Change must not be zero'),
  reason: z.enum(['restock', 'correction', 'manual_adjustment', 'damage', 'expiry']), note: z.string().trim().max(300).optional(),
}).strict().refine((v) => !['correction', 'manual_adjustment'].includes(v.reason) || (v.note && v.note.length >= 3), { message: 'A note is required for corrections and manual adjustments.', path: ['note'] })), ah(async (req, res) => {
  await stock.adjustStock({ productId: req.body.product_id, delta: req.body.delta, reason: req.body.reason, actorId: req.user.id, note: req.body.note });
  res.json({ message: 'Stock updated.' });
}));

// ------------------------------------------------------------------ quotes
const quoteRead = allow({ departments: ['sales'], roles: ['support'] }); // support: read-only
const QR_OWNER = 'profiles!quote_requests_profile_id_fkey(full_name, company, phone)';

router.get('/quote-requests', quoteRead, ah(async (req, res) => {
  const p = pageParams(req.query);
  const status = ['submitted', 'in_review', 'quoted', 'closed'].includes(req.query.status) ? req.query.status : null;
  let q = supabase.from('quote_requests').select(`id, title, description, specs, status, assigned_to, created_at, ${QR_OWNER}, quotes(id, amount, status, valid_until), files(id)`, { count: 'exact' })
    .order('created_at', { ascending: false }).range(p.from, p.to);
  if (status) q = q.eq('status', status);
  const { data, count, error } = await q;
  if (error) throw error;
  res.json({ quote_requests: data, ...pageMeta(p, count) });
}));

router.get('/quote-requests/:id', guard(), quoteRead, ah(async (req, res) => {
  const { data: r } = await supabase.from('quote_requests').select(`*, ${QR_OWNER}, quotes(*), files(id, original_name, mime_type, size_bytes, bucket_path)`).eq('id', req.params.id).maybeSingle();
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'Quote request not found.');
  const attachments = await Promise.all((r.files || []).map(async (f) => ({ id: f.id, name: f.original_name, mime_type: f.mime_type, size_bytes: f.size_bytes, url: await files.signedUrl(f.bucket_path, 300) })));
  const { files: _f, ...rest } = r; // eslint-disable-line no-unused-vars
  res.json({ quote_request: rest, attachments, customer_email: await emailOf(r.profile_id) });
}));

router.patch('/quote-requests/:id', guard(), requireDepartment('sales'), validateBody(z.object({
  status: z.enum(['in_review', 'closed']).optional(), assigned_to: z.string().uuid().nullable().optional(),
}).strict()), ah(async (req, res) => {
  const { data: before } = await supabase.from('quote_requests').select('*').eq('id', req.params.id).maybeSingle();
  if (!before) throw new HttpError(404, 'NOT_FOUND', 'Quote request not found.');
  if (req.body.status === 'in_review' && before.status === 'closed') throw new HttpError(409, 'REQUEST_CLOSED', 'This quote request is closed.');
  if (req.body.assigned_to) {
    const { data: a } = await supabase.from('profiles').select('role, department, is_active').eq('id', req.body.assigned_to).maybeSingle();
    if (!a?.is_active || !(a.role === 'admin' || (a.role === 'employee' && a.department === 'sales'))) throw new HttpError(400, 'INVALID_ASSIGNEE', 'Quote requests can only be assigned to sales staff.');
  }
  const { data, error } = await supabase.from('quote_requests').update(req.body).eq('id', req.params.id).select().single();
  if (error) throw error;
  await logAction({ actorId: req.user.id, action: 'quote_request.update', entity: 'quote_request', entityId: data.id, before, after: data });
  res.json({ quote_request: data });
}));

router.post('/quote-requests/:id/quote', guard(), requireDepartment('sales'), validateBody(z.object({
  amount: z.number().positive().max(100000000), notes: z.string().trim().max(1000).optional(), valid_until: z.string().datetime(),
}).strict()), ah(async (req, res) => {
  const { data, error } = await supabase.rpc('issue_quote_tx', { p_request_id: req.params.id, p_actor: req.user.id, p_amount: req.body.amount, p_notes: req.body.notes || null, p_valid_until: req.body.valid_until });
  if (error) throw error;
  const { data: request } = await supabase.from('quote_requests').select('id, title, profile_id').eq('id', req.params.id).single();
  notify('quoteIssued', { quote: data, request });
  res.status(201).json({ quote: data });
}));

// ----------------------------------------------------------------- tickets
router.get('/support-users', requireSupport(), ah(async (req, res) => {
  const { data, error } = await supabase.from('profiles').select('id, full_name, role').in('role', ['support', 'admin']).eq('is_active', true).order('full_name');
  if (error) throw error;
  res.json({ users: data });
}));

const T_OWNER = 'profiles!tickets_profile_id_fkey(full_name)';
router.get('/tickets', requireSupport(), ah(async (req, res) => {
  const p = pageParams(req.query);
  let q = supabase.from('tickets').select(`id, ticket_number, category, subject, status, assigned_to, order_id, created_at, updated_at, ${T_OWNER}`, { count: 'exact' })
    .order('updated_at', { ascending: false }).range(p.from, p.to);
  if (['open', 'in_progress', 'waiting_client', 'resolved', 'closed'].includes(req.query.status)) q = q.eq('status', req.query.status);
  if (req.query.mine === '1') q = q.eq('assigned_to', req.user.id);
  const { data, count, error } = await q;
  if (error) throw error;
  res.json({ tickets: data, ...pageMeta(p, count) });
}));

router.get('/tickets/:id', guard(), requireSupport(), ah(async (req, res) => {
  const { data: ticket } = await supabase.from('tickets').select(`*, ${T_OWNER}`).eq('id', req.params.id).maybeSingle();
  if (!ticket) throw new HttpError(404, 'NOT_FOUND', 'Ticket not found.');
  const { data: messages } = await supabase.from('ticket_messages').select('id, body, is_internal_note, created_at, author_id, profiles(full_name, role)').eq('ticket_id', ticket.id).order('created_at');
  let order = null; // read-only order lookup, without any payment detail
  if (ticket.order_id) {
    const { data: o } = await supabase.from('orders').select('id, order_number, status, total, created_at, order_items(product_name, quantity)').eq('id', ticket.order_id).maybeSingle();
    order = o;
  }
  res.json({ ticket, messages, order });
}));

router.patch('/tickets/:id', guard(), requireSupport(), validateBody(z.object({
  status: z.enum(['open', 'in_progress', 'waiting_client', 'resolved', 'closed']).optional(), assigned_to: z.string().uuid().nullable().optional(),
}).strict()), ah(async (req, res) => {
  res.json({ ticket: await tickets.updateTicket({ ticketId: req.params.id, actorId: req.user.id, status: req.body.status, assignedTo: req.body.assigned_to }) });
}));

router.post('/tickets/:id/messages', guard(), requireSupport(), validateBody(z.object({ body: z.string().trim().min(1).max(3000), is_internal_note: z.boolean().optional() }).strict()), ah(async (req, res) => {
  const m = await tickets.addMessage({ ticketId: req.params.id, authorId: req.user.id, body: req.body.body, isInternalNote: req.body.is_internal_note, isStaff: true });
  res.status(201).json({ message: m });
}));

module.exports = router;
