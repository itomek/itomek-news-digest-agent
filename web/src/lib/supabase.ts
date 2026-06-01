import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { digestsQuery, topicsQuery } from "./query";
import type { Digest, Topic } from "./types";

// Browser client: anon/publishable key ONLY. All reads are RLS-gated.
// NEVER import or ship the service_role key here.

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (cached) return cached;
  if (!url || !anonKey) {
    throw new Error(
      "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy web/.env.example to web/.env.",
    );
  }
  cached = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return cached;
}

export async function fetchDigests(client: SupabaseClient, limit?: number): Promise<Digest[]> {
  const spec = digestsQuery({ limit });
  let q = client.from(spec.table).select(spec.columns).order(spec.order.column, {
    ascending: spec.order.ascending,
  });
  if (spec.limit) q = q.limit(spec.limit);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as Digest[];
}

export async function fetchTopics(client: SupabaseClient): Promise<Topic[]> {
  const spec = topicsQuery();
  const { data, error } = await client
    .from(spec.table)
    .select(spec.columns)
    .order(spec.order.column, { ascending: spec.order.ascending });
  if (error) throw error;
  return (data ?? []) as unknown as Topic[];
}

// --- Extension point for #12 (history) -------------------------------------
// Append history-specific query functions BELOW this line. Do not modify the
// functions above; #11 and #12 must not collide on the same code. Example:
//   export async function fetchDigestsForTopic(client, slug, opts) { ... }
// ---------------------------------------------------------------------------

/**
 * Fetches the full digest history (newest first), reusing the shared digest query
 * shape. The dataset is tiny (~5 topics x 30 days = 150 rows), so the history view
 * does all filtering, searching and grouping client-side — no server-side FTS. A
 * generous default limit guards against unbounded growth without paging.
 */
export async function fetchAllDigests(
  client: SupabaseClient,
  limit = 1000,
): Promise<Digest[]> {
  return fetchDigests(client, limit);
}
