// server/src/services/stock.js: thin wrappers over the atomic SQL stock functions (never mutate inventory from Node).
const supabase = require('../db/supabase');
const { logAction } = require('./audit');

async function adjustStock({ productId, delta, reason, actorId, note }) {
  const { error } = await supabase.rpc('adjust_stock', { p_product_id: productId, p_delta: delta, p_reason: reason, p_actor: actorId, p_note: note || null });
  if (error) throw error;
  await logAction({ actorId, action: 'stock.adjust', entity: 'product', entityId: productId, after: { delta, reason, note } });
}

async function getStockOverview() {
  const { data, error } = await supabase.from('inventory')
    .select('product_id, stock_on_hand, stock_reserved, products(name, low_stock_threshold, is_active)').order('product_id');
  if (error) throw error;
  return data.map((r) => {
    const available = r.stock_on_hand - r.stock_reserved;
    return { productId: r.product_id, name: r.products?.name, onHand: r.stock_on_hand, reserved: r.stock_reserved, available,
      lowStockThreshold: r.products?.low_stock_threshold, isLow: available <= (r.products?.low_stock_threshold ?? 5), isActive: r.products?.is_active };
  });
}

async function getMovements(productId, limit = 100) {
  const { data, error } = await supabase.from('stock_movements')
    .select('id, delta, reason, order_id, note, on_hand_delta, reserved_delta, on_hand_after, reserved_after, created_at, profiles(full_name)')
    .eq('product_id', productId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data;
}

// Public label only: exact numbers are shown only when stock is low, to nudge urgency without leaking inventory.
function stockInfo(inv, threshold) {
  const available = Math.max(0, (inv?.stock_on_hand ?? 0) - (inv?.stock_reserved ?? 0));
  const status = available <= 0 ? 'out_of_stock' : available <= threshold ? 'low_stock' : 'in_stock';
  return { status, available: status === 'low_stock' ? available : undefined, max_order: Math.min(available, 999) };
}

module.exports = { adjustStock, getStockOverview, getMovements, stockInfo };
