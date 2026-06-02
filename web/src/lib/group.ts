import type { DateGroup, Digest, Topic, TopicGroup } from "./types";

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
