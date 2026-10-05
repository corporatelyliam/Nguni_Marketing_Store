// server/src/routes/products.js: public, read-only catalogue + the signed-in user's favourites.
const express = require('express');
const { z } = require('zod');
const supabase = require('../db/supabase');
const { stockInfo } = require('../services/stock');
const { requireAuth } = require('../middleware/auth');
const { ah, likeEscape, HttpError } = require('../lib/http');

const router = express.Router();

const shape = (p) => {
  const { inventory, low_stock_threshold, image_path, created_at, updated_at, ...rest } = p; // eslint-disable-line no-unused-vars
  return { ...rest, stock: p.fulfilment_type === 'stocked' ? stockInfo(inventory, low_stock_threshold) : undefined };
};

router.get('/categories', ah(async (req, res) => {
  const { data, error } = await supabase.from('categories').select('*').order('sort_order');
  if (error) throw error;
  res.set('Cache-Control', 'public, max-age=60').json({ categories: data });
}));

const listQuery = z.object({ category: z.string().max(40).optional(), q: z.string().max(80).optional() });
router.get('/products', ah(async (req, res) => {
  const { category, q } = listQuery.parse(req.query);
  let query = supabase.from('products').select('*, inventory(stock_on_hand, stock_reserved)').eq('is_active', true).order('category_id').order('name').limit(500);
  if (category) query = query.eq('category_id', category);
  if (q) query = query.ilike('name', `%${likeEscape(q)}%`);
  const { data, error } = await query;
  if (error) throw error;
  res.json({ products: data.map(shape) });
}));

router.get('/products/:id', ah(async (req, res) => {
  const { data: p } = await supabase.from('products').select('*, inventory(stock_on_hand, stock_reserved)').eq('id', req.params.id.slice(0, 60)).eq('is_active', true).maybeSingle();
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'Product not found.');
  res.json({ product: shape(p) });
}));

router.get('/config/public', ah(async (req, res) => {
  const { data, error } = await supabase.from('settings').select('key, value').in('key', ['terms_version', 'order_expiry_hours', 'collection_address', 'delivery']);
  if (error) throw error;
  const c = Object.fromEntries(data.map((r) => [r.key, r.value]));
  const d = c.delivery || {};
  res.json({ config: {
    terms_version: c.terms_version, order_expiry_hours: c.order_expiry_hours, collection_address: c.collection_address,
    delivery: { enabled: d.enabled !== false, flat_fee: Number(d.flat_fee || 0), free_over: d.free_over ?? null, note: d.note || '' },
  } });
}));

// ---- favourites (signed-in users) ----
router.get('/me/favourites', requireAuth, ah(async (req, res) => {
  const { data, error } = await supabase.from('favourites').select('product_id').eq('profile_id', req.user.id);
  if (error) throw error;
  res.json({ product_ids: data.map((r) => r.product_id) });
}));
router.put('/me/favourites/:productId', requireAuth, ah(async (req, res) => {
  const { data: p } = await supabase.from('products').select('id').eq('id', req.params.productId.slice(0, 60)).eq('is_active', true).maybeSingle();
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'Product not found.');
  const { error } = await supabase.from('favourites').upsert({ profile_id: req.user.id, product_id: p.id });
  if (error) throw error;
  res.json({ message: 'Saved.' });
}));
router.delete('/me/favourites/:productId', requireAuth, ah(async (req, res) => {
  const { error } = await supabase.from('favourites').delete().eq('profile_id', req.user.id).eq('product_id', req.params.productId.slice(0, 60));
  if (error) throw error;
  res.json({ message: 'Removed.' });
}));

module.exports = router;
