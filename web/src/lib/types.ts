// Shared data shapes. Mirrors the Supabase schema (docs/architecture.md §3.1).

export interface Digest {
  id: string;
  topic_slug: string;
  content: string;
  cadence: string;
  digest_date: string; // ISO date (YYYY-MM-DD)
  sources_used: unknown;
  token_count: number | null;
  prompt_version: string;
  created_at: string;
}

export interface Topic {
  id: number;
  name: string;
  slug: string;
  cadence: string;
  enabled: boolean;
}

/** One topic group, holding its digests bucketed by date (newest first). */
export interface TopicGroup {
  slug: string;
  name: string;
  dates: DateGroup[];
}

export interface DateGroup {
  date: string;
  digests: Digest[];
}
