import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 1. Fetch all customers from Paystack
    const paystackResponse = await axios.get('https://api.paystack.co/customer', {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
      }
    });
    
    const paystackCustomers = paystackResponse.data.data || [];

    // 2. Fetch all wallet records from Supabase
    const { data: walletsData, error: walletError } = await supabase
      .from('wallets')
      .select('*');

    if (walletError) {
      console.error('Supabase wallet fetch error:', walletError);
    }

    const wallets = walletsData || [];

    // 3. Create a fast lookup map for wallets using normalized (lowercase) email or customer reference
    const walletMap = {};
    wallets.forEach(w => {
      if (w.email) {
        walletMap[w.email.trim().toLowerCase()] = w;
      }
      if (w.customer_id) {
        walletMap[w.customer_id.toString().trim()] = w;
      }
    });

    // 4. Merge Paystack master directory with Supabase wallets
    const mergedCustomers = paystackCustomers.map(customer => {
      const emailKey = customer.email ? customer.email.trim().toLowerCase() : '';
      const customerIdKey = customer.id ? customer.id.toString().trim() : '';
      
      const matchedWallet = walletMap[emailKey] || walletMap[customerIdKey] || {};

      return {
        id: customer.id,
        customer_code: customer.customer_code,
        first_name: customer.first_name || '',
        last_name: customer.last_name || '',
        email: customer.email,
        phone: customer.phone || customer.international_format_phone || '',
        // Fallback safely to 0.00 if balance is missing or undefined
        wallet_balance: matchedWallet.balance !== undefined && matchedWallet.balance !== null 
          ? Number(matchedWallet.balance).toFixed(2) 
          : '0.00',
        created_at: customer.createdAt || customer.created_at
      };
    });

    // 5. Catch any Supabase wallet users who might not exist on Paystack yet
    const paystackEmails = new Set(paystackCustomers.map(c => c.email ? c.email.trim().toLowerCase() : ''));
    wallets.forEach(w => {
      const wEmail = w.email ? w.email.trim().toLowerCase() : '';
      if (wEmail && !paystackEmails.has(wEmail)) {
        mergedCustomers.push({
          id: w.id || w.customer_id,
          customer_code: w.customer_code || 'N/A',
          first_name: w.first_name || 'Unknown',
          last_name: w.last_name || 'User',
          email: w.email,
          phone: w.phone || '',
          wallet_balance: w.balance !== undefined && w.balance !== null 
            ? Number(w.balance).toFixed(2) 
            : '0.00',
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
    console.error('Error fetching customers/wallets:', error.response?.data || error.message);
    return res.status(500).json({ 
      status: false, 
      error: 'Failed to fetch customer records' 
    });
  }
}