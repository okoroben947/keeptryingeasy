// /api/get-my-transactions.js
//
// Returns ONLY the logged-in customer's own wallet transactions -- this is
// the customer-facing counterpart to the admin-only GET on /api/customers.js.
//
// profile.html calls this one. It verifies the caller's Supabase session
// token server-side and only ever returns rows matching that user's id, so
// one customer's browser can never see another customer's transactions --
// that's the whole reason this got split out into its own file.
//
// Method: GET
// Header: Authorization: Bearer <supabase-access-token>
//
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ status: false, message: 'Method not allowed. Use GET.' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ status: false, message: 'Missing auth token.' });
  }

  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (err) {
    console.error('get-my-transactions config error:', err);
    return res.status(500).json({ status: false, message: 'Server misconfiguration.' });
  }

  // Confirm this is a real, currently valid Supabase session -- not a
  // client claiming to be a particular user.
  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) {
    return res.status(401).json({ status: false, message: 'Invalid or expired session.' });
  }

  const { data: transactions, error } = await supabase
    .from('wallet_transactions')
    .select('reference, amount, status, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('get-my-transactions query error:', error);
    return res.status(500).json({ status: false, message: 'Could not load transactions.' });
  }

  return res.status(200).json({
    status: true,
    transactions: (transactions || []).map((t) => ({
      reference: t.reference,
      amount: Math.round(Number(t.amount) * 100), // back to kobo, matching frontend's /100 display
      status: t.status,
      createdAt: t.created_at,
      customer: { email: user.email }
    }))
  });
}