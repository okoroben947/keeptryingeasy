// /api/debit-wallet.js

import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from './_lib/requireAdmin.js';

// Lazy initialize Supabase client to prevent top-level crashes if env vars are missing
function getSupabaseClient() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
        throw new Error('Server misconfiguration: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
    }

    return createClient(url, key);
}

export default async function handler(req, res) {
    // 1. Enable CORS for cross-origin dashboard requests
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-password');

    // Handle browser CORS preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // 2. Auth: Pass both req AND res to requireAdmin (requireAdmin writes response directly on failure)
    if (!requireAdmin(req, res)) {
        return; // requireAdmin has already sent a 401 or 500 response
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

// GET: Fetch single customer's balance or all registered customers
async function handleGet(req, res) {
    const supabase = getSupabaseClient();
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

    return res.status(200).json({ status: true, customers: data || [] });
}

// POST: Execute atomic debit RPC function
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
        wallet_balance: Number(data?.wallet_balance || 0),
        reference: data?.reference || null
    });
}