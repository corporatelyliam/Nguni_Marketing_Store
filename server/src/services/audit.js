// server/src/services/audit.js
// Application-level audit entries (money/stock/order actions are audited inside the database
// functions themselves, in the same transaction). The table is append-only at the DB level.
const supabase = require('../db/supabase');

async function logAction({ actorId, action, entity, entityId, before = null, after = null, ip = null }) {
  const { error } = await supabase.from('audit_log').insert({
    actor_id: actorId || null, action, entity, entity_id: entityId ? String(entityId) : null, before, after, ip,
  });
  if (error) console.error('audit_log insert failed:', error.message); // eslint-disable-line no-console
}

module.exports = { logAction };
