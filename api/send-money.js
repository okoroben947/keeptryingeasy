// /api/send-money.js
//
// Disburses real money to a customer or a manager via Paystack Transfers.

import requireAdmin from './_lib/requireAdmin.js';
import { paystackRequest } from './_lib/paystackClient.js';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ status: false, message: 'Method not allowed. Use POST.' });
  }

  if (!requireAdmin(req, res)) return;

  const {
    recipient_type,
    recipient_id,
    recipient_name,
    amount,
    note,
    account_number,
    bank_code,
    account_name
  } = req.body || {};

  if (!recipient_type || !recipient_id || !recipient_name) {
    return res.status(400).json({ status: false, message: 'recipient_type, recipient_id and recipient_name are required.' });
  }

  const numericAmount = Number(amount);
  if (!numericAmount || numericAmount <= 0) {
    return res.status(400).json({ status: false, message: 'amount must be a number greater than zero.' });
  }

  if (!account_number || !bank_code) {
    return res.status(400).json({
      status: false,
      message: 'account_number and bank_code are required to send money via Paystack Transfers. Add these fields to the Send Money form.'
    });
  }

  let recipientCode = null;
  let transferResult = null;

  try {
    const recipientRes = await paystackRequest('/transferrecipient', {
      method: 'POST',
      body: {
        type: 'nuban',
        name: account_name || recipient_name,
        account_number,
        bank_code,
        currency: 'NGN'
      }
    });
    recipientCode = recipientRes.data.recipient_code;

    const transferRes = await paystackRequest('/transfer', {
      method: 'POST',
      body: {
        source: 'balance',
        amount: Math.round(numericAmount * 100), // naira -> kobo
        recipient: recipientCode,
        reason: note || `Payment to ${recipient_name}`
      }
    });
    transferResult = transferRes.data;
  } catch (err) {
    console.error('send-money: Paystack transfer failed:', err);

    await logDisbursement({
      recipient_type,
      recipient_id,
      recipient_name,
      amount: numericAmount,
      note,
      status: 'failed',
      transfer_code: null,
      error_message: err.message
    });

    const status = err.httpStatus && err.httpStatus < 500 ? err.httpStatus : 502;
    return res.status(status).json({ status: false, message: err.message || 'Transfer failed.' });
  }

  await logDisbursement({
    recipient_type,
    recipient_id,
    recipient_name,
    amount: numericAmount,
    note,
    status: transferResult.status || 'pending',
    transfer_code: transferResult.transfer_code || null,
    error_message: null
  });

  return res.status(200).json({
    status: true,
    message: `Transfer of ₦${numericAmount.toLocaleString()} to ${recipient_name} was submitted (status: ${transferResult.status}).`,
    transfer: {
      transfer_code: transferResult.transfer_code,
      status: transferResult.status
    }
  });
}

async function logDisbursement(entry) {
  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from('disbursements').insert({
      recipient_type: entry.recipient_type,
      recipient_id: entry.recipient_id,
      recipient_name: entry.recipient_name,
      amount: entry.amount,
      note: entry.note || null,
      status: entry.status,
      transfer_code: entry.transfer_code,
      error_message: entry.error_message,
      created_at: new Date().toISOString()
    });
    if (error) console.error('send-money: failed to log disbursement:', error);
  } catch (err) {
    console.error('send-money: logDisbursement threw:', err);
  }
}