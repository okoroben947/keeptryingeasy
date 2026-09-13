// GET /api/verify-payment?reference=xxxx
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

import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ status: false, message: 'Method not allowed' });
  }

  const { reference } = req.query;
  if (!reference) {
    return res.status(400).json({ status: false, message: 'Missing reference' });
  }

  try {
    const verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    const verifyData = await verifyRes.json();

    if (!verifyRes.ok) {
      return res.status(502).json({ status: false, message: 'Could not reach Paystack.' });
    }

    // Record it for your own records, regardless of outcome, so you have a
    // full audit trail even for failed/abandoned attempts. Safe to call
    // more than once for the same reference (see note in the SQL file).
    try {
      await supabaseAdmin.from('service_payments').upsert({
        reference,
        amount: (verifyData.data.amount || 0) / 100,
        status: verifyData.data.status || 'unknown',
        service_name: verifyData.data.metadata && verifyData.data.metadata.service,
        customer_email: verifyData.data.customer && verifyData.data.customer.email,
        paid_at: verifyData.data.paid_at || null
      });
    } catch (logErr) {
      console.error('service_payments logging notice:', logErr);
    }

    // pricing.html only checks result.data.status === 'success', so this
    // shape matches what it already expects.
    return res.status(200).json({ status: true, data: verifyData.data });

  } catch (err) {
    console.error('verify-payment error:', err);
    return res.status(500).json({ status: false, message: 'Something went wrong verifying your payment.' });
  }
}