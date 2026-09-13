-- Run this once in Supabase SQL Editor. Creates a record-keeping table for
-- one-off service payments made through pricing.html (NIN registration, CAC
-- registration, etc.) -- separate from wallets/wallet_transactions, which
-- are only for the wallet-funding flow in profile.html.
--
-- pricing.html has no login system, so these rows are identified by the
-- customer's email/reference rather than a user_id.

CREATE TABLE public.service_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  amount numeric(12,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'unknown',
  service_name text,
  customer_email text,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- "UNIQUE" on reference is what makes the upsert() calls in verify-payment.js
-- and paystack-webhook.js safe to run twice for the same payment -- the
-- second call just updates the existing row instead of creating a duplicate.

-- This table is only ever written to by your backend (service_role key),
-- and there's no public-facing page reading from it yet, so Row Level
-- Security stays OFF for now -- turning it on with no policies would just
-- make even your own backend's service_role-bypassing writes work fine, but
-- there's nothing here for it to protect from client-side access yet since
-- no client code queries this table directly.
--
-- If you later build an admin dashboard that reads this table from the
-- browser (e.g. an admin.html), come back and enable RLS with a policy
-- restricted to a specific admin account -- ask me and I'll set that up
-- when you're ready for it.