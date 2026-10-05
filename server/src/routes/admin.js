// server/src/routes/admin.js: administrators only (requireRole('admin') on the whole router).
const express = require('express');
const { z } = require('zod');
const supabase = require('../db/supabase');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { validateBody } = require('../middleware/validate');
const { imageUpload } = require('../middleware/upload');
const { uploadLimiter } = require('../middleware/rateLimit');
const { logAction } = require('../services/audit');
const stock = require('../services/stock');
const files = require('../services/files');
const { ah, HttpError, pageParams, pageMeta, likeEscape } = require('../lib/http');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));
const uuid = z.string().uuid();
const guard = (req, res, next) => (uuid.safeParse(req.params.id).success ? next() : next(new HttpError(404, 'NOT_FOUND', 'Not found.')));

// ---------------------------------------------------------------- dashboard
router.get('/dashboard', ah(async (req, res) => {
  const { data: stats, error } = await supabase.rpc('dashboard_stats');
  if (error) throw error;
  const { data: rows } = await supabase.from('settings').select('key, value').in('key', ['bank_details', 'notifications']);
  const s = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
  const bank = s.bank_details || {};
  res.json({ stats, setup: {
    bank_details_configured: !!(bank.bank && bank.account_number),
    notification_emails_configured: !!Object.values(s.notifications || {}).some(Boolean),
  } });
}));

// ----------------------------------------------------------------- products
const slug = z.string().min(2).max(40).regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and dashes');
const imageUrl = z.string().max(500).regex(/^(https?:\/\/|\/|images\/)/, 'Must be an http(s) URL or a path inside the site');
const productFields = {
  category_id: z.string().min(1).max(40), name: z.string().trim().min(2).max(150), description: z.string().trim().max(2000),
  price: z.number().min(0).max(10000000), unit: z.string().trim().min(1).max(60), price_is_from: z.boolean(),
  fulfilment_type: z.enum(['stocked', 'made_to_order', 'quote_only']), lead_time_note: z.string().trim().max(200).nullable(),
  low_stock_threshold: z.number().int().min(0).max(100000), is_active: z.boolean(), image_url: imageUrl.nullable(),
};
const createSchema = z.object({
  id: slug, category_id: productFields.category_id, name: productFields.name,
  description: productFields.description.default(''), price: productFields.price, unit: productFields.unit.default('each'),
  price_is_from: productFields.price_is_from.default(false), fulfilment_type: productFields.fulfilment_type,
  lead_time_note: productFields.lead_time_note.optional(), low_stock_threshold: productFields.low_stock_threshold.default(5),
  image_url: imageUrl.optional(), initial_stock: z.number().int().min(0).max(1000000).optional(),
}).strict();
const patchSchema = z.object(productFields).partial().strict();

router.get('/products', ah(async (req, res) => {
  const p = pageParams({ pageSize: 100, ...req.query });
  let q = supabase.from('products').select('*, inventory(stock_on_hand, stock_reserved)', { count: 'exact' }).order('category_id').order('name').range(p.from, p.to);
  if (req.query.q) q = q.ilike('name', `%${likeEscape(req.query.q)}%`);
  if (req.query.category) q = q.eq('category_id', String(req.query.category).slice(0, 40));
  if (req.query.active === 'true' || req.query.active === 'false') q = q.eq('is_active', req.query.active === 'true');
  const { data, count, error } = await q;
  if (error) throw error;
  res.json({ products: data, ...pageMeta(p, count) });
}));

router.post('/products', validateBody(createSchema), ah(async (req, res) => {
  const { initial_stock: initial, ...fields } = req.body;
  const { data: product, error } = await supabase.from('products').insert(fields).select().single();
  if (error) throw error;
  if (initial && product.fulfilment_type === 'stocked') await stock.adjustStock({ productId: product.id, delta: initial, reason: 'initial_stock', actorId: req.user.id, note: 'Opening stock on product creation' });
  await logAction({ actorId: req.user.id, action: 'product.create', entity: 'product', entityId: product.id, after: product });
  res.status(201).json({ product });
}));

router.patch('/products/:id', validateBody(patchSchema), ah(async (req, res) => {
  const { data: before } = await supabase.from('products').select('*').eq('id', req.params.id).maybeSingle();
  if (!before) throw new HttpError(404, 'NOT_FOUND', 'Product not found.');
  if (!Object.keys(req.body).length) throw new HttpError(400, 'VALIDATION_ERROR', 'Nothing to update.');
  const patch = { ...req.body };
  if ('image_url' in patch) patch.image_path = null; // a manually set URL replaces an uploaded image
  const { data: updated, error } = await supabase.from('products').update(patch).eq('id', req.params.id).select().single();
  if (error) throw error;
  if ('image_url' in patch && before.image_path) await files.removeProductImage(before.image_path);
  const priceChanged = 'price' in patch && Number(before.price) !== Number(updated.price);
  await logAction({ actorId: req.user.id, action: priceChanged ? 'product.price_change' : 'product.update', entity: 'product', entityId: updated.id, before, after: updated });
  res.json({ product: updated });
}));

