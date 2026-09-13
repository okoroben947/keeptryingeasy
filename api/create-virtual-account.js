import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';
import { paystackRequest } from './_lib/paystackClient.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ status: false, message: 'Method not allowed. Use POST.' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ status: false, message: 'Missing auth token.' });
  }

  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (err) {
    console.error('create-virtual-account config error:', err);
    return res.status(500).json({ status: false, message: 'Server misconfiguration.' });
  }

  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return res.status(401).json({ status: false, message: 'Invalid or expired session.' });
    }

    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    if (walletError) {
      console.error('Wallet lookup error:', walletError);
    }

    if (wallet && wallet.virtual_account_number) {
      return res.status(200).json({
        status: true,
        account_number: wallet.virtual_account_number,
        bank: wallet.virtual_account_provider
      });
    }

    const metadata = user.user_metadata || {};
    const firstName = metadata.first_name || 'Valued';
    const lastName = metadata.last_name || 'Client';
    const phone = metadata.phone || undefined;

    let customerCode;
    try {
      const createRes = await paystackRequest('/customer', {
        method: 'POST',
        body: { email: user.email, first_name: firstName, last_name: lastName, phone }
      });
      
      if (createRes && createRes.data) {
        customerCode = createRes.data.customer_code;
      }
    } catch (err) {
      const alreadyExists = /already exist/i.test(err.message || '');
      if (alreadyExists || (err.response && err.response.status === 400)) {
        const lookupRes = await paystackRequest(`/customer/${encodeURIComponent(user.email)}`);
        if (lookupRes && lookupRes.data) {
          customerCode = lookupRes.data.customer_code;
        } else {
          throw new Error('Could not fetch existing Paystack customer data.');
        }
      } else {
        throw err;
      }
    }

    if (!customerCode) {
      throw new Error('Failed to obtain Paystack customer code.');
    }

    const isTestKey = (process.env.PAYSTACK_SECRET_KEY || '').startsWith('sk_test_');
    const preferredBank = isTestKey ? 'test-bank' : 'wema-bank';

    const dvaRes = await paystackRequest('/dedicated_account', {
      method: 'POST',
      body: { customer: customerCode, preferred_bank: preferredBank }
    });

    if (!dvaRes || !dvaRes.data) {
      throw new Error(dvaRes?.message || 'Failed to generate virtual account from Paystack');
    }

    const accountNumber = dvaRes.data.account_number;
    const bankName = (dvaRes.data.bank && dvaRes.data.bank.name) || preferredBank;

    const walletPayload = {
      user_id: user.id,
      virtual_account_number: accountNumber,
      virtual_account_provider: bankName,
      updated_at: new Date().toISOString()
    };

    if (wallet && wallet.balance !== undefined) {
      walletPayload.balance = wallet.balance;
    }

    const { error: upsertError } = await supabase
      .from('wallets')
      .upsert(walletPayload, { onConflict: 'user_id' });

    if (upsertError) {
      console.error('Database wallet save error:', upsertError);
    }

    return res.status(200).json({ status: true, account_number: accountNumber, bank: bankName });

  } catch (err) {
    console.error('create-virtual-account error:', err);
    const status = err.httpStatus && err.httpStatus < 500 ? err.httpStatus : 502;
    return res.status(status).json({
      status: false,
      message: err.message || 'Could not create a virtual account right now.'
    });
  }
}