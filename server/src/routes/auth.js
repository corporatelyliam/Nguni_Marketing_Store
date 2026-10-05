// server/src/routes/auth.js
const express = require('express');
const { z } = require('zod');
const supabase = require('../db/supabase');
const { newAuthClient } = supabase;
const { validateBody } = require('../middleware/validate');
const { requireAuth, setSessionCookies, clearSessionCookies, resolveSession } = require('../middleware/auth');
const { loginLimiter, authLimiter } = require('../middleware/rateLimit');
const { generateCsrfToken } = require('../middleware/csrf');
const { logAction } = require('../services/audit');
const { notify } = require('../services/notify');
const { ah, HttpError } = require('../lib/http');
const env = require('../config/env');

const router = express.Router();

const email = z.string().trim().toLowerCase().email().max(200);
const password = z.string().min(8, 'At least 8 characters').max(72);
const optText = (n) => z.string().trim().max(n).optional().transform((v) => v || null);

const userShape = (id, mail, p) => ({ id, email: mail, fullName: p.full_name, phone: p.phone, company: p.company, role: p.role, department: p.department });

router.get('/csrf', (req, res) => res.json({ csrfToken: generateCsrfToken(req, res) }));

router.post('/register', authLimiter, validateBody(z.object({
  fullName: z.string().trim().min(2).max(120), email, password, phone: optText(30), company: optText(120),
})), ah(async (req, res) => {
  const { fullName, email: mail, password: pw, phone, company } = req.body;
  const { data: created, error } = await supabase.auth.admin.createUser({ email: mail, password: pw, email_confirm: true });
  if (error) {
    if (/already|registered|exists/i.test(error.message)) throw new HttpError(409, 'EMAIL_IN_USE', 'An account with this email already exists. Try logging in instead.');
    throw new HttpError(400, 'REGISTRATION_FAILED', 'We could not create your account. Please check your details and try again.');
  }
  // role is ALWAYS 'client' here, never read from the request.
  const { error: profileErr } = await supabase.from('profiles').insert({ id: created.user.id, full_name: fullName, phone, company, role: 'client' });
  if (profileErr) { await supabase.auth.admin.deleteUser(created.user.id); throw profileErr; }
  await logAction({ actorId: created.user.id, action: 'auth.register', entity: 'profile', entityId: created.user.id, ip: req.ip });
  notify('accountCreated', { profileId: created.user.id, name: fullName });
  res.status(201).json({ message: 'Account created. Please log in.' });
}));

router.post('/login', loginLimiter, validateBody(z.object({ email, password: z.string().min(1).max(200) })), ah(async (req, res) => {
  const { data, error } = await newAuthClient().auth.signInWithPassword({ email: req.body.email, password: req.body.password });
  if (error || !data?.session) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', data.user.id).maybeSingle();
  if (!profile) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
  if (!profile.is_active) throw new HttpError(403, 'ACCOUNT_INACTIVE', 'This account has been deactivated. Please contact us.');
  setSessionCookies(res, data.session);
  await logAction({ actorId: data.user.id, action: 'auth.login', entity: 'profile', entityId: data.user.id, ip: req.ip });
  res.json({ user: userShape(data.user.id, data.user.email, profile) });
}));

router.post('/logout', ah(async (req, res) => {
  const s = await resolveSession(req, res).catch(() => ({}));
  clearSessionCookies(res);
  if (s.id) await logAction({ actorId: s.id, action: 'auth.logout', entity: 'profile', entityId: s.id });
  res.json({ message: 'Logged out.' });
}));

router.get('/me', requireAuth, (req, res) => res.json({ user: userShape(req.user.id, req.user.email, req.user.profile) }));

router.patch('/me', requireAuth, validateBody(z.object({
  fullName: z.string().trim().min(2).max(120).optional(), phone: z.string().trim().max(30).nullable().optional(), company: z.string().trim().max(120).nullable().optional(),
}).strict()), ah(async (req, res) => {
  const patch = {};
  if (req.body.fullName !== undefined) patch.full_name = req.body.fullName;
  if (req.body.phone !== undefined) patch.phone = req.body.phone || null;
  if (req.body.company !== undefined) patch.company = req.body.company || null;
  const { data, error } = await supabase.from('profiles').update(patch).eq('id', req.user.id).select().single();
  if (error) throw error;
  res.json({ user: userShape(req.user.id, req.user.email, data) });
}));

router.post('/change-password', requireAuth, authLimiter, validateBody(z.object({ currentPassword: z.string().min(1).max(200), newPassword: password }).strict()), ah(async (req, res) => {
  const { error } = await newAuthClient().auth.signInWithPassword({ email: req.user.email, password: req.body.currentPassword });
  if (error) throw new HttpError(400, 'WRONG_PASSWORD', 'Your current password is not correct.');
  const { error: upErr } = await supabase.auth.admin.updateUserById(req.user.id, { password: req.body.newPassword });
  if (upErr) throw new HttpError(400, 'PASSWORD_REJECTED', 'That password could not be used. Please choose a different one.');
  await logAction({ actorId: req.user.id, action: 'auth.password_change', entity: 'profile', entityId: req.user.id, ip: req.ip });
  notify('passwordChanged', { profileId: req.user.id });
  res.json({ message: 'Password changed.' });
}));

// Always answers the same way so it cannot be used to discover which emails have accounts.
router.post('/forgot-password', authLimiter, validateBody(z.object({ email })), ah(async (req, res) => {
  const generic = { message: 'If an account exists for that email, a reset link has been sent.' };
  try {
    const { data: prof } = await supabase.from('profiles').select('id, is_active').limit(1)
      .eq('id', (await findUserIdByEmail(req.body.email)) || '00000000-0000-0000-0000-000000000000').maybeSingle();
    if (prof?.is_active) {
      const { data, error } = await supabase.auth.admin.generateLink({ type: 'recovery', email: req.body.email });
      const token = data?.properties?.hashed_token;
      if (!error && token) notify('passwordReset', { to: req.body.email, link: `${env.appBaseUrl}/reset-password.html?token=${encodeURIComponent(token)}` });
    }
  } catch (err) { console.error('forgot-password:', err.message); } // eslint-disable-line no-console
  res.json(generic);
}));

router.post('/reset-password', authLimiter, validateBody(z.object({ token: z.string().min(10).max(500), password }).strict()), ah(async (req, res) => {
  const bad = new HttpError(400, 'INVALID_RESET_LINK', 'This reset link is invalid or has expired. Please request a new one.');
  const { data, error } = await newAuthClient().auth.verifyOtp({ token_hash: req.body.token, type: 'recovery' });
  if (error || !data?.user) throw bad;
  const { error: upErr } = await supabase.auth.admin.updateUserById(data.user.id, { password: req.body.password });
  if (upErr) throw new HttpError(400, 'PASSWORD_REJECTED', 'That password could not be used. Please choose a different one.');
  await logAction({ actorId: data.user.id, action: 'auth.password_reset', entity: 'profile', entityId: data.user.id, ip: req.ip });
  notify('passwordChanged', { profileId: data.user.id });
  clearSessionCookies(res);
  res.json({ message: 'Password updated. You can now log in.' });
}));

// Look an auth user up by email. profiles has no email column by design (Auth owns it).
async function findUserIdByEmail(mail) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) return null;
    const hit = data.users.find((u) => (u.email || '').toLowerCase() === mail);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

module.exports = router;
module.exports.findUserIdByEmail = findUserIdByEmail;
