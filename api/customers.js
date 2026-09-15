// /api/customers.js

import requireAdmin from './_lib/requireAdmin.js';
import { paystackRequest } from './_lib/paystackClient.js';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';

const MAX_PAGES = 5;   // safety cap: up to 5 x 100 = 500 records per list
const PER_PAGE = 100;

export default async function handler(req, res) {
  // Protect all methods (GET, POST, DELETE) at root level
  if (!requireAdmin(req, res)) return;

  const { method } = req;

  switch (method) {
    case 'GET':
      return handleGet(req, res);
    case 'POST':
      return handlePost(req, res);
    case 'DELETE':
      return handleDelete(req, res);
    default:
      res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
      return res.status(405).end(`Method ${method} Not Allowed`);
  }
}

async function handleGet(req, res) {
  try {
    // 1. Fetch customers and transactions from Paystack in parallel
    const [paystackCustomers, transactions] = await Promise.all([
      fetchAllPages('/customer'),
      fetchAllPages('/transaction')
    ]);

    // 2. Fetch wallet balances and customers from Supabase database
    let supabaseWalletMap = new Map();
    let supabaseCustomers = [];

    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const supabase = getSupabaseAdmin();

        // Fetch both 'customers' and 'wallets' tables in parallel
        const [customersRes, walletsRes] = await Promise.all([
          supabase.from('customers').select('*'),
          supabase.from('wallets').select('*')
        ]);

        const dbCustomers = customersRes.data || [];
        const dbWallets = walletsRes.data || [];

        // Map balance from 'wallets' table by email, customer_code, or user_id
        dbWallets.forEach(w => {
          const bal = Number(w.balance ?? w.wallet_balance ?? w.amount) || 0;
          if (w.email) supabaseWalletMap.set(w.email.toLowerCase(), bal);
          if (w.customer_code) supabaseWalletMap.set(w.customer_code, bal);
          if (w.user_id) supabaseWalletMap.set(w.user_id, bal);
        });

        // Fallback check on 'customers' table if wallets table record was missing
        if (dbCustomers.length > 0) {
          supabaseCustomers = dbCustomers;
          dbCustomers.forEach(c => {
            const bal = Number(c.wallet_balance) || 0;
            if (c.email && !supabaseWalletMap.has(c.email.toLowerCase())) {
              supabaseWalletMap.set(c.email.toLowerCase(), bal);
            }
            if (c.customer_code && !supabaseWalletMap.has(c.customer_code)) {
              supabaseWalletMap.set(c.customer_code, bal);
            }
          });
        }
      } catch (dbErr) {
        console.warn('get-customers: Supabase wallet fetch failed:', dbErr.message);
      }
    }

    // 3. Merge Paystack customers with Supabase wallet balances
    const mergedCustomersMap = new Map();

    // First add Paystack customers
    (paystackCustomers || []).forEach(c => {
      const emailKey = c.email ? c.email.toLowerCase() : null;
      const walletBalance = (emailKey && supabaseWalletMap.has(emailKey)) 
        ? supabaseWalletMap.get(emailKey) 
        : (supabaseWalletMap.get(c.customer_code) || 0);

      mergedCustomersMap.set(emailKey || c.customer_code, {
        customer_code: c.customer_code,
        first_name: c.first_name,
        last_name: c.last_name,
        email: c.email,
        phone: c.phone,
        wallet_balance: walletBalance,
        createdAt: c.createdAt || c.created_at
      });
    });

    // Add any Supabase-only customers that might not be registered on Paystack yet
    supabaseCustomers.forEach(c => {
      const emailKey = c.email ? c.email.toLowerCase() : null;
      const key = emailKey || c.customer_code || c.id;
      const walletBalance = (emailKey && supabaseWalletMap.has(emailKey))
        ? supabaseWalletMap.get(emailKey)
        : (Number(c.wallet_balance) || 0);

      if (key && !mergedCustomersMap.has(key)) {
        mergedCustomersMap.set(key, {
          customer_code: c.customer_code || '',
          first_name: c.first_name || c.full_name || '',
          last_name: c.last_name || '',
          email: c.email || '',
          phone: c.phone || '',
          wallet_balance: walletBalance,
          createdAt: c.createdAt || c.created_at || new Date().toISOString()
        });
      }
    });

    const allCustomers = Array.from(mergedCustomersMap.values());

    // 4. Filter out blacklisted/removed customers
    const visibleCustomers = await filterRemovedCustomers(allCustomers);

    return res.status(200).json({
      status: true,
      customers: visibleCustomers.map(shapeCustomer),
      transactions: transactions.map(shapeTransaction)
    });
  } catch (err) {
    console.error('get-customers error:', err);
    return res.status(502).json({
      status: false,
      message: err.message || 'Failed to fetch customer data.'
    });
  }
}

