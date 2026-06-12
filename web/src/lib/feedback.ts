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
