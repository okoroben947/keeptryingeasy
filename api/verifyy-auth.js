// /api/verify-auth.js
//
// Checks the dashboard's master password on login.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ status: false, message: 'Method not allowed. Use POST.' });
  }

  const { password } = req.body || {};
  const expected = process.env.ADMIN_MASTER_PASSWORD;

  if (!expected) {
    return res.status(500).json({
      status: false,
      message: 'Server misconfiguration: ADMIN_MASTER_PASSWORD is not set.'
    });
  }

  if (!password || password !== expected) {
    return res.status(200).json({ status: false, message: 'Invalid master key.' });
  }

  return res.status(200).json({ status: true });
}