async function handlePost(req, res) {
  try {
    const { first_name, last_name, email, phone } = req.body || {};

    if (!email || !first_name) {
      return res.status(400).json({ status: false, message: 'first_name and email are required.' });
    }

    const paystackRes = await paystackRequest('/customer', {
      method: 'POST',
      body: {
        email,
        first_name,
        last_name: last_name || '',
        phone: phone || undefined
      }
    });

    const customer = paystackRes.data;

    // Ensure customer & wallet records are mirrored into Supabase
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const supabase = getSupabaseAdmin();
        
        // Upsert into customers
        await supabase.from('customers').upsert({
          email: customer.email,
          first_name: customer.first_name,
          last_name: customer.last_name,
          phone: customer.phone,
          customer_code: customer.customer_code
        }, { onConflict: 'email' });

        // Ensure row exists in wallets table
        await supabase.from('wallets').upsert({
          email: customer.email,
          customer_code: customer.customer_code,
          balance: 0
        }, { onConflict: 'email' });

      } catch (dbErr) {
        console.warn('create-customer: Supabase sync warning:', dbErr.message);
      }
    }

    return res.status(200).json({
      status: true,
      message: 'Customer created successfully.',
      customer: {
        customer_code: customer.customer_code,
        first_name: customer.first_name,
        last_name: customer.last_name,
        email: customer.email,
        phone: customer.phone,
        wallet_balance: 0,
        createdAt: customer.createdAt
      }
    });
  } catch (err) {
    console.error('create-customer error:', err);
    const status = err.httpStatus && err.httpStatus < 500 ? err.httpStatus : 502;
    return res.status(status).json({
      status: false,
      message: err.message || 'Failed to create customer on Paystack.'
    });
  }
}

async function handleDelete(req, res) {
  const { customer_code } = req.body || {};
  if (!customer_code) {
    return res.status(400).json({ status: false, message: 'customer_code is required.' });
  }

  let paystackWarning = null;

  try {
    await paystackRequest('/customer/set_risk_action', {
      method: 'POST',
      body: { customer: customer_code, risk_action: 'deny' }
    });
  } catch (err) {
    console.warn('delete-customer: Paystack set_risk_action failed:', err.message);
    paystackWarning = err.message;
  }

  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from('removed_customers')
      .upsert({ customer_code, removed_at: new Date().toISOString() }, { onConflict: 'customer_code' });

    if (error) throw error;
  } catch (err) {
    console.error('delete-customer: Supabase upsert failed:', err);
    return res.status(502).json({
      status: false,
      message: 'Could not record the removal. Customer was not deleted.',
      details: err.message
    });
  }

  return res.status(200).json({
    status: true,
    message: paystackWarning
      ? `Customer removed from directory. Note: Paystack blacklist failed (${paystackWarning}).`
      : 'Customer removed and blocked from further transactions.'
  });
}

async function fetchAllPages(path) {
  let page = 1;
  let all = [];

  while (page <= MAX_PAGES) {
    const json = await paystackRequest(`${path}?perPage=${PER_PAGE}&page=${page}`);
    const data = json.data || [];
    all = all.concat(data);

    const totalPages = (json.meta && json.meta.pageCount) || 1;
    if (page >= totalPages) break;
    page += 1;
  }

  return all;
}

async function filterRemovedCustomers(customers) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return customers;
  }

  try {
    const supabase = getSupabaseAdmin();
    const { data: removed, error } = await supabase.from('removed_customers').select('customer_code');
    if (error) throw error;

    const removedCodes = new Set((removed || []).map(r => r.customer_code));
    return customers.filter(c => !removedCodes.has(c.customer_code));
  } catch (err) {
    console.warn('get-customers: removed_customers filter skipped:', err.message);
    return customers;
  }
}

function shapeCustomer(c) {
  return {
    customer_code: c.customer_code,
    first_name: c.first_name,
    last_name: c.last_name,
    email: c.email,
    phone: c.phone,
    wallet_balance: Number(c.wallet_balance) || 0,
    createdAt: c.createdAt || c.created_at
  };
}

function shapeTransaction(t) {
  return {
    reference: t.reference,
    amount: t.amount,
    status: t.status,
    createdAt: t.createdAt || t.created_at || t.paidAt || t.paid_at,
    customer: t.customer ? { email: t.customer.email } : null
  };
}