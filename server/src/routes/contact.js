// server/src/routes/contact.js: the public "Send us a message" form on contact.html.
const express = require('express');
const { z } = require('zod');
const supabase = require('../db/supabase');
const { validateBody } = require('../middleware/validate');
const { contactLimiter } = require('../middleware/rateLimit');
const { notify } = require('../services/notify');
const { ah } = require('../lib/http');

const router = express.Router();
router.post('/', contactLimiter, validateBody(z.object({
  name: z.string().trim().min(2).max(120), email: z.string().trim().email().max(200),
  phone: z.string().trim().max(30).optional(), service: z.string().trim().max(80).optional(),
  message: z.string().trim().min(5).max(3000), website: z.string().max(0).optional(), // honeypot: real people leave it empty
}).strict()), ah(async (req, res) => {
  const { website, ...fields } = req.body; // eslint-disable-line no-unused-vars
  const { data, error } = await supabase.from('contact_messages').insert(fields).select().single();
  if (error) throw error;
  notify('contactMessage', { msg: data });
  res.status(201).json({ message: 'Thank you! Your message has been sent and we will be in touch soon.' });
}));
module.exports = router;
