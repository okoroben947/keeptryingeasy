// /api/pay-for-service.js
//
// Handles a customer paying for a service in four ways:
//   - "wallet"   : atomically debited from public.wallets via a Postgres
//                  function (see service-payments-schema.sql), recorded as
//                  an immediate "success".
//   - "paystack" : the browser has already run Paystack's inline checkout;
//                  this endpoint re-verifies the transaction directly with
//                  Paystack's API before recording it - never trusts the
//                  browser's word that a payment succeeded.
//   - "korapay"  : same principle as "paystack" above - the browser has
//                  already run Korapay's inline checkout; this endpoint
//                  re-verifies the charge directly with Korapay's API using
//                  KORAPAY_SECRET_KEY before recording it. Never trusts the
//                  browser's onSuccess callback alone.
//   - "opay"     : NOT an API integration. This business currently confirms
//                  Opay transfers manually, so this just records a
//                  "pending" purchase (with whatever note the customer gave
//                  to help you match the transfer) for you to confirm once
//                  you see the money land in the Opay account.
//
// In every case, the PRICE is looked up fresh from public.services on the
// server - the client can never influence what gets charged.
//
// NOTE ON AUTH: this expects a Supabase user JWT in the Authorization header
// ("Bearer <token>"), matching the pattern your other user-facing endpoints
// (e.g. /api/get-my-transactions, /api/create-virtual-account) already use.
// If those endpoints use a shared helper for this check rather than the
// inline supabaseAdmin.auth.getUser() call below, swap this to match it for
// consistency - functionally this inline version works fine either way.

import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY // service role: bypasses RLS to verify/debit server-side
);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ status: false, message: 'Method not allowed. Use POST.' });
    }

    // ---- Auth: identify the calling user from their Supabase session token ----
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
        return res.status(401).json({ status: false, message: 'Missing authentication token.' });
    }

    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !userData || !userData.user) {
        return res.status(401).json({ status: false, message: 'Invalid or expired session. Please log in again.' });
    }
    const user = userData.user;

    const { service_key, method, reference, customer_note } = req.body || {};
    if (!service_key || !method) {
        return res.status(400).json({ status: false, message: 'service_key and method are required.' });
    }

    try {
        if (method === 'wallet') {
            return await payWithWallet(res, user, service_key, reference);
        }
        if (method === 'paystack') {
            return await payWithPaystack(res, user, service_key, reference);
        }
        if (method === 'korapay') {
            return await payWithKorapay(res, user, service_key, reference);
        }
        if (method === 'opay') {
            return await recordOpayPending(res, user, service_key, reference, customer_note);
        }
        return res.status(400).json({ status: false, message: `Unsupported payment method: ${method}` });
    } catch (err) {
        console.error('[/api/pay-for-service] Unexpected error:', err);
        return res.status(500).json({ status: false, message: err.message || 'Unexpected server error.' });
    }
}

async function payWithWallet(res, user, serviceKey, reference) {
    const { data, error } = await supabaseAdmin
        .rpc('pay_for_service_with_wallet', {
            p_user_id: user.id,
            p_service_key: serviceKey,
            p_reference: reference || null
        })
        .single();

    if (error) {
        const message = error.message && error.message.toLowerCase().includes('insufficient')
            ? 'Insufficient wallet balance. Please fund your wallet or choose another payment method.'
            : (error.message || 'Payment failed.');
        return res.status(400).json({ status: false, message });
    }

    return res.status(200).json({
        status: true,
        message: `${data.service_name} paid successfully from your wallet.`,
        new_balance: Number(data.new_balance),
        service_name: data.service_name,
        amount: Number(data.amount)
    });
}

