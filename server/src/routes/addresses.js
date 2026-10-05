// server/src/routes/addresses.js: the signed-in user's own delivery addresses.
const express = require('express');
const { z } = require('zod');
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const { ah } = require('../lib/http');

const router = express.Router();
router.use(requireAuth);
const uuid = z.string().uuid();

router.get('/', ah(async (req, res) => {
  const { data, error } = await supabase.from('addresses').select('*').eq('profile_id', req.user.id).order('created_at');
  if (error) throw error;
  res.json({ addresses: data });
}));

const addressSchema = z.object({
  label: z.string().trim().min(1).max(60).default('Main'),
  line1: z.string().trim().min(2).max(200), line2: z.string().trim().max(200).optional(),
  town: z.string().trim().min(2).max(100), region: z.string().trim().max(100).optional(), notes: z.string().trim().max(300).optional(),
}).strict();

router.post('/', validateBody(addressSchema), ah(async (req, res) => {
  const { count } = await supabase.from('addresses').select('id', { count: 'exact', head: true }).eq('profile_id', req.user.id);
  if ((count || 0) >= 20) return res.status(409).json({ error: { code: 'LIMIT_REACHED', message: 'You can save up to 20 addresses.' } });
  const { data, error } = await supabase.from('addresses').insert({ ...req.body, profile_id: req.user.id }).select().single();
  if (error) throw error;
  res.status(201).json({ address: data });
}));

router.delete('/:id', ah(async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Address not found.' } });
  const { error } = await supabase.from('addresses').delete().eq('id', req.params.id).eq('profile_id', req.user.id);
  if (error) throw error;
  res.json({ message: 'Deleted.' });
}));

module.exports = router;
