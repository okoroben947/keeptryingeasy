// /api/debit-wallet.js
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from './_lib/requireAdmin.js';

function getSupabaseClient() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

    if (!url || !key) {
        throw new Error('Server misconfiguration: Missing SUPABASE_URL or API Key.');
    }

    return createClient(url, key);
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-password');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

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

async function handleGet(req, res) {
    const supabase = getSupabaseClient();
    const { email } = req.query || {};

    if (email) {
        const [customerRes, walletRes] = await Promise.all([
            supabase.from('customers').select('*').eq('email', email).maybeSingle(),
            supabase.from('wallets').select('*').eq('email', email).maybeSingle()
        ]);

        const customer = customerRes.data || {};
        const wallet = walletRes.data || {};
        const balance = Number(wallet.balance ?? customer.wallet_balance ?? 0);

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

    const [customersRes, walletsRes] = await Promise.all([
        supabase.from('customers').select('*'),
        supabase.from('wallets').select('*')
    ]);

    if (customersRes.error) {
        return res.status(500).json({ status: false, message: 'Failed to fetch customers.', detail: customersRes.error.message });
    }

    const customers = customersRes.data || [];
    const wallets = walletsRes.data || [];

    const walletMap = new Map();

    wallets.forEach(w => {
        const liveVal = Number(w.balance ?? 0);

        // Map every potential user identifier key from the wallets table
        if (w.user_id) walletMap.set(String(w.user_id).toLowerCase(), liveVal);
        if (w.email) walletMap.set(String(w.email).toLowerCase(), liveVal);
        if (w.customer_id) walletMap.set(String(w.customer_id).toLowerCase(), liveVal);
        if (w.id) walletMap.set(String(w.id).toLowerCase(), liveVal);
    });

    const mergedCustomers = customers.map(c => {
        const cUserId = String(c.user_id || '').toLowerCase();
        const cEmail = String(c.email || '').toLowerCase();
        const cId = String(c.id || '').toLowerCase();
        const cCode = String(c.customer_code || '').toLowerCase();

        // Match wallet using user_id UUID, email, integer id, or customer_code
        const liveBalance = walletMap.get(cUserId)
            ?? walletMap.get(cEmail)
            ?? walletMap.get(cId)
            ?? walletMap.get(cCode)
            ?? Number(c.wallet_balance || c.balance || 0);

        return {
            ...c,
            wallet_balance: liveBalance
        };
    });

    return res.status(200).json({ 
        status: true, 
        customers: mergedCustomers,
        raw_wallets_debug: wallets
    });
}

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