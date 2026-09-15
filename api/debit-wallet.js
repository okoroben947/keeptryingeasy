// /api/debit-wallet.js
//
// Debits a customer's wallet balance for a service request, against your REAL schema:
//   customers.wallet_balance   - the live balance (in NAIRA - see NOTE below)
//   customers.email            - natural key (customers has no customer_code column)
//   service_payments           - ledger row written for every debit
//
// Depends on the debit_customer_wallet() Postgres function from wallet-schema.sql,
// which does the balance check + deduction + ledger insert atomically in one
// transaction, so two simultaneous debits against the same customer can never both
// succeed against a balance that only covers one of them.
//
// Routes (all require the same "x-admin-password" header already used by
// /api/customers and /api/send-money):
//   GET  /api/debit-wallet                    -> { status: true, customers: [{email, first_name, last_name, phone, wallet_balance, created_at}, ...] }
//   GET  /api/debit-wallet?email=a@b.com       -> { status: true, email, wallet_balance, customer: {...full row} }
//   POST /api/debit-wallet { email, amount, service_name } -> { status: true, wallet_balance, reference }
//
// NOTE ON UNITS: amount is treated as NAIRA end-to-end here (no *100/÷100 conversion),
// unlike Paystack transaction amounts elsewhere in this app which are in kobo. This
// matches the "0.00" decimal formatting seen on customers.wallet_balance. If a real
// top-up later reveals the column is actually in kobo, add a single conversion step
// here (multiply incoming `amount` by 100 before calling the RPC, divide the returned
// balance by 100 before responding) rather than changing the SQL function's units.
//
// NOTE ON AUTH: this assumes a shared helper at ./_lib/requireAdmin.js, the same one
// referenced by your existing /api/customers.js and /api/send-money.js. If that
// helper's signature differs, adjust the requireAdmin(req) call below to match it.

import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from './_lib/requireAdmin.js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY // service role key required: bypasses RLS to manage wallets server-side
);

export default async function handler(req, res) {
    // ---- Auth: every request here touches money, so admin auth is mandatory ----
    if (!requireAdmin(req)) {
        return res.status(401).json({ status: false, message: 'Unauthorized. Missing or invalid admin credentials.' });
    }

    try {
        if (req.method === 'GET') {
            return await handleGet(req, res);
        }
        if (req.method === 'POST') {
            return await handlePost(req, res);
        }
        res.setHeader('Allow', 'GET, POST');
        return res.status(405).json({ status: false, message: `Method ${req.method} not allowed.` });
    } catch (err) {
        console.error('[/api/debit-wallet] Unexpected error:', err);
        return res.status(500).json({ status: false, message: err.message || 'Unexpected server error.' });
    }
}

// GET: either every customer's wallet balance (for the dashboard table) or a single
// customer's freshest balance (used when opening the Debit Wallet modal).
async function handleGet(req, res) {
    const { email } = req.query || {};

    if (email) {
        const { data, error } = await supabase
            .from('customers')
            .select('email, first_name, last_name, phone, wallet_balance, created_at')
            .eq('email', email)
            .maybeSingle();

        if (error) {
            return res.status(500).json({ status: false, message: 'Failed to fetch wallet balance.', detail: error.message });
        }
        if (!data) {
            return res.status(404).json({ status: false, message: `No customer found with email ${email}.` });
        }

        return res.status(200).json({
            status: true,
            email: data.email,
            wallet_balance: Number(data.wallet_balance) || 0,
            customer: data
        });
    }

    const { data, error } = await supabase
        .from('customers')
        .select('email, first_name, last_name, phone, wallet_balance, created_at');

    if (error) {
        return res.status(500).json({ status: false, message: 'Failed to fetch registered customers.', detail: error.message });
    }

    // NEW: returned as "customers" (full profile rows), not just "wallets" - this is what
    // lets the dashboard show every registered signup, including ones that don't have a
    // matching Paystack customer_code yet. See mergeRegisteredCustomers() in index.html.
    return res.status(200).json({ status: true, customers: data || [] });
}

// POST: debit a customer's wallet for a service request, and record it in service_payments.
async function handlePost(req, res) {
    const { email, amount, service_name, reason } = req.body || {};

    if (!email || typeof email !== 'string') {
        return res.status(400).json({ status: false, message: 'A customer email is required.' });
    }

    const amountNaira = Number(amount);
    if (!amountNaira || isNaN(amountNaira) || amountNaira <= 0) {
        return res.status(400).json({ status: false, message: 'A valid amount greater than zero is required.' });
    }

    // Accept either field name from the frontend; service_payments.service_name is what
    // actually gets stored, but "reason" is kept as a fallback for compatibility.
    const serviceName = (service_name && String(service_name).trim())
        || (reason && String(reason).trim())
        || 'Service request';

    const { data, error } = await supabase
        .rpc('debit_customer_wallet', {
            p_email: email,
            p_amount: amountNaira,
            p_service_name: serviceName
        })
        .single();

    if (error) {
        // The SQL function raises friendly exception text for "no customer found" and
        // "insufficient balance" - surface that directly instead of a generic 500.
        const message = error.message && error.message.toLowerCase().includes('insufficient')
            ? 'Insufficient wallet balance for this debit.'
            : (error.message || 'Failed to debit wallet.');
        return res.status(400).json({ status: false, message });
    }

    return res.status(200).json({
        status: true,
        message: `₦${amountNaira.toLocaleString()} debited successfully.`,
        email: data.email,
        wallet_balance: Number(data.wallet_balance),
        reference: data.reference
    });
}