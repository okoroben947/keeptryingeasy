// POST /api/paystack-webhook
//
// Paystack calls this directly, server-to-server, whenever a payment succeeds.
// This is the SOURCE OF TRUTH for wallet crediting -- it works even if the
// customer closes their browser tab the instant payment completes, before
// verify-wallet-funding.js gets a chance to run. Configure this URL in your
// Paystack Dashboard under Settings -> API Keys & Webhooks -> Webhook URL:
//   https://your-domain.com/api/paystack-webhook

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// Vercel parses JSON bodies by default, but signature verification needs the
// exact raw bytes Paystack sent -- so we turn that off and read it ourselves.
export const config = {
  api: { bodyParser: false }
};

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

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

    if (userId) {
      // This is a wallet-funding payment from profile.html.
      const nairaAmount = amount / 100;
      const { error } = await supabaseAdmin.rpc('credit_wallet', {
        p_user_id: userId,
        p_reference: reference,
        p_amount: nairaAmount
      });
      if (error) console.error('Webhook credit_wallet error:', error);

    } else {
      // No user_id in metadata means this is a one-off service payment from
      // pricing.html (that page has no login, so there's no wallet to credit).
      // Just record it -- verify-payment.js already does this too when the
      // customer's browser calls it, so this is the safety-net copy in case
      // that call never happened (tab closed, network drop, etc.).
      try {
        await supabaseAdmin.from('service_payments').upsert({
          reference,
          amount: amount / 100,
          status: 'success',
          service_name: metadata && metadata.service,
          customer_email: customer && customer.email,
          paid_at: paid_at || null
        });
      } catch (logErr) {
        console.error('Webhook service_payments logging error:', logErr);
      }
    }
  }

  // Always respond quickly with 200, or Paystack will keep retrying this event.
  return res.status(200).send('ok');
}