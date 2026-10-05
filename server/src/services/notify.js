// server/src/services/notify.js
// Event-driven notifications. Callers say WHAT happened; this decides who hears about it and how.
// Channels are pluggable: add another object with { name, send({to,subject,text}) } to `channels`.
const supabase = require('../db/supabase');
const env = require('../config/env');
const email = require('./email');

const channels = [email.channel];
const money = (n) => `N$${Number(n || 0).toLocaleString('en-NA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const label = (s) => String(s || '').replace(/_/g, ' ');
const url = (p) => `${env.appBaseUrl}${p}`;

async function emailOf(profileId) {
  if (!profileId) return null;
  const { data } = await supabase.auth.admin.getUserById(profileId);
  return data?.user?.email || null;
}
async function staffEmail(kind) {
  const { data } = await supabase.from('settings').select('value').eq('key', 'notifications').maybeSingle();
  return data?.value?.[`${kind}_email`] || null;
}
async function deliver(to, subject, text) {
  if (!to) return;
  for (const ch of channels) await ch.send({ to, subject, text });
}

const events = {
  accountCreated: async ({ profileId, name }) => deliver(await emailOf(profileId), 'Welcome to Nguni Marketing', `Hi ${name},\n\nYour account has been created. You can now order online, request quotes and track everything at ${url('/account.html')}.`),
  passwordReset: async ({ to, link }) => deliver(to, 'Reset your Nguni Marketing password', `We received a request to reset your password.\n\nUse this link within one hour:\n${link}\n\nIf you did not ask for this, you can ignore this email; your password will not change.`),
  passwordChanged: async ({ profileId }) => deliver(await emailOf(profileId), 'Your password was changed', 'Your Nguni Marketing password was just changed. If this was not you, contact us immediately.'),
  orderCreated: async ({ order }) => deliver(await emailOf(order.profile_id), `Order ${order.order_number} received`,
    `Thank you for your order ${order.order_number}.\nTotal: ${money(order.total)}\n\nPay by EFT using the exact reference ${order.payment_reference} (bank details are on your order page: ${url('/order.html?id=' + order.id)}), then upload your proof of payment there.\nThis order is held until ${new Date(order.expires_at).toUTCString()}.`),
  paymentSubmitted: async ({ order }) => {
    await deliver(await emailOf(order.profile_id), `Proof of payment received for ${order.order_number}`, 'We have received your proof of payment. Our finance team will verify it against our bank statement shortly.');
    await deliver(await staffEmail('finance'), `[Finance] Proof of payment awaiting review: ${order.order_number}`, `Order ${order.order_number} (${money(order.total)}) has a new proof of payment awaiting verification.`);
  },
  paymentConfirmed: async ({ order }) => deliver(await emailOf(order.profile_id), `Payment confirmed for ${order.order_number}`, 'Your payment has been confirmed and your order is now being processed.'),
  paymentRejected: async ({ order, reason }) => deliver(await emailOf(order.profile_id), `Payment could not be verified for ${order.order_number}`, `We could not verify your payment for order ${order.order_number}.\nReason: ${reason}\n\nPlease upload a new proof of payment: ${url('/order.html?id=' + order.id)}`),
  orderStatus: async ({ order }) => deliver(await emailOf(order.profile_id), `Order ${order.order_number} update: ${label(order.status)}`, `Your order ${order.order_number} is now: ${label(order.status)}.${order.cancel_reason ? `\nReason: ${order.cancel_reason}` : ''}\n\n${url('/order.html?id=' + order.id)}`),
  quoteIssued: async ({ quote, request }) => deliver(await emailOf(request.profile_id), `Your quote for "${request.title}" is ready`, `We have prepared a quote of ${money(quote.amount)} for "${request.title}", valid until ${new Date(quote.valid_until).toUTCString()}.\nLog in to accept or decline: ${url('/account.html#quotes')}`),
  quoteAccepted: async ({ order, request }) => deliver(await staffEmail('sales'), `[Sales] Quote accepted: ${request.title}`, `The customer accepted the quote for "${request.title}". Order ${order.order_number} (${money(order.total)}) was created and is awaiting EFT payment.`),
  quoteDeclined: async ({ request }) => deliver(await staffEmail('sales'), `[Sales] Quote declined: ${request.title}`, `The customer declined the quote for "${request.title}".`),
  quoteRequested: async ({ request }) => deliver(await staffEmail('sales'), `[Sales] New quote request: ${request.title}`, `A new quote request "${request.title}" is waiting in the staff dashboard.`),
  ticketCreated: async ({ ticket }) => deliver(await staffEmail('support'), `[Support] New ticket ${ticket.ticket_number}`, `New ${ticket.category} ticket: ${ticket.subject}`),
  ticketReply: async ({ ticket }) => deliver(await emailOf(ticket.profile_id), `New reply on ticket ${ticket.ticket_number}`, `There is a new reply on your support ticket "${ticket.subject}".\n${url('/support.html')}`),
  ticketCustomerReply: async ({ ticket }) => deliver((await emailOf(ticket.assigned_to)) || (await staffEmail('support')), `[Support] Customer replied on ${ticket.ticket_number}`, `The customer replied on "${ticket.subject}".`),
  contactMessage: async ({ msg }) => deliver(await staffEmail('contact'), `[Website] Message from ${msg.name}`, `${msg.name} <${msg.email}> ${msg.phone || ''}\nInterested in: ${msg.service || '-'}\n\n${msg.message}`),
};

// notify('orderCreated', { order }) : fire-and-forget; never throws, never blocks the response.
function notify(event, ctx) {
  const fn = events[event];
  if (!fn) return Promise.resolve();
  return Promise.resolve().then(() => fn(ctx)).catch((err) => console.error(`[notify:${event}] failed:`, err.message)); // eslint-disable-line no-console
}

module.exports = { notify, emailOf, channels };
