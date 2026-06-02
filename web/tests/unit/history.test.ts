import { describe, expect, it } from "vitest";
import {
  digestMeta,
  filterDigests,
  generateFixtureDigests,
  parseHistoryState,
  searchDigests,
  serializeHistoryState,
  withinLastDays,
  wordCount,
} from "../../src/pages/history";
import type { Digest, Topic } from "../../src/lib/types";

function digest(
  partial: Partial<Digest> & { topic_slug: string; digest_date: string },
): Digest {
  return {
    id: `${partial.topic_slug}-${partial.digest_date}`,
    content: "hello world",
    cadence: "24h",
    sources_used: [],
    token_count: null,
    prompt_version: "v",
    created_at: `${partial.digest_date}T00:00:00Z`,
    ...partial,
  };
}

const topics: Topic[] = [
  { id: 1, name: "AI model releases", slug: "ai_models", cadence: "24h", enabled: true },
  { id: 2, name: "Local news", slug: "local_news", cadence: "7d", enabled: true },
];

describe("parseHistoryState / serializeHistoryState", () => {
  it("parses topic, date and q from a search string", () => {
    const state = parseHistoryState("?topic=ai_models&date=2026-04-10&q=gemini");
    expect(state).toEqual({ topic: "ai_models", date: "2026-04-10", q: "gemini" });
  });

  it("returns nulls/empty when params are absent", () => {
    expect(parseHistoryState("")).toEqual({ topic: null, date: null, q: "" });
    expect(parseHistoryState("?")).toEqual({ topic: null, date: null, q: "" });
  });

  it("round-trips through serialize -> parse", () => {
    const state = { topic: "local_news", date: "2026-05-01", q: "township" };
    const search = serializeHistoryState(state);
    expect(parseHistoryState(search)).toEqual(state);
  });

  it("serializes an empty state to an empty search string", () => {
    expect(serializeHistoryState({ topic: null, date: null, q: "" })).toBe("");
  });

  it("omits empty fields when serializing", () => {
    const search = serializeHistoryState({ topic: "ai_models", date: null, q: "" });
    expect(search).toBe("?topic=ai_models");
  });
});

describe("filterDigests", () => {
  const digests = [
    digest({ topic_slug: "ai_models", digest_date: "2026-06-01", content: "Gemini ships" }),
    digest({ topic_slug: "ai_models", digest_date: "2026-05-30", content: "Llama update" }),
    digest({ topic_slug: "local_news", digest_date: "2026-06-01", content: "Township vote" }),
  ];

  it("narrows by topic", () => {
    const out = filterDigests(digests, { topic: "ai_models", date: null, q: "" });
    expect(out.map((d) => d.topic_slug)).toEqual(["ai_models", "ai_models"]);
  });

  it("narrows by date", () => {
    const out = filterDigests(digests, { topic: null, date: "2026-06-01", q: "" });
    expect(out.map((d) => d.digest_date)).toEqual(["2026-06-01", "2026-06-01"]);
  });

  it("narrows by topic AND date together", () => {
    const out = filterDigests(digests, { topic: "ai_models", date: "2026-06-01", q: "" });
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("Gemini ships");
  });

  it("applies the search query as part of filtering", () => {
    const out = filterDigests(digests, { topic: null, date: null, q: "township" });
    expect(out).toHaveLength(1);
    expect(out[0].topic_slug).toBe("local_news");
  });

  it("returns everything for an empty state", () => {
    expect(filterDigests(digests, { topic: null, date: null, q: "" })).toHaveLength(3);
  });
});

describe("searchDigests", () => {
  const digests = [
    digest({ topic_slug: "ai_models", digest_date: "2026-05-30", content: "model model model" }),
    digest({ topic_slug: "ai_models", digest_date: "2026-06-01", content: "one model here" }),
    digest({ topic_slug: "local_news", digest_date: "2026-06-02", content: "nothing relevant" }),
  ];

  it("returns all digests unchanged for an empty query", () => {
    expect(searchDigests(digests, "")).toEqual(digests);
    expect(searchDigests(digests, "   ")).toEqual(digests);
  });

  it("is case-insensitive", () => {
    const out = searchDigests(digests, "MODEL");
    expect(out).toHaveLength(2);
  });

  it("ranks higher match counts first, breaking ties by date desc", () => {
    const out = searchDigests(digests, "model");
    // three matches beats one match
    expect(out[0].content).toBe("model model model");
    expect(out[1].content).toBe("one model here");
  });

  it("returns an empty array when nothing matches", () => {
    expect(searchDigests(digests, "zzzz")).toEqual([]);
  });
});

describe("wordCount", () => {
  it("counts whitespace-delimited words", () => {
    expect(wordCount("one two three")).toBe(3);
    expect(wordCount("  padded   words  ")).toBe(2);
    expect(wordCount("")).toBe(0);
    expect(wordCount("   ")).toBe(0);
  });
});

describe("digestMeta", () => {
  it("derives date, topic name, sources array and word count", () => {
    const d = digest({
      topic_slug: "ai_models",
      digest_date: "2026-06-01",
      content: "alpha beta gamma delta",
      sources_used: ["TechCrunch", "The Verge"],
    });
    const meta = digestMeta(d, topics);
    expect(meta.date).toBe("2026-06-01");
    expect(meta.topicName).toBe("AI model releases");
    expect(meta.sources).toEqual(["TechCrunch", "The Verge"]);
    expect(meta.words).toBe(4);
  });

  it("falls back to the slug when no topic metadata matches", () => {
    const meta = digestMeta(digest({ topic_slug: "mystery", digest_date: "2026-06-01" }), []);
    expect(meta.topicName).toBe("mystery");
  });

  it("coerces a non-array sources_used to an empty list", () => {
    const meta = digestMeta(
      digest({ topic_slug: "ai_models", digest_date: "2026-06-01", sources_used: null }),
      topics,
    );
    expect(meta.sources).toEqual([]);
  });
});

describe("withinLastDays", () => {
  it("keeps only digests whose date is within N days of the newest digest", () => {
    const digests = [
      digest({ topic_slug: "ai_models", digest_date: "2026-06-10" }),
      digest({ topic_slug: "ai_models", digest_date: "2026-06-04" }),
      digest({ topic_slug: "ai_models", digest_date: "2026-06-03" }),
      digest({ topic_slug: "ai_models", digest_date: "2026-05-01" }),
    ];
    // window anchored on newest (2026-06-10), last 7 days => >= 2026-06-04
    const out = withinLastDays(digests, 7);
    expect(out.map((d) => d.digest_date)).toEqual(["2026-06-10", "2026-06-04"]);
  });

  it("returns an empty array unchanged", () => {
    expect(withinLastDays([], 7)).toEqual([]);
  });
});

describe("generateFixtureDigests", () => {
  it("produces a deterministic 150-row dataset (5 topics x 30 days)", () => {
    const a = generateFixtureDigests(150);
    const b = generateFixtureDigests(150);
    expect(a).toHaveLength(150);
    expect(a).toEqual(b); // deterministic
    const slugs = new Set(a.map((d) => d.topic_slug));
    expect(slugs.size).toBe(5);
    const dates = new Set(a.map((d) => d.digest_date));
    expect(dates.size).toBe(30);
    // every row has searchable content and a sources array
    expect(a.every((d) => d.content.length > 0 && Array.isArray(d.sources_used))).toBe(true);
  });
});
