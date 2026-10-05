// server/src/routes/quotes.js: a signed-in user's OWN quote requests and quotes. Mounted at /api.
const express = require('express');
const { z } = require('zod');
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const { documentUpload } = require('../middleware/upload');
const { uploadLimiter } = require('../middleware/rateLimit');
const files = require('../services/files');
const { notify } = require('../services/notify');
const { logAction } = require('../services/audit');
const { ah, HttpError, pageParams, pageMeta, customerOrder } = require('../lib/http');

const router = express.Router();
const uuid = z.string().uuid();
const guardId = (name) => (req, res, next) => (uuid.safeParse(req.params[name]).success ? next() : next(new HttpError(404, 'NOT_FOUND', 'Not found.')));

const requestSchema = z.object({
  title: z.string().trim().min(3).max(150),
  description: z.string().trim().max(2000).optional(),
  product_id: z.string().max(60).optional(),
  specs: z.object({
    width: z.number().positive().max(1e6).optional(), height: z.number().positive().max(1e6).optional(),
    unit: z.enum(['mm', 'cm', 'm']).optional(), quantity: z.number().int().positive().max(100000).optional(),
    notes: z.string().trim().max(500).optional(),
  }).strict().optional(),
}).strict();

const CUSTOMER_QUOTE_FIELDS = 'id, amount, notes, valid_until, status, responded_at, created_at';

router.post('/quote-requests', requireAuth, validateBody(requestSchema), ah(async (req, res) => {
  if (req.body.product_id) {
    const { data: p } = await supabase.from('products').select('id').eq('id', req.body.product_id).maybeSingle();
    if (!p) throw new HttpError(400, 'INVALID_PRODUCT', 'That product does not exist.');
  }
  const { data, error } = await supabase.from('quote_requests').insert({
    profile_id: req.user.id, title: req.body.title, description: req.body.description || '', specs: req.body.specs || {}, product_id: req.body.product_id || null,
  }).select().single();
  if (error) throw error;
  await logAction({ actorId: req.user.id, action: 'quote_request.create', entity: 'quote_request', entityId: data.id, after: data });
  notify('quoteRequested', { request: data });
  res.status(201).json({ quote_request: data });
}));

router.get('/quote-requests', requireAuth, ah(async (req, res) => {
  const p = pageParams(req.query);
  const { data, count, error } = await supabase.from('quote_requests')
    .select(`id, title, description, specs, status, product_id, created_at, updated_at, quotes(${CUSTOMER_QUOTE_FIELDS}), files(id, original_name)`, { count: 'exact' })
    .eq('profile_id', req.user.id).order('created_at', { ascending: false }).range(p.from, p.to);
  if (error) throw error;
  res.json({ quote_requests: data, ...pageMeta(p, count) });
}));

router.get('/quote-requests/:id', requireAuth, guardId('id'), ah(async (req, res) => {
  const { data } = await supabase.from('quote_requests')
    .select(`id, title, description, specs, status, product_id, created_at, quotes(${CUSTOMER_QUOTE_FIELDS}), files(id, original_name)`)
    .eq('id', req.params.id).eq('profile_id', req.user.id).maybeSingle();
  if (!data) throw new HttpError(404, 'NOT_FOUND', 'Quote request not found.');
  res.json({ quote_request: data });
}));

router.post('/quote-requests/:id/attachments', requireAuth, guardId('id'), uploadLimiter, ...documentUpload('file'), ah(async (req, res) => {
  const { data: r } = await supabase.from('quote_requests').select('id, status').eq('id', req.params.id).eq('profile_id', req.user.id).maybeSingle();
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'Quote request not found.');
  const { count } = await supabase.from('files').select('id', { count: 'exact', head: true }).eq('quote_request_id', r.id);
  if ((count || 0) >= 10) throw new HttpError(409, 'LIMIT_REACHED', 'You can attach up to 10 files to a request.');
  const f = await files.storePrivate({ buffer: req.file.buffer, mime: req.file.mimetype, ext: req.fileExt, originalName: req.file.originalname, ownerId: req.user.id, purpose: 'quote_attachment', folder: `quote-attachments/${r.id}`, quoteRequestId: r.id });
  res.status(201).json({ file: { id: f.id, original_name: f.original_name } });
}));

const acceptSchema = z.object({
  delivery_method: z.enum(['collection', 'delivery']), address_id: z.string().uuid().nullable().optional(), notes: z.string().trim().max(500).optional(),
}).strict();

async function respond(req, res, accept, body = {}) {
  const { data, error } = await supabase.rpc('respond_quote_tx', {
    p_quote_id: req.params.quoteId, p_profile_id: req.user.id, p_accept: accept,
    p_delivery_method: body.delivery_method || null, p_address_id: body.address_id || null, p_notes: body.notes || null,
  });
  if (error) throw error;
  const { data: q } = await supabase.from('quotes').select('quote_requests(id, title, profile_id)').eq('id', req.params.quoteId).single();
  if (accept) { notify('orderCreated', { order: data.order }); notify('quoteAccepted', { order: data.order, request: q.quote_requests }); res.json({ order: customerOrder(data.order) }); }
  else { notify('quoteDeclined', { request: q.quote_requests }); res.json({ declined: true }); }
}
router.post('/quotes/:quoteId/accept', requireAuth, guardId('quoteId'), validateBody(acceptSchema), ah((req, res) => respond(req, res, true, req.body)));
router.post('/quotes/:quoteId/decline', requireAuth, guardId('quoteId'), ah((req, res) => respond(req, res, false)));

module.exports = router;
