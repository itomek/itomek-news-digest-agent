// Shared data shapes. Mirrors the Supabase schema (docs/architecture.md §3.1).

/** One source reference attached to a digest item. */
export interface DigestItemSource {
  title: string;
  url: string;
}

/** One ranked item in a structured digest (issue #58). */
export interface DigestItem {
  headline: string;
  blurb: string;
  detail: string;
  metadata?: {
    sources?: DigestItemSource[];
    tags?: string[];
  };
}

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
  /** Short top-level overview; null on pre-#58 rows. */
  summary: string | null;
  /** Ranked structured items; null on pre-#58 rows. */
  items: DigestItem[] | null;
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
