// /api/_lib/requireAdmin.js
//
// Shared guard for admin-only, data-mutating endpoints (create/update/delete
// customer, send money). The frontend re-sends the same master password on
// every mutating request as an `x-admin-password` header, and this function
// checks it against the same secret before anything runs.
//
// Required env var: ADMIN_MASTER_PASSWORD (use the same value your
// /api/verify-auth endpoint already compares against).

export function requireAdmin(req, res) {
  const provided = req.headers['x-admin-password'];
  const expected = process.env.ADMIN_MASTER_PASSWORD;

  if (!expected) {
    res.status(500).json({
      status: false,
      message: 'Server misconfiguration: ADMIN_MASTER_PASSWORD is not set.'
    });
    return false;
  }

  if (!provided || provided !== expected) {
    res.status(401).json({
      status: false,
      message: 'Unauthorized. Missing or invalid admin credentials.'
    });
    return false;
  }

  return true;
}

// Exported as default as well so both `import requireAdmin` and `import { requireAdmin }` work seamlessly
export default requireAdmin;