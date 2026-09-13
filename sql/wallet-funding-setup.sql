-- Run this whole file once in Supabase SQL Editor, after the wallets table
-- already exists (from the earlier setup). It adds:
--   1. A wallet_transactions table -- a permanent, auditable record of every
--      top-up (this becomes your real Payment History data too).
--   2. A credit_wallet() function that inserts the transaction and updates
--      the balance in one atomic step, and is idempotent: calling it twice
--      with the same reference (e.g. once from verify-wallet-funding.js and
--      once from the webhook) only credits the wallet once.

CREATE TABLE public.wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reference text NOT NULL UNIQUE,
  amount numeric(12,2) NOT NULL,
  status text NOT NULL DEFAULT 'success',
  channel text DEFAULT 'paystack',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;

-- Users can see their own transaction history (read-only from the browser).
CREATE POLICY "Users can view own wallet transactions"
  ON public.wallet_transactions
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Deliberately no INSERT/UPDATE policy for authenticated users -- only the
-- backend (using the service_role key, which bypasses RLS) should ever
-- write a transaction or change a balance.

CREATE OR REPLACE FUNCTION public.credit_wallet(
  p_user_id uuid,
  p_reference text,
  p_amount numeric
)
RETURNS void AS $$
BEGIN
  -- Idempotency guard: if this Paystack reference was already processed
  -- (e.g. the webhook and the browser call both fired), do nothing.
  IF EXISTS (SELECT 1 FROM public.wallet_transactions WHERE reference = p_reference) THEN
    RETURN;
  END IF;

  INSERT INTO public.wallet_transactions (user_id, reference, amount, status)
  VALUES (p_user_id, p_reference, p_amount, 'success');

  UPDATE public.wallets
  SET balance = balance + p_amount,
      updated_at = now()
  WHERE user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;