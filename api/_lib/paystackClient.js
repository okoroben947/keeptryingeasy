// /api/_lib/paystackClient.js
//
// Thin wrapper around Paystack's REST API. Uses the global `fetch` that's built
// into the Node.js 18+ runtime Vercel uses by default.

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

export async function paystackRequest(path, { method = 'GET', body } = {}) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    throw new Error('PAYSTACK_SECRET_KEY is not set in environment variables.');
  }

  const res = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok || json.status === false) {
    const message = (json && json.message) || `Paystack request to ${path} failed with status ${res.status}`;
    const err = new Error(message);
    err.paystackResponse = json;
    err.httpStatus = res.status;
    throw err;
  }

  return json;
}