const setActive = (active) => ah(async (req, res) => {
  const { data: before } = await supabase.from('products').select('is_active').eq('id', req.params.id).maybeSingle();
  if (!before) throw new HttpError(404, 'NOT_FOUND', 'Product not found.');
  const { data, error } = await supabase.from('products').update({ is_active: active }).eq('id', req.params.id).select().single();
  if (error) throw error;
  await logAction({ actorId: req.user.id, action: active ? 'product.activate' : 'product.deactivate', entity: 'product', entityId: data.id, before, after: { is_active: active } });
  res.json({ product: data });
});
router.post('/products/:id/deactivate', setActive(false));
router.post('/products/:id/activate', setActive(true));

router.post('/products/:id/image', uploadLimiter, ...imageUpload('image'), ah(async (req, res) => {
  const { data: before } = await supabase.from('products').select('id, image_path, image_url').eq('id', req.params.id).maybeSingle();
  if (!before) throw new HttpError(404, 'NOT_FOUND', 'Product not found.');
  const img = await files.storeProductImage({ productId: before.id, buffer: req.file.buffer, mime: req.file.mimetype, ext: req.fileExt });
  const { data, error } = await supabase.from('products').update({ image_url: img.url, image_path: img.path }).eq('id', before.id).select().single();
  if (error) { await files.removeProductImage(img.path); throw error; }
  await files.removeProductImage(before.image_path); // replace = delete the previous upload
  await logAction({ actorId: req.user.id, action: 'product.image', entity: 'product', entityId: before.id, before: { image_url: before.image_url }, after: { image_url: img.url } });
  res.json({ product: data });
}));

router.delete('/products/:id/image', ah(async (req, res) => {
  const { data: before } = await supabase.from('products').select('id, image_path, image_url').eq('id', req.params.id).maybeSingle();
  if (!before) throw new HttpError(404, 'NOT_FOUND', 'Product not found.');
  const { data, error } = await supabase.from('products').update({ image_url: null, image_path: null }).eq('id', before.id).select().single();
  if (error) throw error;
  await files.removeProductImage(before.image_path);
  await logAction({ actorId: req.user.id, action: 'product.image_remove', entity: 'product', entityId: before.id, before: { image_url: before.image_url } });
  res.json({ product: data });
}));

// -------------------------------------------------------------------- users
async function withEmails(rows) {
  return Promise.all(rows.map(async (u) => ({ ...u, email: (await supabase.auth.admin.getUserById(u.id)).data?.user?.email || null })));
}

router.get('/users', ah(async (req, res) => {
  const p = pageParams(req.query);
  let q = supabase.from('profiles').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(p.from, p.to);
  if (['client', 'employee', 'support', 'admin'].includes(req.query.role)) q = q.eq('role', req.query.role);
  if (req.query.q) q = q.ilike('full_name', `%${likeEscape(req.query.q)}%`);
  const { data, count, error } = await q;
  if (error) throw error;
  res.json({ users: await withEmails(data), ...pageMeta(p, count) });
}));

const staffSchema = z.object({
  fullName: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(8).max(72),
  role: z.enum(['employee', 'support', 'admin']), department: z.enum(['finance', 'sales', 'operations']).optional(),
}).strict().refine((v) => v.role !== 'employee' || !!v.department, { message: 'A department is required for employees.', path: ['department'] });

router.post('/users', validateBody(staffSchema), ah(async (req, res) => {
  const { fullName, email, password, role, department } = req.body;
  const { data: created, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) {
    if (/already|registered|exists/i.test(error.message)) throw new HttpError(409, 'EMAIL_IN_USE', 'An account with that email already exists.');
    throw new HttpError(400, 'CREATE_FAILED', 'The account could not be created. Check the email and password.');
  }
  const { data: profile, error: pErr } = await supabase.from('profiles').insert({ id: created.user.id, full_name: fullName, role, department: role === 'employee' ? department : null }).select().single();
  if (pErr) { await supabase.auth.admin.deleteUser(created.user.id); throw pErr; }
  await logAction({ actorId: req.user.id, action: 'user.create', entity: 'profile', entityId: profile.id, after: { ...profile, email } });
  res.status(201).json({ user: { ...profile, email } });
}));

const userPatch = z.object({
  role: z.enum(['client', 'employee', 'support', 'admin']).optional(), department: z.enum(['finance', 'sales', 'operations']).nullable().optional(),
  is_active: z.boolean().optional(), full_name: z.string().trim().min(2).max(120).optional(),
}).strict();

