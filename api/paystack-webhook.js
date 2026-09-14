// /api/paystack-webhook.js
//
// Paystack calls this directly, server-to-server, whenever a payment succeeds.
// This is the SOURCE OF TRUTH for crediting wallets and recording service
// payments -- it works even if the customer closes their browser tab the
// instant payment completes, before verify-wallet-funding.js or
// verify-payment.js get a chance to run.
//
// Configure this URL in Paystack Dashboard -> Settings -> API Keys & Webhooks:
//   https://your-domain.com/api/paystack-webhook
//
// Required env vars: PAYSTACK_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import crypto from 'crypto';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Vercel needs the raw, unparsed body to verify Paystack's signature below --
// this disables Vercel's automatic JSON body parsing for this endpoint only.
// In ESM this MUST be its own named export (not a property tacked onto the
// handler function) or Vercel won't pick it up.
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const rawBody = await readRawBody(req);

  // Verify this request genuinely came from Paystack, not someone hitting
  // the URL directly to fake a "successful payment".
  const expectedSignature = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');

  if (expectedSignature !== req.headers['x-paystack-signature']) {
    return res.status(401).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    return res.status(400).send('Invalid payload');
  }

  if (event.event === 'charge.success') {
    const { reference, amount, metadata, customer, paid_at } = event.data;
    const userId = metadata && metadata.user_id;
    const supabase = getSupabaseAdmin();

    if (userId) {
      // Wallet-funding payment from profile.html.
      const nairaAmount = amount / 100;
      const { error } = await supabase.rpc('credit_wallet', {
        p_user_id: userId,
        p_reference: reference,
        p_amount: nairaAmount
      });
      if (error) console.error('Webhook credit_wallet error:', error);

    } else {
      // No user_id in metadata means this is a one-off service payment from
      // pricing.html (that page has no login, so there's no wallet to credit).
      // verify-payment.js already records this too when the customer's
      // browser calls it -- this is the safety-net copy in case that call
      // never happened (tab closed, network drop, etc.).
      try {
        await supabase.from('service_payments').upsert({
          reference,
          amount: amount / 100,
          status: 'success',
          service_name: metadata && metadata.service,
          customer_email: customer && customer.email,
          paid_at: paid_at || null
        });
      } catch (logErr) {
        console.error('Webhook service_payments logging error:', logErr.message);
      }
    }
  }

  // Always respond quickly with 200, or Paystack will keep retrying this event.
  return res.status(200).send('ok');
}