import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Server-only Supabase client (service role — bypasses RLS; the API enforces anti-cheat).
 *  Returns null when not configured or under tests, so the app keeps working with the
 *  in-memory store and persistence simply turns off. Keys are read from env, never hardcoded. */
let cached: SupabaseClient | null | undefined;
export function getServiceClient(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  cached = url && key && process.env.NODE_ENV !== 'test'
    ? createClient(url, key, { auth: { persistSession: false } })
    : null;
  if (cached) console.info('[supabase] persistence enabled (service role)');
  return cached;
}
export const isSupabaseConfigured = (): boolean => getServiceClient() !== null;
/** storage_path is stored as "{bucket}/{object}" — build the public URL for public buckets. */
export const publicStorageUrl = (storagePath: string): string =>
  `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${storagePath}`;
