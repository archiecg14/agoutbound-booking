/**
 * Service-role Supabase client.
 *
 * Every table has RLS enabled with no policies (see 0001_init.sql), so this key is the only
 * way in. It must never reach the browser: this module is server-only, and the env var is
 * deliberately NOT prefixed with NEXT_PUBLIC_, which is what stops Next inlining it into
 * client bundles.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function serviceClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Fail loudly at first use rather than returning a client that 401s on every query —
  // a misconfigured deploy should be obvious in the first log line, not the tenth.
  if (!url) throw new Error("SUPABASE_URL is not set");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
