export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: false, message: 'Method not allowed' });
  }

  const { password } = req.body || {};
  const serverPassword = process.env.DASHBOARD_PASSWORD;

  if (!serverPassword) {
    return res.status(500).json({ status: false, message: 'Dashboard password not set on server.' });
  }

  if (password === serverPassword) {
    return res.status(200).json({ status: true, message: 'Authenticated successfully' });
  } else {
    return res.status(401).json({ status: false, message: 'Incorrect password' });
  }
}