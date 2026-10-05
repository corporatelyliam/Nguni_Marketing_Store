// server/src/middleware/rbac.js
// Deny-by-default role/department checks. Always run AFTER requireAuth. Admin passes every check.
const deny = (res) => res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have access to this action.' } });

function requireRole(...roles) {
  return (req, res, next) => {
    const role = req.user?.profile?.role;
    return role && roles.includes(role) ? next() : deny(res);
  };
}

// Generic: { departments: ['finance'], roles: ['support'] }. Admin always allowed.
function allow({ departments = [], roles = [] } = {}) {
  return (req, res, next) => {
    const p = req.user?.profile;
    if (!p) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Please log in.' } });
    if (p.role === 'admin') return next();
    if (p.role === 'employee' && departments.includes(p.department)) return next();
    if (roles.includes(p.role)) return next();
    return deny(res);
  };
}

const requireDepartment = (...departments) => allow({ departments });
const requireSupport = () => allow({ roles: ['support'] });
const requireAnyStaff = () => requireRole('employee', 'support', 'admin');

// Who may see payment details (bank refs, who verified): finance + admin only.
const canSeePayments = (profile) => profile.role === 'admin' || (profile.role === 'employee' && profile.department === 'finance');

module.exports = { requireRole, allow, requireDepartment, requireSupport, requireAnyStaff, canSeePayments };