router.patch('/users/:id', guard, validateBody(userPatch), ah(async (req, res) => {
  const { data: before } = await supabase.from('profiles').select('*').eq('id', req.params.id).maybeSingle();
  if (!before) throw new HttpError(404, 'NOT_FOUND', 'User not found.');
  const b = req.body;
  const changesAccess = (b.role && b.role !== before.role) || b.is_active === false || (b.department !== undefined && b.department !== before.department);
  if (req.params.id === req.user.id && changesAccess) throw new HttpError(400, 'CANNOT_MODIFY_SELF', 'You cannot change your own role or deactivate yourself.');

  const role = b.role || before.role;
  let department = b.department !== undefined ? b.department : before.department;
  if (role === 'employee' && !department) throw new HttpError(400, 'DEPARTMENT_REQUIRED', 'Choose a department for an employee.');
  if (role !== 'employee') department = null;

  const losingAdmin = before.role === 'admin' && before.is_active && (role !== 'admin' || b.is_active === false);
  if (losingAdmin) {
    const { count } = await supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin').eq('is_active', true).neq('id', before.id);
    if (!count) throw new HttpError(409, 'LAST_ADMIN', 'There must always be at least one active administrator.');
  }
  const patch = { role, department };
  if (b.is_active !== undefined) patch.is_active = b.is_active;
  if (b.full_name) patch.full_name = b.full_name;
  const { data: updated, error } = await supabase.from('profiles').update(patch).eq('id', req.params.id).select().single();
  if (error) throw error;
  const action = b.is_active !== undefined && b.is_active !== before.is_active ? (b.is_active ? 'user.activate' : 'user.deactivate') : role !== before.role || department !== before.department ? 'user.role_change' : 'user.update';
  await logAction({ actorId: req.user.id, action, entity: 'profile', entityId: updated.id, before, after: updated });
  res.json({ user: updated });
}));

// ----------------------------------------------------------------- settings
const emailOrBlank = z.union([z.literal(''), z.string().trim().email().max(200)]);
const text = (n) => z.string().trim().max(n);
const SETTINGS = {
  bank_details: z.object({ bank: text(100), account_name: text(120), account_number: text(40), branch_code: text(20), account_type: text(40).optional().default(''), notes: text(300).optional().default('') }).strict(),
  order_expiry_hours: z.number().int().min(1).max(720),
  terms_version: text(20).min(1),
  low_stock_default: z.number().int().min(0).max(100000),
  collection_address: text(200).min(1),
  delivery: z.object({ enabled: z.boolean(), flat_fee: z.number().min(0).max(100000), free_over: z.number().min(0).max(100000000).nullable(), note: text(200) }).strict(),
  notifications: z.object({ finance_email: emailOrBlank, sales_email: emailOrBlank, support_email: emailOrBlank, contact_email: emailOrBlank }).strict(),
};

router.get('/settings', ah(async (req, res) => {
  const { data, error } = await supabase.from('settings').select('key, value, updated_at');
  if (error) throw error;
  res.json({ settings: Object.fromEntries(data.map((r) => [r.key, r.value])), keys: Object.keys(SETTINGS) });
}));

router.put('/settings/:key', ah(async (req, res) => {
  const schema = SETTINGS[req.params.key];
  if (!schema) throw new HttpError(404, 'UNKNOWN_SETTING', 'Unknown setting.');
  const parsed = schema.safeParse(req.body?.value);
  if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'That value is not valid for this setting.', details: parsed.error.flatten() } });
  const { data: before } = await supabase.from('settings').select('value').eq('key', req.params.key).maybeSingle();
  const { data, error } = await supabase.from('settings').upsert({ key: req.params.key, value: parsed.data, updated_by: req.user.id, updated_at: new Date().toISOString() }).select().single();
  if (error) throw error;
  await logAction({ actorId: req.user.id, action: 'settings.update', entity: 'settings', entityId: req.params.key, before: before?.value ?? null, after: parsed.data });
  res.json({ setting: data });
}));

// ---------------------------------------------------------------- audit log
router.get('/audit-log', ah(async (req, res) => {
  const p = pageParams(req.query);
  let q = supabase.from('audit_log').select('id, action, entity, entity_id, before, after, ip, created_at, actor_id, profiles(full_name)', { count: 'exact' }).order('created_at', { ascending: false }).range(p.from, p.to);
  if (req.query.entity) q = q.eq('entity', String(req.query.entity).slice(0, 40));
  if (req.query.action) q = q.ilike('action', `${likeEscape(req.query.action)}%`);
  if (req.query.actor && uuid.safeParse(req.query.actor).success) q = q.eq('actor_id', req.query.actor);
  const { data, count, error } = await q;
  if (error) throw error;
  res.json({ audit_log: data, ...pageMeta(p, count) });
}));

// ---------------------------------------------------- website contact inbox
router.get('/contact-messages', ah(async (req, res) => {
  const p = pageParams(req.query);
  let q = supabase.from('contact_messages').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(p.from, p.to);
  if (['new', 'handled'].includes(req.query.status)) q = q.eq('status', req.query.status);
  const { data, count, error } = await q;
  if (error) throw error;
  res.json({ messages: data, ...pageMeta(p, count) });
}));
router.post('/contact-messages/:id/handled', guard, ah(async (req, res) => {
  const { data, error } = await supabase.from('contact_messages').update({ status: 'handled', handled_by: req.user.id, handled_at: new Date().toISOString() }).eq('id', req.params.id).select().maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'NOT_FOUND', 'Message not found.');
  res.json({ message: data });
}));

module.exports = router;
