// Feedback helpers — pure row-shape builders + Supabase INSERT.
//
// All writes land in system_logs with category='feedback'. The authenticated
// RLS policy (migration 0012) allows only category='feedback' inserts, so the
// service_role key is NOT required here.
//
// Feedback types:
//   thumbs_down  — negative signal on the whole digest
//   positive     — positive signal on the whole digest ("this was great")
//   comment      — free-text comment, max 500 chars
//   source_flag  — one of the digest's source URLs flagged as bad
//   item_flag    — a specific structured item flagged as bad

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Digest } from "./types";

export type FeedbackType =
  | "thumbs_down"
  | "positive"
  | "comment"
  | "source_flag"
  | "item_flag";

export interface FeedbackRow {
  level: "info";
  category: "feedback";
  topic_slug: string;
  message: string;
  metadata: {
    digest_id: string;
    topic_slug: string;
    prompt_version: string;
    digest_date: string;
    feedback_type: FeedbackType;
    tags: ["feedback", "quality"];
    comment_text?: string;
    source_url?: string;
    item_index?: number;
    item_headline?: string;
  };
}

/** Build a system_logs row for a thumbs-down or positive signal. */
export function buildSignalRow(
  digest: Digest,
  feedbackType: "thumbs_down" | "positive",
): FeedbackRow {
  return {
    level: "info",
    category: "feedback",
    topic_slug: digest.topic_slug,
    message: `${feedbackType} feedback on digest ${digest.id}`,
    metadata: {
      digest_id: digest.id,
      topic_slug: digest.topic_slug,
      prompt_version: digest.prompt_version,
      digest_date: digest.digest_date,
      feedback_type: feedbackType,
      tags: ["feedback", "quality"],
    },
  };
}

/** Build a system_logs row for a free-text comment (max 500 chars, enforced). */
export function buildCommentRow(digest: Digest, commentText: string): FeedbackRow {
  const trimmed = commentText.slice(0, 500);
  return {
    level: "info",
    category: "feedback",
    topic_slug: digest.topic_slug,
    message: `comment feedback on digest ${digest.id}`,
    metadata: {
      digest_id: digest.id,
      topic_slug: digest.topic_slug,
      prompt_version: digest.prompt_version,
      digest_date: digest.digest_date,
      feedback_type: "comment",
      tags: ["feedback", "quality"],
      comment_text: trimmed,
    },
  };
}

/** Build a system_logs row for a flagged source URL. */
export function buildSourceFlagRow(digest: Digest, sourceUrl: string): FeedbackRow {
  return {
    level: "info",
    category: "feedback",
    topic_slug: digest.topic_slug,
    message: `source_flag feedback on digest ${digest.id}: ${sourceUrl}`,
    metadata: {
      digest_id: digest.id,
      topic_slug: digest.topic_slug,
      prompt_version: digest.prompt_version,
      digest_date: digest.digest_date,
      feedback_type: "source_flag",
      tags: ["feedback", "quality"],
      source_url: sourceUrl,
    },
  };
}

/** Build a system_logs row for a flagged digest item. */
export function buildItemFlagRow(
  digest: Digest,
  itemIndex: number,
  itemHeadline: string,
): FeedbackRow {
  return {
    level: "info",
    category: "feedback",
    topic_slug: digest.topic_slug,
    message: `item_flag feedback on digest ${digest.id} item ${itemIndex}`,
    metadata: {
      digest_id: digest.id,
      topic_slug: digest.topic_slug,
      prompt_version: digest.prompt_version,
      digest_date: digest.digest_date,
      feedback_type: "item_flag",
      tags: ["feedback", "quality"],
      item_index: itemIndex,
      item_headline: itemHeadline,
    },
  };
}

/** Extract the distinct source URLs used in a digest (sources_used + item metadata sources). */
export function extractSourceUrls(digest: Digest): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  // sources_used column
  const top = digest.sources_used;
  if (Array.isArray(top)) {
    for (const s of top as unknown[]) {
      if (typeof s === "string" && s.startsWith("http")) {
        if (!seen.has(s)) { seen.add(s); result.push(s); }
      }
    }
  }

  // item-level metadata.sources
  for (const item of digest.items ?? []) {
    for (const src of item.metadata?.sources ?? []) {
      if (src.url && src.url.startsWith("http")) {
        if (!seen.has(src.url)) { seen.add(src.url); result.push(src.url); }
      }
    }
  }

  return result;
}

/**
 * Submit a single feedback row to system_logs.
 * Returns null on success, or an error string on failure.
 */
