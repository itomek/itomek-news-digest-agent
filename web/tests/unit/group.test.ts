import { describe, expect, it } from "vitest";
import { groupDigestsByTopicAndDate } from "../../src/lib/group";
import type { Digest, Topic } from "../../src/lib/types";

function digest(partial: Partial<Digest> & { topic_slug: string; digest_date: string }): Digest {
  return {
    id: `${partial.topic_slug}-${partial.digest_date}`,
    content: "x",
    cadence: "24h",
    sources_used: [],
    token_count: null,
    prompt_version: "v",
    created_at: "2026-06-01T00:00:00Z",
    summary: null,
    items: null,
    ...partial,
  };
}

const topics: Topic[] = [
  { id: 1, name: "AI model releases", slug: "ai_models", cadence: "24h", enabled: true },
  { id: 2, name: "Local news", slug: "local_news", cadence: "7d", enabled: true },
];

describe("groupDigestsByTopicAndDate", () => {
  it("groups by topic, then by date descending", () => {
    const digests = [
      digest({ topic_slug: "ai_models", digest_date: "2026-05-30" }),
      digest({ topic_slug: "ai_models", digest_date: "2026-06-01" }),
      digest({ topic_slug: "local_news", digest_date: "2026-05-31" }),
      digest({ topic_slug: "ai_models", digest_date: "2026-05-31" }),
    ];

    const groups = groupDigestsByTopicAndDate(digests, topics);

    const ai = groups.find((g) => g.slug === "ai_models")!;
    expect(ai.name).toBe("AI model releases");
    expect(ai.dates.map((d) => d.date)).toEqual([
      "2026-06-01",
      "2026-05-31",
      "2026-05-30",
    ]);

    const local = groups.find((g) => g.slug === "local_news")!;
    expect(local.dates.map((d) => d.date)).toEqual(["2026-05-31"]);
  });

  it("falls back to the slug as the name when no topic metadata matches", () => {
    const groups = groupDigestsByTopicAndDate(
      [digest({ topic_slug: "mystery", digest_date: "2026-06-01" })],
      [],
    );
    expect(groups[0].name).toBe("mystery");
  });

  it("returns an empty array for no digests", () => {
    expect(groupDigestsByTopicAndDate([], topics)).toEqual([]);
  });

  it("orders topic groups by most recent digest date descending", () => {
    const digests = [
      digest({ topic_slug: "local_news", digest_date: "2026-06-05" }),
      digest({ topic_slug: "ai_models", digest_date: "2026-06-01" }),
    ];
    const groups = groupDigestsByTopicAndDate(digests, topics);
    expect(groups.map((g) => g.slug)).toEqual(["local_news", "ai_models"]);
  });
});
