// /api/_lib/supabaseAdmin.js
//
// Server-side Supabase client using the SERVICE ROLE key, which bypasses Row
// Level Security. This must only ever run inside serverless functions --
// never send this key to the browser (your register/login/profile pages
// correctly use the public anon key instead; keep it that way).
//
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// (SUPABASE_URL is the same value already used client-side; the service role
// key is a different, secret key found in Supabase under Project Settings > API.)

import { createClient } from '@supabase/supabase-js';

let cachedClient = null;

export function getSupabaseAdmin() {
  if (cachedClient) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment variables.');
  }

  cachedClient = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  return cachedClient;
}