export async function submitFeedback(
  client: SupabaseClient,
  row: FeedbackRow,
): Promise<string | null> {
  const { error } = await client.from("system_logs").insert(row);
  if (error) return error.message;
  return null;
}

// ─── Flag state query ────────────────────────────────────────────────────────

export interface FlaggedState {
  flaggedSources: string[];
  flaggedItems: number[];
}

/**
 * Fetch the current flag state for a digest.
 * Returns the set of flagged source URLs and flagged item indices persisted in
 * system_logs. Reads under migration 0006's system_logs_authenticated_read policy.
 */
export async function fetchFlaggedState(
  client: SupabaseClient,
  digestId: string,
): Promise<FlaggedState> {
  const { data, error } = await client
    .from("system_logs")
    .select("*")
    .eq("category", "feedback")
    .eq("level", "info")
    .filter("metadata->>digest_id", "eq", digestId)
    .in("metadata->>feedback_type", ["source_flag", "item_flag"]);

  if (error || !data) return { flaggedSources: [], flaggedItems: [] };

  const flaggedSources: string[] = [];
  const flaggedItems: number[] = [];

  for (const row of data as Array<{ metadata: Record<string, unknown> }>) {
    const meta = row.metadata ?? {};
    if (meta["feedback_type"] === "source_flag" && typeof meta["source_url"] === "string") {
      if (!flaggedSources.includes(meta["source_url"])) {
        flaggedSources.push(meta["source_url"]);
      }
    } else if (meta["feedback_type"] === "item_flag" && meta["item_index"] !== undefined) {
      const idx = Number(meta["item_index"]);
      if (!Number.isNaN(idx) && !flaggedItems.includes(idx)) {
        flaggedItems.push(idx);
      }
    }
  }

  return { flaggedSources, flaggedItems };
}

// ─── Flag removal ────────────────────────────────────────────────────────────

/**
 * Hard-delete all source_flag rows for the given digest + source URL.
 * Removes duplicates too (real data confirmed they exist before this change).
 * Returns null on success, or an error message string on failure.
 */
export async function removeSourceFlag(
  client: SupabaseClient,
  digestId: string,
  sourceUrl: string,
): Promise<string | null> {
  const { error } = await client
    .from("system_logs")
    .delete()
    .eq("category", "feedback")
    .filter("metadata->>digest_id", "eq", digestId)
    .filter("metadata->>source_url", "eq", sourceUrl)
    .filter("metadata->>feedback_type", "eq", "source_flag");

  if (error) return error.message;
  return null;
}

/**
 * Hard-delete all item_flag rows for the given digest + item index.
 * Removes duplicates too (confirmed real data has duplicate flag rows).
 * Returns null on success, or an error message string on failure.
 */
export async function removeItemFlag(
  client: SupabaseClient,
  digestId: string,
  itemIndex: number,
): Promise<string | null> {
  const { error } = await client
    .from("system_logs")
    .delete()
    .eq("category", "feedback")
    .filter("metadata->>digest_id", "eq", digestId)
    .filter("metadata->>item_index", "eq", String(itemIndex))
    .filter("metadata->>feedback_type", "eq", "item_flag");

  if (error) return error.message;
  return null;
}

// ─── Toggle helpers ───────────────────────────────────────────────────────────

/**
 * Toggle the source flag for a URL.
 * If already flagged (`isCurrentlyFlagged=true`): deletes the flag row(s).
 * If not flagged: inserts a new flag row (idempotent — caller must check state first).
 * Returns null on success, or an error string on failure.
 */
export async function toggleSourceFlag(
  client: SupabaseClient,
  digest: Digest,
  sourceUrl: string,
  isCurrentlyFlagged: boolean,
): Promise<string | null> {
  if (isCurrentlyFlagged) {
    return removeSourceFlag(client, digest.id, sourceUrl);
  }
  return submitFeedback(client, buildSourceFlagRow(digest, sourceUrl));
}

/**
 * Toggle the item flag for a digest item.
 * If already flagged (`isCurrentlyFlagged=true`): deletes the flag row(s).
 * If not flagged: inserts a new flag row.
 * `itemHeadline` is used only for the insert path (stored in the log row).
 * Returns null on success, or an error string on failure.
 */
export async function toggleItemFlag(
  client: SupabaseClient,
  digest: Digest,
  itemIndex: number,
  isCurrentlyFlagged: boolean,
  itemHeadline = "",
): Promise<string | null> {
  if (isCurrentlyFlagged) {
    return removeItemFlag(client, digest.id, itemIndex);
  }
  return submitFeedback(client, buildItemFlagRow(digest, itemIndex, itemHeadline));
}
