import type { DateGroup, DateTopicBucket, DateTopicGroup, Digest, Topic, TopicGroup } from "./types";

// Pure grouping: digests -> [topic][date] buckets, newest first throughout.

export function groupDigestsByTopicAndDate(
  digests: readonly Digest[],
  topics: readonly Topic[],
): TopicGroup[] {
  const nameBySlug = new Map(topics.map((t) => [t.slug, t.name]));

  const bySlug = new Map<string, Map<string, Digest[]>>();
  for (const d of digests) {
    let dates = bySlug.get(d.topic_slug);
    if (!dates) {
      dates = new Map();
      bySlug.set(d.topic_slug, dates);
    }
    const bucket = dates.get(d.digest_date) ?? [];
    bucket.push(d);
    dates.set(d.digest_date, bucket);
  }

  const groups: TopicGroup[] = [];
  for (const [slug, dateMap] of bySlug) {
    const dates: DateGroup[] = [...dateMap.entries()]
      .map(([date, ds]) => ({ date, digests: ds }))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    groups.push({ slug, name: nameBySlug.get(slug) ?? slug, dates });
  }

  // Order topic groups by their most recent digest date, descending.
  groups.sort((a, b) => {
    const aMax = a.dates[0]?.date ?? "";
    const bMax = b.dates[0]?.date ?? "";
    return aMax < bMax ? 1 : aMax > bMax ? -1 : 0;
  });

  return groups;
}

/**
 * Date-first grouping: bucket digests by calendar date (newest date first),
 * then nest topics within each date (ordered by topics array position).
 * Topics absent from the topics list fall back to their slug as the name.
 */
export function groupDigestsByDateAndTopic(
  digests: readonly Digest[],
  topics: readonly Topic[],
): DateTopicGroup[] {
  const nameBySlug = new Map(topics.map((t) => [t.slug, t.name]));
  // Preserve topic array order for stable per-date topic ordering.
  const topicOrder = new Map(topics.map((t, i) => [t.slug, i]));

  // date → slug → Digest[]
  const byDate = new Map<string, Map<string, Digest[]>>();
  for (const d of digests) {
    let slugMap = byDate.get(d.digest_date);
    if (!slugMap) {
      slugMap = new Map();
      byDate.set(d.digest_date, slugMap);
    }
    const bucket = slugMap.get(d.topic_slug) ?? [];
    bucket.push(d);
    slugMap.set(d.topic_slug, bucket);
  }

  const groups: DateTopicGroup[] = [];
  for (const [date, slugMap] of byDate) {
    const topicBuckets: DateTopicBucket[] = [...slugMap.entries()]
      .map(([slug, ds]) => ({ slug, name: nameBySlug.get(slug) ?? slug, digests: ds }))
      .sort((a, b) => {
        const ai = topicOrder.get(a.slug) ?? Number.MAX_SAFE_INTEGER;
        const bi = topicOrder.get(b.slug) ?? Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
      });
    groups.push({ date, topics: topicBuckets });
  }

  // Newest date first.
  groups.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return groups;
}
