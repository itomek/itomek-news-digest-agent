import { describe, expect, it } from "vitest";
import { digestsQuery, topicsQuery } from "../../src/lib/query";

describe("digestsQuery", () => {
  it("selects all digest columns ordered by date desc", () => {
    const q = digestsQuery();
    expect(q.columns).toContain("topic_slug");
    expect(q.columns).toContain("content");
    expect(q.columns).toContain("digest_date");
    expect(q.order).toEqual({ column: "digest_date", ascending: false });
  });

  it("includes structured output columns summary and items", () => {
    const q = digestsQuery();
    expect(q.columns).toContain("summary");
    expect(q.columns).toContain("items");
  });

  it("honours a limit when provided", () => {
    expect(digestsQuery({ limit: 50 }).limit).toBe(50);
    expect(digestsQuery().limit).toBeUndefined();
  });
});

describe("topicsQuery", () => {
  it("selects topic columns", () => {
    const q = topicsQuery();
    expect(q.columns).toContain("slug");
    expect(q.columns).toContain("name");
  });
});
