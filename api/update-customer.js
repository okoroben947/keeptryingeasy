// /api/update-customer.js
//
// Updates a customer's first name, last name, and phone number on Paystack
// (email is intentionally not editable here -- Paystack uses it as part of
// how a customer is identified, and changing it isn't supported the same way).
//
// Method: PATCH
// Body:   { customer_code, first_name, last_name, phone }   (customer_code + first_name required)
// Header: x-admin-password: <the dashboard master password>
//
// Required env vars: PAYSTACK_SECRET_KEY, ADMIN_MASTER_PASSWORD

const requireAdmin = require('./_lib/requireAdmin');
const { paystackRequest } = require('./_lib/paystackClient');

module.exports = async function handler(req, res) {
  if (req.method !== 'PATCH' && req.method !== 'PUT') {
    res.setHeader('Allow', 'PATCH, PUT');
    return res.status(405).json({ status: false, message: 'Method not allowed. Use PATCH.' });
  }

  if (!requireAdmin(req, res)) return;

  try {
    const { customer_code, first_name, last_name, phone } = req.body || {};

    if (!customer_code) {
      return res.status(400).json({ status: false, message: 'customer_code is required.' });
    }
    if (!first_name) {
      return res.status(400).json({ status: false, message: 'first_name is required.' });
    }

    const paystackRes = await paystackRequest(`/customer/${encodeURIComponent(customer_code)}`, {
      method: 'PUT',
      body: {
        first_name,
        last_name: last_name || '',
        phone: phone || undefined
      }
    });

    const customer = paystackRes.data;

    // Shaped to match /api/get-customers and /api/create-customer, so the
    // frontend can drop this straight into globalCustomers with no special-casing.
    return res.status(200).json({
      status: true,
      message: 'Customer updated successfully.',
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
    console.error('update-customer error:', err);
    const status = err.httpStatus && err.httpStatus < 500 ? err.httpStatus : 502;
    return res.status(status).json({
      status: false,
      message: err.message || 'Failed to update customer on Paystack.'
    });
  }
};