// api/customers.js
import { paystackRequest } from './_lib/paystackClient.js';
import requireAdmin from './_lib/requireAdmin.js';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';

const MAX_PAGES = 5;   // safety cap: up to 5 x 100 = 500 records per list
const PER_PAGE = 100;

export default async function handler(req, res) {
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
    const [customers, transactions] = await Promise.all([
      fetchAllPages('/customer'),
      fetchAllPages('/transaction')
    ]);

    const visibleCustomers = await filterRemovedCustomers(customers);

    return res.status(200).json({
      status: true,
      customers: visibleCustomers.map(shapeCustomer),
      transactions: transactions.map(shapeTransaction)
    });
  } catch (err) {
    console.error('get-customers error:', err);
    return res.status(502).json({
      status: false,
      message: err.message || 'Failed to fetch data from Paystack.'
    });
  }
}
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      // Fetch all records directly from Supabase customers table
      const { data: customers, error } = await supabase
        .from('customers')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      return res.status(200).json({
        status: true,
        customers: customers || []
      });
    } catch (error) {
      console.error('Error fetching customers from Supabase:', error);
      return res.status(500).json({ status: false, error: error.message });
    }
  }

  // Handle other HTTP methods (POST, DELETE, etc.)
}

async function handlePost(req, res) {
  if (!requireAdmin(req, res)) return;

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

    return res.status(200).json({
      status: true,
      message: 'Customer created successfully.',
      customer: {
        customer_code: customer.customer_code,
        first_name: customer.first_name,
        last_name: customer.last_name,
        email: customer.email,
        phone: customer.phone,
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
  if (!requireAdmin(req, res)) return;

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
      ? `Customer removed from your directory. Note: Paystack blacklist call failed (${paystackWarning}), so the customer may still be able to transact on Paystack directly.`
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