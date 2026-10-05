// server/src/routes/tickets.js: a signed-in user's OWN tickets. Internal notes are never returned here.
const express = require('express');
const { z } = require('zod');
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const tickets = require('../services/tickets');
const { ah, HttpError, pageParams, pageMeta } = require('../lib/http');

const router = express.Router();
router.use(requireAuth);
const uuid = z.string().uuid();
const guardId = (req, res, next) => (uuid.safeParse(req.params.id).success ? next() : next(new HttpError(404, 'NOT_FOUND', 'Ticket not found.')));

router.post('/', validateBody(z.object({
  category: z.enum(['order', 'payment', 'technical', 'general']), subject: z.string().trim().min(3).max(150),
  body: z.string().trim().min(1).max(3000), order_id: z.string().uuid().optional(),
}).strict()), ah(async (req, res) => {
  if (req.body.order_id) {
    const { data: o } = await supabase.from('orders').select('id').eq('id', req.body.order_id).eq('profile_id', req.user.id).maybeSingle();
    if (!o) throw new HttpError(400, 'INVALID_ORDER', 'That order does not belong to you.');
  }
  res.status(201).json({ ticket: await tickets.createTicket({ profileId: req.user.id, category: req.body.category, subject: req.body.subject, body: req.body.body, orderId: req.body.order_id }) });
}));

router.get('/', ah(async (req, res) => {
  const p = pageParams(req.query);
  const { data, count, error } = await supabase.from('tickets')
    .select('id, ticket_number, category, subject, status, order_id, created_at, updated_at', { count: 'exact' })
    .eq('profile_id', req.user.id).order('updated_at', { ascending: false }).range(p.from, p.to);
  if (error) throw error;
  res.json({ tickets: data, ...pageMeta(p, count) });
}));

router.get('/:id', guardId, ah(async (req, res) => {
  const { data: ticket } = await supabase.from('tickets').select('id, ticket_number, category, subject, status, order_id, created_at, updated_at').eq('id', req.params.id).eq('profile_id', req.user.id).maybeSingle();
  if (!ticket) throw new HttpError(404, 'NOT_FOUND', 'Ticket not found.');
  const { data: msgs } = await supabase.from('ticket_messages').select('id, author_id, body, created_at').eq('ticket_id', ticket.id).eq('is_internal_note', false).order('created_at');
  // Show who wrote it without exposing staff identities: just "you" or "support".
  res.json({ ticket, messages: msgs.map((m) => ({ id: m.id, body: m.body, created_at: m.created_at, mine: m.author_id === req.user.id })) });
}));

router.post('/:id/messages', guardId, validateBody(z.object({ body: z.string().trim().min(1).max(3000) }).strict()), ah(async (req, res) => {
  const m = await tickets.addMessage({ ticketId: req.params.id, authorId: req.user.id, body: req.body.body, isStaff: false });
  res.status(201).json({ message: { id: m.id, body: m.body, created_at: m.created_at, mine: true } });
}));

// Customers may close their own ticket.
router.post('/:id/close', guardId, ah(async (req, res) => {
  const { data: t } = await supabase.from('tickets').select('id').eq('id', req.params.id).eq('profile_id', req.user.id).maybeSingle();
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'Ticket not found.');
  res.json({ ticket: await tickets.updateTicket({ ticketId: t.id, actorId: req.user.id, status: 'closed' }) });
}));

module.exports = router;
