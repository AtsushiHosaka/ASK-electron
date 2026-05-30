import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@shared/database.types";
import { getPublicEnv } from "./env";

let client: SupabaseClient<Database> | null = null;

export const getSupabaseClient = (): SupabaseClient<Database> | null => {
  const result = getPublicEnv();

  if (!result.ok) {
    return null;
  }

  client ??= createClient<Database>(result.env.supabaseUrl, result.env.supabasePublishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false
    }
  });

  return client;
};
