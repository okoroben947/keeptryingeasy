// /api/_lib/requireAdmin.js
//
// Shared guard for admin-only, data-mutating endpoints (create/update/delete
// customer, send money). The frontend re-sends the same master password on
// every mutating request as an `x-admin-password` header, and this function
// checks it against the same secret before anything runs.
//
// This is a real improvement over "no check at all", but it is still a
// shared password sent on every request rather than a proper expiring
// session token. If you want to harden this further later, have
// /api/verify-auth issue a signed, short-lived token (e.g. a JWT) instead
// of just returning `{status:true}`, and check that token here instead of
// the raw password.
//
// Required env var: ADMIN_MASTER_PASSWORD (use the same value your
// /api/verify-auth endpoint already compares against).

export default function requireAdmin(req, res) {
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