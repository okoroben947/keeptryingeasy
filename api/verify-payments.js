// /api/verify-payment.js
//
// Called from pricing.html right after Paystack reports a successful
// payment for a ONE-OFF SERVICE (NIN registration, CAC registration, etc.)
// -- this is completely separate from wallet funding in profile.html.
// No wallet is touched here; we just confirm the charge really happened
// with Paystack and record it for your own bookkeeping.
//
// pricing.html has no login system, so there's no user_id to attach --
// these payments are matched to a customer by the email/phone they typed
// into the request form (which is emailed to you separately via FormSubmit).
//
// Method: GET
// Query:  ?reference=xxxx
//
// Required env vars: PAYSTACK_SECRET_KEY
// Optional env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   (only needed to log the payment to service_payments; if not set, the
//   payment still verifies fine, it just won't be recorded on your side.)

import { paystackRequest } from './_lib/paystackClient.js';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ status: false, message: 'Method not allowed. Use GET.' });
  }

  const { reference } = req.query;
  if (!reference) {
    return res.status(400).json({ status: false, message: 'Missing reference' });
  }

  try {
    const verifyData = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`);

    // Record it for your own records, regardless of outcome, so you have a
    // full audit trail even for failed/abandoned attempts. Safe to call
    // more than once for the same reference (see note in the SQL file).
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const supabase = getSupabaseAdmin();
        await supabase.from('service_payments').upsert({
          reference,
          amount: (verifyData.data.amount || 0) / 100,
          status: verifyData.data.status || 'unknown',
          service_name: verifyData.data.metadata && verifyData.data.metadata.service,
          customer_email: verifyData.data.customer && verifyData.data.customer.email,
          paid_at: verifyData.data.paid_at || null
        });
      } catch (logErr) {
        console.error('service_payments logging notice:', logErr.message);
      }
    }

    // pricing.html only checks result.data.status === 'success', so this
    // shape matches what it already expects.
    return res.status(200).json({ status: true, data: verifyData.data });

  } catch (err) {
    console.error('verify-payment error:', err);
    const status = err.httpStatus && err.httpStatus < 500 ? err.httpStatus : 502;
    return res.status(status).json({
      status: false,
      message: err.message || 'Something went wrong verifying your payment.'
    });
  }
}