async function payWithPaystack(res, user, serviceKey, reference) {
    if (!reference) {
        return res.status(400).json({ status: false, message: 'A payment reference is required to verify this transaction.' });
    }

    // Re-verify directly with Paystack - the browser's "success" callback firing is
    // not sufficient proof on its own; someone could call this endpoint with a made-up
    // reference without ever having paid.
    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    const verifyJson = await verifyRes.json();

    if (!verifyJson.status || !verifyJson.data || verifyJson.data.status !== 'success') {
        return res.status(400).json({ status: false, message: 'Could not verify this payment with Paystack.' });
    }

    const { data: serviceRow, error: serviceErr } = await supabaseAdmin
        .from('services')
        .select('name, price')
        .eq('key', serviceKey)
        .eq('active', true)
        .single();

    if (serviceErr || !serviceRow) {
        return res.status(400).json({ status: false, message: 'Unknown or inactive service.' });
    }

    const verifiedAmountNaira = verifyJson.data.amount / 100; // Paystack reports in kobo
    if (verifiedAmountNaira < Number(serviceRow.price)) {
        return res.status(400).json({ status: false, message: "The amount paid does not match this service's price." });
    }

    const { error: insertErr } = await supabaseAdmin.from('service_purchases').insert({
        user_id: user.id,
        service_key: serviceKey,
        service_name: serviceRow.name,
        amount: serviceRow.price,
        payment_method: 'paystack',
        status: 'success',
        reference
    });

    if (insertErr) {
        console.error('[/api/pay-for-service] Failed to log paystack purchase:', insertErr);
        // The payment itself is genuinely verified at this point - don't tell the
        // customer it failed just because the ledger write had a hiccup.
    }

    return res.status(200).json({
        status: true,
        message: `${serviceRow.name} paid successfully via Paystack.`,
        service_name: serviceRow.name,
        amount: Number(serviceRow.price)
    });
}

async function payWithKorapay(res, user, serviceKey, reference) {
    if (!reference) {
        return res.status(400).json({ status: false, message: 'A payment reference is required to verify this transaction.' });
    }

    // Re-verify directly with Korapay - same principle as the Paystack branch above:
    // the browser's onSuccess callback firing is not sufficient proof on its own;
    // someone could call this endpoint with a made-up reference without ever having paid.
    const verifyRes = await fetch(`https://api.korapay.com/merchant/api/v1/charges/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${process.env.KORAPAY_SECRET_KEY}` }
    });
    const verifyJson = await verifyRes.json();

    if (!verifyJson.status || !verifyJson.data || verifyJson.data.status !== 'success') {
        return res.status(400).json({ status: false, message: 'Could not verify this payment with Korapay.' });
    }

    const { data: serviceRow, error: serviceErr } = await supabaseAdmin
        .from('services')
        .select('name, price')
        .eq('key', serviceKey)
        .eq('active', true)
        .single();

    if (serviceErr || !serviceRow) {
        return res.status(400).json({ status: false, message: 'Unknown or inactive service.' });
    }

    const verifiedAmountNaira = Number(verifyJson.data.amount); // Korapay reports the charged amount in Naira, not kobo
    if (verifiedAmountNaira < Number(serviceRow.price)) {
        return res.status(400).json({ status: false, message: "The amount paid does not match this service's price." });
    }

    const { error: insertErr } = await supabaseAdmin.from('service_purchases').insert({
        user_id: user.id,
        service_key: serviceKey,
        service_name: serviceRow.name,
        amount: serviceRow.price,
        payment_method: 'korapay',
        status: 'success',
        reference
    });

    if (insertErr) {
        console.error('[/api/pay-for-service] Failed to log korapay purchase:', insertErr);
        // The payment itself is genuinely verified at this point - don't tell the
        // customer it failed just because the ledger write had a hiccup.
    }

    return res.status(200).json({
        status: true,
        message: `${serviceRow.name} paid successfully via Korapay.`,
        service_name: serviceRow.name,
        amount: Number(serviceRow.price)
    });
}

async function recordOpayPending(res, user, serviceKey, reference, customerNote) {
    const { data: serviceRow, error: serviceErr } = await supabaseAdmin
        .from('services')
        .select('name, price')
        .eq('key', serviceKey)
        .eq('active', true)
        .single();

    if (serviceErr || !serviceRow) {
        return res.status(400).json({ status: false, message: 'Unknown or inactive service.' });
    }

    const { error: insertErr } = await supabaseAdmin.from('service_purchases').insert({
        user_id: user.id,
        service_key: serviceKey,
        service_name: serviceRow.name,
        amount: serviceRow.price,
        payment_method: 'opay',
        status: 'pending', // stays pending until manually confirmed - see note at top of file
        reference: reference || null,
        customer_note: customerNote || null
    });

    if (insertErr) {
        console.error('[/api/pay-for-service] Failed to log opay pending purchase:', insertErr);
        return res.status(500).json({ status: false, message: 'Could not record your submission. Please try again or contact support.' });
    }

    return res.status(200).json({
        status: true,
        message: `Thanks! We're confirming your ₦${Number(serviceRow.price).toLocaleString()} transfer for ${serviceRow.name} and will activate it shortly.`
    });
}