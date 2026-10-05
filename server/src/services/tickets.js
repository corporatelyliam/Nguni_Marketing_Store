// server/src/services/tickets.js
const crypto = require('crypto');
const supabase = require('../db/supabase');
const { logAction } = require('./audit');
const { notify } = require('./notify');
const { HttpError } = require('../lib/http');

async function createTicket({ profileId, category, subject, body, orderId }) {
  let ticket;
  for (let i = 0; i < 6 && !ticket; i += 1) {
    const { data, error } = await supabase.from('tickets').insert({
      ticket_number: `TCK-${crypto.randomInt(10000, 99999)}`, profile_id: profileId, category, subject, order_id: orderId || null,
    }).select().single();
    if (error && error.code !== '23505') throw error;
    ticket = data;
  }
  if (!ticket) throw new Error('Could not allocate a ticket number.');
  const { error: msgErr } = await supabase.from('ticket_messages').insert({ ticket_id: ticket.id, author_id: profileId, body });
  if (msgErr) throw msgErr;
  await logAction({ actorId: profileId, action: 'ticket.create', entity: 'ticket', entityId: ticket.id, after: ticket });
  notify('ticketCreated', { ticket });
  return ticket;
}

// isStaff replies appear to the customer (unless isInternalNote). Customers can never write notes.
async function addMessage({ ticketId, authorId, body, isInternalNote = false, isStaff }) {
  const { data: ticket } = await supabase.from('tickets').select('*').eq('id', ticketId).maybeSingle();
  if (!ticket || (!isStaff && ticket.profile_id !== authorId)) throw new HttpError(404, 'NOT_FOUND', 'Ticket not found.');
  if (isInternalNote && !isStaff) throw new HttpError(403, 'FORBIDDEN', 'You do not have access to this action.');
  if (ticket.status === 'closed') throw new HttpError(409, 'TICKET_CLOSED', 'This ticket is closed. Please open a new ticket.');

  const { data: message, error } = await supabase.from('ticket_messages')
    .insert({ ticket_id: ticketId, author_id: authorId, body, is_internal_note: !!isInternalNote }).select().single();
  if (error) throw error;

  let next = null;
  if (isStaff && !isInternalNote && ['open', 'resolved'].includes(ticket.status)) next = 'in_progress';
  if (!isStaff && ['waiting_client', 'resolved'].includes(ticket.status)) next = 'in_progress'; // customer reply re-opens
  if (next) await supabase.from('tickets').update({ status: next, closed_at: null }).eq('id', ticketId);
  else await supabase.from('tickets').update({ status: ticket.status }).eq('id', ticketId); // bump updated_at

  if (!isInternalNote) notify(isStaff ? 'ticketReply' : 'ticketCustomerReply', { ticket });
  return message;
}

async function updateTicket({ ticketId, actorId, status, assignedTo }) {
  const { data: before } = await supabase.from('tickets').select('*').eq('id', ticketId).maybeSingle();
  if (!before) throw new HttpError(404, 'NOT_FOUND', 'Ticket not found.');
  const patch = {};
  if (status) { patch.status = status; patch.closed_at = ['closed', 'resolved'].includes(status) ? new Date().toISOString() : null; }
  if (assignedTo !== undefined) {
    if (assignedTo) {
      const { data: a } = await supabase.from('profiles').select('role, is_active').eq('id', assignedTo).maybeSingle();
      if (!a || !a.is_active || !['support', 'admin'].includes(a.role)) throw new HttpError(400, 'INVALID_ASSIGNEE', 'Tickets can only be assigned to support or admin staff.');
    }
    patch.assigned_to = assignedTo;
  }
  const { data: updated, error } = await supabase.from('tickets').update(patch).eq('id', ticketId).select().single();
  if (error) throw error;
  await logAction({ actorId, action: 'ticket.update', entity: 'ticket', entityId: ticketId, before, after: updated });
  return updated;
}

module.exports = { createTicket, addMessage, updateTicket };
