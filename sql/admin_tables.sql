-- Run this once in your Supabase project's SQL editor.
-- These tables back /api/delete-customer.js and /api/send-money.js.
-- Both are written to using the SERVICE ROLE key from serverless functions only,
-- so Row Level Security can stay locked down (deny-all) for normal/anon clients.

-- ==========================================================================
-- removed_customers
-- Paystack has no real "delete customer" endpoint, so deletions are recorded
-- here instead. /api/get-customers.js already reads this table and filters
-- these customer_codes out of what it returns - no extra wiring needed once
-- this table exists and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are set.
-- ==========================================================================
create table if not exists removed_customers (
  customer_code text primary key,
  removed_at timestamptz not null default now()
);

alter table removed_customers enable row level security;
-- No policies are added on purpose: with RLS on and zero policies, only
-- requests using the service role key (server-side) can read/write this table.

-- ==========================================================================
-- disbursements
-- Audit trail of every "Send Money" attempt from the admin dashboard, whether
-- it succeeded or failed. Useful for reconciliation and for building a
-- "Recent Disbursements" panel in the Managers/Settings section later.
-- ==========================================================================
create table if not exists disbursements (
  id bigint generated always as identity primary key,
  recipient_type text not null check (recipient_type in ('customer', 'manager')),
  recipient_id text not null,
  recipient_name text not null,
  amount numeric not null,
  note text,
  status text not null,
  transfer_code text,
  error_message text,
  created_at timestamptz not null default now()
);

alter table disbursements enable row level security;
-- Same as above: no policies added, service-role-only access by design.

create index if not exists disbursements_recipient_idx
  on disbursements (recipient_type, recipient_id);