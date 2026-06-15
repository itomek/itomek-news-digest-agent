import { describe, expect, it } from "vitest";
import { groupDigestsByDateAndTopic, groupDigestsByTopicAndDate } from "../../src/lib/group";
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

describe("groupDigestsByDateAndTopic", () => {
  it("returns an empty array for no digests", () => {
    expect(groupDigestsByDateAndTopic([], topics)).toEqual([]);
  });

  it("groups by date (newest first), then topics nested within each date", () => {
    const digests = [
      digest({ topic_slug: "ai_models", digest_date: "2026-06-10" }),
      digest({ topic_slug: "local_news", digest_date: "2026-06-10" }),
      digest({ topic_slug: "ai_models", digest_date: "2026-06-09" }),
    ];

    const groups = groupDigestsByDateAndTopic(digests, topics);

    // Two distinct dates, newest first.
    expect(groups.map((g) => g.date)).toEqual(["2026-06-10", "2026-06-09"]);

    // June 10 has both topics.
    const june10 = groups[0];
    expect(june10.topics.map((t) => t.slug).sort()).toEqual(["ai_models", "local_news"]);

    // June 9 has only ai_models.
    const june9 = groups[1];
    expect(june9.topics).toHaveLength(1);
    expect(june9.topics[0].slug).toBe("ai_models");
    expect(june9.topics[0].digests).toHaveLength(1);
  });

  it("attaches the correct topic name from the topics list", () => {
    const digests = [digest({ topic_slug: "ai_models", digest_date: "2026-06-10" })];
    const groups = groupDigestsByDateAndTopic(digests, topics);
    expect(groups[0].topics[0].name).toBe("AI model releases");
  });

  it("falls back to slug when no topic metadata matches", () => {
    const digests = [digest({ topic_slug: "mystery", digest_date: "2026-06-10" })];
    const groups = groupDigestsByDateAndTopic(digests, []);
    expect(groups[0].topics[0].name).toBe("mystery");
  });

  it("orders topics within a date by the topics array order", () => {
    // topics = [ai_models (id:1), local_news (id:2)]
    const digests = [
      digest({ topic_slug: "local_news", digest_date: "2026-06-10" }),
      digest({ topic_slug: "ai_models", digest_date: "2026-06-10" }),
    ];
    const groups = groupDigestsByDateAndTopic(digests, topics);
    // topics list order: ai_models first, local_news second
    expect(groups[0].topics.map((t) => t.slug)).toEqual(["ai_models", "local_news"]);
  });

  it("places all digests for a given topic+date in the nested digests array", () => {
    const digests = [
      digest({ topic_slug: "ai_models", digest_date: "2026-06-10", id: "a1" }),
      digest({ topic_slug: "ai_models", digest_date: "2026-06-10", id: "a2" }),
    ];
    const groups = groupDigestsByDateAndTopic(digests, topics);
    expect(groups[0].topics[0].digests).toHaveLength(2);
  });
});
