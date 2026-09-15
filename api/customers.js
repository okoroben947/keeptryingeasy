import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ status: false, error: 'Method not allowed' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ status: false, error: 'Missing Supabase environment variables.' });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // 1. Fetch all customers from Paystack with pagination
    let paystackCustomers = [];
    try {
      let page = 1;
      let fetchMore = true;
      while (fetchMore && page <= 5) {
        const paystackResponse = await axios.get(`https://api.paystack.co/customer?perPage=50&page=${page}`, {
          headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
        });
        const data = paystackResponse.data?.data || [];
        paystackCustomers = paystackCustomers.concat(data);
        if (data.length < 50) fetchMore = false;
        else page++;
      }
    } catch (paystackErr) {
      console.error('Paystack fetch warning:', paystackErr.message);
    }

    // 2. Fetch wallets and user profiles from Supabase in parallel
    const [walletsRes, profilesRes] = await Promise.all([
      supabase.from('wallets').select('*'),
      supabase.from('profiles').select('*').catch(() => ({ data: [] })) // fallback if profiles table name differs
    ]);

    if (walletsRes.error) {
      console.error('Supabase wallet fetch error:', walletsRes.error);
    }

    const rawWallets = walletsRes.data || [];
    const profiles = profilesRes.data || [];

    // Map user_id to profile details (email, names, phone)
    const profileMap = {};
    profiles.forEach(p => {
      const uid = (p.id || p.user_id || '').toString().trim();
      if (uid) profileMap[uid] = p;
    });

    // 3. Create comprehensive lookup maps for wallets & profiles
    const walletMap = {};
    const enhancedWallets = rawWallets.map(w => {
      const userId = (w.user_id || w.id || '').toString().trim();
      const linkedProfile = profileMap[userId] || {};

      // Fallback fields across tables
      const email = w.email || linkedProfile.email || '';
      const firstName = w.first_name || linkedProfile.first_name || linkedProfile.name || 'User';
      const lastName = w.last_name || linkedProfile.last_name || '';
      const phone = w.phone || linkedProfile.phone || '';
      const customerCode = w.customer_code || linkedProfile.customer_code || '';
      const balance = w.balance !== undefined && w.balance !== null ? w.balance : (w.wallet_balance || 0);

      const enrichedWallet = {
        ...w,
        resolved_email: email.trim().toLowerCase(),
        resolved_code: customerCode.trim().toUpperCase(),
        resolved_id: userId,
        first_name: firstName,
        last_name: lastName,
        phone: phone,
        balance: Number(balance)
      };

      if (enrichedWallet.resolved_email) walletMap[enrichedWallet.resolved_email] = enrichedWallet;
      if (enrichedWallet.resolved_code) walletMap[enrichedWallet.resolved_code] = enrichedWallet;
      if (userId) walletMap[userId] = enrichedWallet;

      return enrichedWallet;
    });

    // 4. Merge Paystack master directory with Supabase wallets
    const processedKeys = new Set();
    const mergedCustomers = paystackCustomers.map(customer => {
      const emailKey = customer.email ? customer.email.trim().toLowerCase() : '';
      const codeKey = customer.customer_code ? customer.customer_code.trim().toUpperCase() : '';
      const idKey = customer.id ? customer.id.toString().trim() : '';
      
      if (emailKey) processedKeys.add(emailKey);
      if (codeKey) processedKeys.add(codeKey);
      if (idKey) processedKeys.add(idKey);

      // Look up wallet using any available identifier match
      const matchedWallet = walletMap[emailKey] || walletMap[codeKey] || walletMap[idKey] || {};
      const finalBalance = matchedWallet.balance !== undefined ? matchedWallet.balance : 0;

      return {
        id: customer.id,
        customer_code: customer.customer_code || matchedWallet.resolved_code || '',
        first_name: customer.first_name || matchedWallet.first_name || '',
        last_name: customer.last_name || matchedWallet.last_name || '',
        email: customer.email || matchedWallet.resolved_email || '',
        phone: customer.phone || customer.international_format_phone || matchedWallet.phone || '',
        wallet_balance: Number(finalBalance).toFixed(2),
        created_at: customer.createdAt || customer.created_at || new Date().toISOString()
      };
    });

    // 5. Append ANY Supabase wallet user not found in Paystack (guarantees #300 balance user shows up!)
    enhancedWallets.forEach(w => {
      const uniqueKey = w.resolved_email || w.resolved_code || w.resolved_id;
      if (uniqueKey && !processedKeys.has(uniqueKey)) {
        processedKeys.add(uniqueKey);

        mergedCustomers.push({
          id: w.resolved_id || 'supabase-loc',
          customer_code: w.resolved_code || 'N/A',
          first_name: w.first_name || 'User',
          last_name: w.last_name || '',
          email: w.resolved_email || '',
          phone: w.phone || '',
          wallet_balance: Number(w.balance || 0).toFixed(2),
          created_at: w.created_at || new Date().toISOString()
        });
      }
    });

    return res.status(200).json({
      status: true,
      message: 'Customers retrieved successfully',
      data: mergedCustomers
    });

  } catch (error) {
    console.error('Critical Handler Exception:', error);
    return res.status(500).json({ 
      status: false, 
      error: 'Failed to fetch customer records',
      details: error.message 
    });
  }
}