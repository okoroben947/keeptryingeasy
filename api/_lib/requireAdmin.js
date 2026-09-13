// /api/_lib/requireAdmin.js
//
// Shared guard for admin-only, data-mutating endpoints.

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