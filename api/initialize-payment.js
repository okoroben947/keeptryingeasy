export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { email, amount } = req.body;

  try {
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: email,
        // Paystack expects amounts in the lowest currency unit (e.g., Kobo for NGN).
        // Multiply by 100 if your frontend sends the main currency amount.
        amount: amount * 100, 
      }),
    });

    const data = await response.json();

    if (!data.status) {
      return res.status(400).json({ error: data.message });
    }

    // Return the authorization_url and reference to the frontend
    return res.status(200).json(data.data);
  } catch (error) {
    console.error('Paystack initialization failed:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}