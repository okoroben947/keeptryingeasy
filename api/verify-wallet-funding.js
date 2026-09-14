// /api/verify-wallet-funding.js
//
// Called from profile.html immediately after Paystack reports a successful
// payment in the browser. We do NOT trust that alone -- we re-verify the
// transaction directly with Paystack's server, then credit the wallet.
// This is a convenience/fast-path; the webhook (paystack-webhook.js) is the
// real source of truth and will also credit the wallet if this call is ever
// missed (e.g. the user closes the tab right after paying).
//
// Method: POST
// Body:   { reference }
//
// Required env vars: PAYSTACK_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { paystackRequest } from './_lib/paystackClient.js';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ status: false, message: 'Method not allowed. Use POST.' });
  }

  const { reference } = req.body || {};
  if (!reference) {
    return res.status(400).json({ status: false, message: 'Missing reference' });
  }

  try {
    // 1. Confirm the payment actually happened, directly with Paystack.
    const verifyData = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`);

    if (verifyData.data.status !== 'success') {
      return res.status(400).json({ status: false, message: 'Payment could not be verified.' });
    }

    const { amount, metadata } = verifyData.data;
    const userId = metadata && metadata.user_id;

    if (!userId) {
      return res.status(400).json({ status: false, message: 'Missing user reference on transaction.' });
    }

    const nairaAmount = amount / 100; // Paystack amounts are in kobo

    // 2. Credit the wallet atomically & idempotently -- safe even if this
    //    endpoint and the webhook both fire for the same reference.
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.rpc('credit_wallet', {
      p_user_id: userId,
      p_reference: reference,
      p_amount: nairaAmount
    });

    if (error) throw error;

    return res.status(200).json({ status: true, message: 'Wallet funded successfully.', amount: nairaAmount });

  } catch (err) {
    console.error('verify-wallet-funding error:', err);
    const status = err.httpStatus && err.httpStatus < 500 ? err.httpStatus : 500;
    return res.status(status).json({
      status: false,
      message: err.message || 'Something went wrong verifying your payment.'
    });
  }
}