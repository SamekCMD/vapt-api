import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { AppConfig } from "./config.js";

export function createSupabaseAdminClient(config: AppConfig): SupabaseClient {
  return createClient(config.supabase.url.toString(), config.supabase.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
