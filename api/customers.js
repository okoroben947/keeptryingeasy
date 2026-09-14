// api/customers.js
//
// One endpoint handling all customer CRUD, kept as a single file to stay
// well under Vercel Hobby's 12-function limit. Routes by HTTP method:
//   GET    -> list customers + transactions (admin-only, for dashboard.html)
//   POST   -> create a customer (admin-only)
//   DELETE -> "delete" a customer (admin-only; see handleDelete for the
//             real mechanics, since Paystack has no true delete)
//   PATCH  -> update a customer's first_name/last_name/phone (admin-only)
//
// This used to be four separate files (get-customers.js, create-customer.js,
// delete-customer.js, update-customer.js) -- merged here for the function-
// count limit. If you still have those four files sitting in your api/
// folder, delete them now; this file replaces all of them.

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
    case 'PATCH':
    case 'PUT':
      return handlePatch(req, res);
    case 'DELETE':
      return handleDelete(req, res);
    default:
      res.setHeader('Allow', ['GET', 'POST', 'PATCH', 'DELETE']);
      return res.status(405).end(`Method ${method} Not Allowed`);
  }
}

async function handleGet(req, res) {
  if (!requireAdmin(req, res)) return;
  async function handleGet(req, res) {
  if (!requireAdmin(req, res)) return;

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  try {
    // 1. Initialize Supabase safely inside try block
    const supabase = getSupabaseAdmin();
    
    const { data: dbCustomers, error: dbError } = await supabase
      .from('customers')
      .select('*')
      .order('created_at', { ascending: false });

    if (dbError) {
      console.error('Supabase query error:', dbError.message);
      throw new Error(`Database error: ${dbError.message}`);
    }

    // 2. Fetch Paystack transactions safely
    let transactions = [];
    try {
      transactions = await fetchAllPages('/transaction');
    } catch (tErr) {
      console.warn('Paystack transactions fetch warning:', tErr.message);
    }

    return res.status(200).json({
      status: true,
      customers: (dbCustomers || []).map(c => ({
        id: c.id,
        first_name: c.first_name || '',
        last_name: c.last_name || '',
        email: c.email || '',
        phone: c.phone || null,
        createdAt: c.created_at
      })),
      transactions: (transactions || []).map(shapeTransaction)
    });
  } catch (err) {
    console.error('get-customers runtime crash:', err);
    return res.status(500).json({
      status: false,
      message: err.message || 'Internal Server Error'
    });
  }
}

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

async function handlePost(req, res) {
  if (!requireAdmin(req, res)) return;
  // Inside handlePost in api/customers.js
  async function handlePost(req, res) {
  if (!requireAdmin(req, res)) return;

  try {
    const body = req.body || {};
    
    // Accept both camelCase and snake_case from frontend form
    const first_name = body.first_name || body.firstName;
    const last_name = body.last_name || body.lastName || '';
    const email = body.email;
    const phone = body.phone || body.phone_number || body.phoneNumber || null;

    if (!email || !first_name) {
      return res.status(400).json({ status: false, message: 'first_name and email are required.' });
    }

    // 1. Create customer on Paystack
    const paystackRes = await paystackRequest('/customer', {
      method: 'POST',
      body: {
        email,
        first_name,
        last_name,
        phone: phone || undefined
      }
    });

    // Extract final phone value (prefer raw input, fallback to Paystack response)
    const finalPhone = phone || paystackRes?.data?.phone || null;

    // 2. Insert into Supabase customers table
    const supabase = getSupabaseAdmin();
    const { error: dbError } = await supabase
      .from('customers')
      .insert([
        {
          first_name,
          last_name,
          email,
          phone: finalPhone
        }
      ]);

    if (dbError) {
      console.error('create-customer: Supabase insert failed:', dbError.message);
    }

    return res.status(200).json({
      status: true,
      message: 'Customer created successfully.',
      customer: shapeCustomer(paystackRes.data)
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

// 1. Create customer on Paystack
const paystackRes = await paystackRequest('/customer', {
  method: 'POST',
  body: {
    email,
    first_name,
    last_name: last_name || '',
    phone: phone || undefined
  }
});

// 2. Insert into Supabase customers table and check for errors
const supabase = getSupabaseAdmin();
const { data: insertedCustomer, error: dbError } = await supabase
  .from('customers')
  .insert([
    {
      first_name,
      last_name: last_name || '',
      email,
      phone: phone || null
    }
  ])
  .select();

// 3. Fail explicitly if Supabase returns an error
if (dbError) {
  console.error('Supabase Save Error:', dbError);
  return res.status(500).json({
    status: false,
    message: 'Database error saving new user',
    details: dbError.message,
    hint: dbError.hint || null,
    code: dbError.code
  });
}

return res.status(200).json({
  status: true,
  message: 'Customer created successfully.',
  customer: shapeCustomer(paystackRes.data),
  db_record: insertedCustomer[0]
});

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

    return res.status(200).json({
      status: true,
      message: 'Customer created successfully.',
      customer: shapeCustomer(paystackRes.data)
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

async function handlePatch(req, res) {
  if (!requireAdmin(req, res)) return;

  try {
    const { customer_code, first_name, last_name, phone } = req.body || {};

    if (!customer_code) {
      return res.status(400).json({ status: false, message: 'customer_code is required.' });
    }
    if (!first_name) {
      return res.status(400).json({ status: false, message: 'first_name is required.' });
    }

    // Note: email is intentionally not editable here -- Paystack uses it as
    // part of how a customer is identified, and doesn't support changing it
    // the same simple way as name/phone.
    const paystackRes = await paystackRequest(`/customer/${encodeURIComponent(customer_code)}`, {
      method: 'PUT',
      body: {
        first_name,
        last_name: last_name || '',
        phone: phone || undefined
      }
    });

    return res.status(200).json({
      status: true,
      message: 'Customer updated successfully.',
      customer: shapeCustomer(paystackRes.data)
    });
  } catch (err) {
    console.error('update-customer error:', err);
    const status = err.httpStatus && err.httpStatus < 500 ? err.httpStatus : 502;
    return res.status(status).json({
      status: false,
      message: err.message || 'Failed to update customer on Paystack.'
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

if (dbError) {
  console.error('Database Save Error:', dbError);
  return res.status(500).json({
    status: false,
    message: 'Database error saving new user',
    details: dbError.message,
    hint: dbError.hint
  });
}