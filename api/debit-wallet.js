// /api/debit-wallet.js
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from './_lib/requireAdmin.js';

function getSupabaseClient() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
        throw new Error('Server misconfiguration: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
    }

    return createClient(url, key);
}

export default async function handler(req, res) {
    // Prevent browser caching so stale 0.00 balances are never served
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-password');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Admin Authentication Check
    if (!requireAdmin(req, res)) {
        return;
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

// GET: Queries both `customers` and `wallets` tables and merges their data
async function handleGet(req, res) {
    const supabase = getSupabaseClient();
    const { email } = req.query || {};

    // 1. GET Single Customer + Wallet
    if (email) {
        const [customerRes, walletRes] = await Promise.all([
            supabase.from('customers').select('*').eq('email', email).maybeSingle(),
            supabase.from('wallets').select('*').eq('email', email).maybeSingle()
        ]);

        if (customerRes.error) {
            return res.status(500).json({ status: false, message: 'Failed to fetch customer profile.', detail: customerRes.error.message });
        }

        if (!customerRes.data && !walletRes.data) {
            return res.status(404).json({ status: false, message: `No record found for email ${email}.` });
        }

        const customer = customerRes.data || {};
        const wallet = walletRes.data || {};
        const balance = Number(wallet.balance ?? wallet.wallet_balance ?? customer.wallet_balance ?? 0);

        return res.status(200).json({
            status: true,
            email: email,
            wallet_balance: balance,
            customer: {
                ...customer,
                wallet_balance: balance
            },
            wallet
        });
    }

    // 2. GET All Customers + Wallets
    const [customersRes, walletsRes] = await Promise.all([
        supabase.from('customers').select('*'),
        supabase.from('wallets').select('*')
    ]);

    if (customersRes.error) {
        return res.status(500).json({ status: false, message: 'Failed to fetch registered customers.', detail: customersRes.error.message });
    }

    const customers = customersRes.data || [];
    const wallets = walletsRes.data || [];

    // Map wallet balances by lowercase email for fast lookup
    const walletMap = new Map();
    wallets.forEach(w => {
        if (w.email) {
            walletMap.set(w.email.toLowerCase(), Number(w.balance ?? w.wallet_balance ?? 0));
        }
    });

    // Attach true wallet balances from `wallets` table to customer records
    const mergedCustomers = customers.map(c => {
        const customerEmail = (c.email || '').toLowerCase();
        const liveBalance = walletMap.has(customerEmail)
            ? walletMap.get(customerEmail)
            : Number(c.wallet_balance || 0);

        return {
            ...c,
            wallet_balance: liveBalance
        };
    });

    return res.status(200).json({ status: true, customers: mergedCustomers });
}

// POST: Execute debit transaction on wallet balance
async function handlePost(req, res) {
    const supabase = getSupabaseClient();
    const { email, amount, service_name, reason } = req.body || {};

    if (!email || typeof email !== 'string') {
        return res.status(400).json({ status: false, message: 'A customer email is required.' });
    }

    const amountNaira = Number(amount);
    if (!amountNaira || isNaN(amountNaira) || amountNaira <= 0) {
        return res.status(400).json({ status: false, message: 'A valid amount greater than zero is required.' });
    }

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
        const message = error.message && error.message.toLowerCase().includes('insufficient')
            ? 'Insufficient wallet balance for this debit.'
            : (error.message || 'Failed to debit wallet.');
        return res.status(400).json({ status: false, message });
    }

    return res.status(200).json({
        status: true,
        message: `₦${amountNaira.toLocaleString()} debited successfully.`,
        email: data?.email || email,
        wallet_balance: Number(data?.wallet_balance || data?.balance || 0),
        reference: data?.reference || null
    });
}