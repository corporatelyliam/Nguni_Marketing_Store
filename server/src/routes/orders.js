// server/src/routes/orders.js: a signed-in user's OWN orders (every query is scoped to req.user.id).
const express = require('express');
const { z } = require('zod');
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const { documentUpload } = require('../middleware/upload');
const { uploadLimiter } = require('../middleware/rateLimit');
const orders = require('../services/orders');
const files = require('../services/files');
const { ah, HttpError, pageParams, pageMeta, customerOrder, customerPayment } = require('../lib/http');

const router = express.Router();
router.use(requireAuth);
const uuid = z.string().uuid();
const guardId = (req, res, next) => (uuid.safeParse(req.params.id).success ? next() : next(new HttpError(404, 'NOT_FOUND', 'Order not found.')));

const orderSchema = z.object({
  items: z.array(z.object({ product_id: z.string().min(1).max(60), quantity: z.number().int().min(1).max(9999) }).strict()).min(1).max(50),
  delivery_method: z.enum(['collection', 'delivery']),
  address_id: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(500).optional(),
  accept_terms: z.literal(true, { errorMap: () => ({ message: 'You must accept the Terms & Conditions.' }) }),
}).strict();

router.post('/', validateBody(orderSchema), ah(async (req, res) => {
  const key = String(req.headers['idempotency-key'] || '').slice(0, 80) || null;
  const order = await orders.createOrder({
    profileId: req.user.id, items: req.body.items, deliveryMethod: req.body.delivery_method,
    addressId: req.body.address_id, notes: req.body.notes, key,
  });
  res.status(order.replayed ? 200 : 201).json({ order: customerOrder(order), payment_instructions: await orders.publicPaymentInstructions(order) });
}));

router.get('/', ah(async (req, res) => {
  const p = pageParams(req.query);
  const { data, count, error } = await supabase.from('orders')
    .select('id, order_number, status, subtotal, delivery_fee, total, delivery_method, delivery_status, created_at, paid_at, order_items(product_name, quantity)', { count: 'exact' })
    .eq('profile_id', req.user.id).order('created_at', { ascending: false }).range(p.from, p.to);
  if (error) throw error;
  res.json({ orders: data, ...pageMeta(p, count) });
}));

router.get('/:id', guardId, ah(async (req, res) => {
  const { data, error } = await supabase.from('orders')
    .select('*, order_items(*), payments(id, status, submitted_at, reject_reason), order_status_history(to_status, note, created_at)')
    .eq('id', req.params.id).eq('profile_id', req.user.id).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'NOT_FOUND', 'Order not found.');
  const { payments, order_status_history: history, ...rest } = data;
  payments.sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
  const awaiting = ['pending_payment', 'payment_rejected'].includes(rest.status);
  res.json({
    order: customerOrder(rest),
    payments: payments.map(customerPayment),
    history: history.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map((h) => ({ status: h.to_status, at: h.created_at, note: h.note })),
    bank_details: awaiting ? await orders.bankDetails() : null,
    collection_address: rest.delivery_method === 'collection' ? await orders.getSetting('collection_address') : null,
  });
}));

router.post('/:id/cancel', guardId, ah(async (req, res) => {
  res.json({ order: customerOrder(await orders.cancelOrder({ orderId: req.params.id, actorId: req.user.id, isStaff: false })) });
}));

// "Order again": which lines of a past order can go straight back in the cart right now.
router.get('/:id/reorder', guardId, ah(async (req, res) => {
  const { data: o } = await supabase.from('orders').select('id, order_items(product_id, product_name, quantity, is_custom)').eq('id', req.params.id).eq('profile_id', req.user.id).maybeSingle();
  if (!o) throw new HttpError(404, 'NOT_FOUND', 'Order not found.');
  const ids = o.order_items.filter((i) => i.product_id).map((i) => i.product_id);
  const { data: prods } = await supabase.from('products').select('id, fulfilment_type, is_active').in('id', ids.length ? ids : ['-']);
  const ok = new Map((prods || []).filter((p) => p.is_active && p.fulfilment_type !== 'quote_only').map((p) => [p.id, p]));
  res.json({ items: o.order_items.map((i) => ({ product_id: i.product_id, name: i.product_name, quantity: i.quantity, available: !!(i.product_id && ok.has(i.product_id)) })) });
}));

router.post('/:id/proof', guardId, uploadLimiter, ...documentUpload('proof'), ah(async (req, res) => {
  const { data: order } = await supabase.from('orders').select('id, status').eq('id', req.params.id).eq('profile_id', req.user.id).maybeSingle();
  if (!order) throw new HttpError(404, 'NOT_FOUND', 'Order not found.');
  // Check BEFORE storing anything so a refused upload never leaves an orphan file behind.
  if (!['pending_payment', 'payment_rejected'].includes(order.status)) throw new HttpError(409, 'INVALID_STATE', 'Proof of payment cannot be uploaded for this order right now.');
  const file = await files.storePrivate({ buffer: req.file.buffer, mime: req.file.mimetype, ext: req.fileExt, originalName: req.file.originalname, ownerId: req.user.id, purpose: 'payment_proof', folder: `payment-proofs/${order.id}` });
  try {
    res.json({ order: customerOrder(await orders.submitProof({ orderId: order.id, profileId: req.user.id, fileId: file.id })) });
  } catch (err) { await files.removePrivate(file); throw err; }
}));

module.exports = router;
