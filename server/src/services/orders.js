// server/src/services/orders.js: order/payment orchestration. The state changes themselves happen
// atomically inside PostgreSQL functions (database/migrations/007); this layer calls them and notifies.
const supabase = require('../db/supabase');
const env = require('../config/env');
const { notify } = require('./notify');

async function getSetting(key, fallback = null) {
  const { data } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  return data ? data.value : fallback;
}
const rpc = async (fn, args) => { const { data, error } = await supabase.rpc(fn, args); if (error) throw error; return data; };

async function createOrder({ profileId, items, deliveryMethod, addressId, notes, key }) {
  const args = { p_profile_id: profileId, p_items: items, p_delivery_method: deliveryMethod, p_address_id: addressId || null, p_notes: notes || null, p_idempotency_key: key || null };
  let order;
  try { order = await rpc('create_order_tx', args); }
  catch (err) {
    // Two identical submits racing: the loser hits the unique index. Return the winner's order.
    if (key && err.code === '23505' && /uq_orders_idempotency/.test(err.message || '')) {
      const { data } = await supabase.rpc('create_order_tx', args);
      order = data;
    } else throw err;
  }
  if (!order.replayed) notify('orderCreated', { order });
  return order;
}

async function submitProof({ orderId, profileId, fileId }) {
  const order = await rpc('submit_payment_tx', { p_order_id: orderId, p_profile_id: profileId, p_file_id: fileId });
  notify('paymentSubmitted', { order });
  return order;
}
async function confirmPayment({ orderId, actorId, bankRef }) {
  const order = await rpc('confirm_payment_tx', { p_order_id: orderId, p_actor: actorId, p_bank_ref: bankRef || null });
  notify('paymentConfirmed', { order });
  return order;
}
async function rejectPayment({ orderId, actorId, reason }) {
  const order = await rpc('reject_payment_tx', { p_order_id: orderId, p_actor: actorId, p_reason: reason });
  notify('paymentRejected', { order, reason });
  return order;
}
async function cancelOrder({ orderId, actorId, isStaff, reason }) {
  const order = await rpc('cancel_order_tx', { p_order_id: orderId, p_actor: actorId, p_is_staff: !!isStaff, p_reason: reason || null });
  notify('orderStatus', { order });
  return order;
}
async function setStatus({ orderId, actorId, status, note }) {
  const order = await rpc('set_order_status_tx', { p_order_id: orderId, p_actor: actorId, p_to: status, p_note: note || null });
  notify('orderStatus', { order });
  return order;
}
async function setDeliveryStatus({ orderId, actorId, status }) {
  return rpc('set_delivery_status_tx', { p_order_id: orderId, p_actor: actorId, p_status: status });
}

// Scheduled job: expire unpaid orders (releasing stock) and lapsed quotes. Safe to run repeatedly.
async function runExpiryJobs() {
  const orders = await rpc('expire_unpaid_orders', {});
  const quotes = await rpc('expire_quotes', {});
  return { orders, quotes };
}

const bankDetails = async () => getSetting('bank_details', {});
const publicPaymentInstructions = async (order) => ({
  method: 'EFT', reference: order.payment_reference, bank_details: await bankDetails(),
  note: 'Use the reference exactly as shown. Upload your proof of payment on your order page after paying. Verification is manual and may take some time.',
});

module.exports = { getSetting, createOrder, submitProof, confirmPayment, rejectPayment, cancelOrder, setStatus, setDeliveryStatus, runExpiryJobs, bankDetails, publicPaymentInstructions, env };
