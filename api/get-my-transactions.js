// Forcing Vercel to update
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');

    if (req.method !== 'GET') {
        return res.status(405).json({ status: false, message: 'Method not allowed' });
    }

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            return res.status(401).json({ status: false, message: 'Missing authorization header' });
        }

        const token = authHeader.replace('Bearer ', '');
        
        let supabase;
        try {
            supabase = getSupabaseAdmin();
        } catch (err) {
            return res.status(500).json({ status: false, message: 'Server configuration error' });
        }

        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
            return res.status(401).json({ status: false, message: 'Unauthorized' });
        }

        const { data: transactions, error: txError } = await supabase
            .from('transactions')
            .select('*')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(50);

        if (txError) {
            throw txError;
        }

        return res.status(200).json({ status: true, transactions: transactions || [] });
    } catch (err) {
        console.error('Error fetching transactions:', err);
        return res.status(500).json({ status: false, message: err.message || 'Internal server error' });
    }
}