import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ status: false, error: 'Method not allowed' });
  }

  // Diagnostic check for environment variables
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ 
      status: false, 
      error: 'Server configuration error: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.' 
    });
  }

  if (!process.env.PAYSTACK_SECRET_KEY) {
    return res.status(500).json({ 
      status: false, 
      error: 'Server configuration error: Missing PAYSTACK_SECRET_KEY environment variable.' 
    });
  }

  try {
    // Initialize Supabase client inside the handler to prevent cold start crash propagation
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // 1. Fetch all customers from Paystack (with pagination support & fallback)
    let paystackCustomers = [];
    try {
      let page = 1;
      let fetchMore = true;

      while (fetchMore) {
        const paystackResponse = await axios.get(`https://api.paystack.co/customer?perPage=50&page=${page}`, {
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
          }
        });
        
        const data = paystackResponse.data?.data || [];
        paystackCustomers = paystackCustomers.concat(data);

        if (data.length < 50 || page >= 5) { // Capped safely at 5 pages (250 users) for speed
          fetchMore = false;
        } else {
          page++;
        }
      }
    } catch (paystackErr) {
      console.error('Paystack API fetch warning:', paystackErr.response?.data || paystackErr.message);
      // Proceed even if Paystack fails so Supabase data can still render
    }

    // 2. Fetch all wallet records from Supabase
    const { data: walletsData, error: walletError } = await supabase
      .from('wallets')
      .select('*');

    if (walletError) {
      console.error('Supabase wallet fetch error:', walletError);
      throw new Error(`Supabase error: ${walletError.message}`);
    }

    const wallets = walletsData || [];

    // 3. Create comprehensive lookup maps for wallets
    const walletMap = {};
    wallets.forEach(w => {
      if (w.email) walletMap[w.email.trim().toLowerCase()] = w;
      if (w.customer_code) walletMap[w.customer_code.trim().toUpperCase()] = w;
      if (w.customer_id) walletMap[w.customer_id.toString().trim()] = w;
      if (w.user_id) walletMap[w.user_id.toString().trim()] = w;
    });

    // 4. Merge Paystack master directory with Supabase wallets
    const processedEmails = new Set();
    const mergedCustomers = paystackCustomers.map(customer => {
      const emailKey = customer.email ? customer.email.trim().toLowerCase() : '';
      const codeKey = customer.customer_code ? customer.customer_code.trim().toUpperCase() : '';
      const idKey = customer.id ? customer.id.toString().trim() : '';
      
      if (emailKey) processedEmails.add(emailKey);

      const matchedWallet = walletMap[emailKey] || walletMap[codeKey] || walletMap[idKey] || {};
      const rawBalance = matchedWallet.balance !== undefined && matchedWallet.balance !== null 
        ? matchedWallet.balance 
        : (matchedWallet.wallet_balance !== undefined ? matchedWallet.wallet_balance : 0);

      return {
        id: customer.id,
        customer_code: customer.customer_code || '',
        first_name: customer.first_name || '',
        last_name: customer.last_name || '',
        email: customer.email || '',
        phone: customer.phone || customer.international_format_phone || '',
        wallet_balance: Number(rawBalance || 0).toFixed(2),
        created_at: customer.createdAt || customer.created_at || new Date().toISOString()
      };
    });

    // 5. Append Supabase-only records
    wallets.forEach(w => {
      const wEmail = w.email ? w.email.trim().toLowerCase() : '';
      if (wEmail && !processedEmails.has(wEmail)) {
        processedEmails.add(wEmail);
        const rawBalance = w.balance !== undefined && w.balance !== null ? w.balance : (w.wallet_balance || 0);

        mergedCustomers.push({
          id: w.id || w.customer_id || 'supabase-loc',
          customer_code: w.customer_code || 'N/A',
          first_name: w.first_name || 'User',
          last_name: w.last_name || '',
          email: w.email || '',
          phone: w.phone || '',
          wallet_balance: Number(rawBalance || 0).toFixed(2),
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
      error: 'Failed to fetch customer records due to server exception',
      details: error.message 
    });
  }
}