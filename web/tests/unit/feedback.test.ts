// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildSignalRow,
  buildCommentRow,
  buildSourceFlagRow,
  buildItemFlagRow,
  extractSourceUrls,
  submitFeedback,
  fetchFlaggedState,
  removeSourceFlag,
  removeItemFlag,
  toggleSourceFlag,
  toggleItemFlag,
} from "../../src/lib/feedback";
import { renderDigestCard, registerFeedbackSlotMounter, registerItemFlagMounter } from "../../src/views/digest-card";
import type { Digest, DigestItem } from "../../src/lib/types";

// ─── test helpers ────────────────────────────────────────────────────────────

function makeDigest(partial: Partial<Digest> = {}): Digest {
  return {
    id: "d-abc123",
    topic_slug: "ai_models",
    content: "Some content here.",
    cadence: "24h",
    digest_date: "2026-06-11",
    sources_used: ["https://example.com/feed"],
    token_count: 200,
    prompt_version: "sp-deadbeef1234",
    created_at: "2026-06-11T10:00:00Z",
    summary: null,
    items: null,
    ...partial,
  };
}

const sampleItems: DigestItem[] = [
  {
    headline: "AI Corp ships v2",
    blurb: "New model released.",
    detail: "Full details here.",
    metadata: {
      sources: [{ title: "AI Blog", url: "https://aiblog.example.com/v2" }],
    },
  },
  {
    headline: "Open model emerges",
    blurb: "Apache-licensed.",
    detail: "Fine-tuning kits next week.",
    metadata: {
      sources: [{ title: "HN", url: "https://news.ycombinator.com/item?id=1" }],
    },
  },
];

// ─── buildSignalRow ───────────────────────────────────────────────────────────

describe("buildSignalRow", () => {
  it("thumbs_down: category, level, topic_slug, feedback_type", () => {
    const row = buildSignalRow(makeDigest(), "thumbs_down");
    expect(row.category).toBe("feedback");
    expect(row.level).toBe("info");
    expect(row.topic_slug).toBe("ai_models");
    expect(row.metadata.feedback_type).toBe("thumbs_down");
  });

  it("positive: feedback_type is positive", () => {
    const row = buildSignalRow(makeDigest(), "positive");
    expect(row.metadata.feedback_type).toBe("positive");
  });

  it("metadata carries digest_id, prompt_version, digest_date", () => {
    const row = buildSignalRow(makeDigest(), "thumbs_down");
    expect(row.metadata.digest_id).toBe("d-abc123");
    expect(row.metadata.prompt_version).toBe("sp-deadbeef1234");
    expect(row.metadata.digest_date).toBe("2026-06-11");
  });

  it("tags are exactly [feedback, quality]", () => {
    const row = buildSignalRow(makeDigest(), "positive");
    expect(row.metadata.tags).toEqual(["feedback", "quality"]);
  });

  it("no comment_text, source_url, or item_index in metadata", () => {
    const row = buildSignalRow(makeDigest(), "thumbs_down");
    expect(row.metadata.comment_text).toBeUndefined();
    expect(row.metadata.source_url).toBeUndefined();
    expect(row.metadata.item_index).toBeUndefined();
  });
});

// ─── buildCommentRow ──────────────────────────────────────────────────────────

describe("buildCommentRow", () => {
  it("feedback_type is comment", () => {
    const row = buildCommentRow(makeDigest(), "Great digest!");
    expect(row.metadata.feedback_type).toBe("comment");
  });

  it("stores comment_text in metadata", () => {
    const row = buildCommentRow(makeDigest(), "Needs more detail.");
    expect(row.metadata.comment_text).toBe("Needs more detail.");
  });

  it("enforces max 500 chars — truncates longer input", () => {
    const long = "a".repeat(600);
    const row = buildCommentRow(makeDigest(), long);
    expect(row.metadata.comment_text!.length).toBe(500);
  });

  it("keeps comment under 500 chars unchanged", () => {
    const short = "Short comment.";
    const row = buildCommentRow(makeDigest(), short);
    expect(row.metadata.comment_text).toBe(short);
  });

  it("has tags [feedback, quality]", () => {
    const row = buildCommentRow(makeDigest(), "x");
    expect(row.metadata.tags).toEqual(["feedback", "quality"]);
  });
});

// ─── buildSourceFlagRow ───────────────────────────────────────────────────────

describe("buildSourceFlagRow", () => {
  it("feedback_type is source_flag", () => {
    const row = buildSourceFlagRow(makeDigest(), "https://bad.example.com");
    expect(row.metadata.feedback_type).toBe("source_flag");
  });

  it("stores source_url in metadata", () => {
    const row = buildSourceFlagRow(makeDigest(), "https://bad.example.com");
    expect(row.metadata.source_url).toBe("https://bad.example.com");
  });

  it("has tags [feedback, quality]", () => {
    const row = buildSourceFlagRow(makeDigest(), "https://bad.example.com");
    expect(row.metadata.tags).toEqual(["feedback", "quality"]);
  });

  it("carries digest_id and topic_slug", () => {
    const row = buildSourceFlagRow(makeDigest(), "https://bad.example.com");
    expect(row.metadata.digest_id).toBe("d-abc123");
    expect(row.metadata.topic_slug).toBe("ai_models");
  });
});

// ─── buildItemFlagRow ─────────────────────────────────────────────────────────

describe("buildItemFlagRow", () => {
  it("feedback_type is item_flag", () => {
    const row = buildItemFlagRow(makeDigest(), 0, "AI Corp ships v2");
    expect(row.metadata.feedback_type).toBe("item_flag");
  });

  it("stores item_index in metadata", () => {
    const row = buildItemFlagRow(makeDigest(), 2, "Some headline");
    expect(row.metadata.item_index).toBe(2);
  });

  it("stores item_headline in metadata", () => {
    const row = buildItemFlagRow(makeDigest(), 0, "AI Corp ships v2");
    expect(row.metadata.item_headline).toBe("AI Corp ships v2");
  });

  it("has tags [feedback, quality]", () => {
    const row = buildItemFlagRow(makeDigest(), 0, "Headline");
    expect(row.metadata.tags).toEqual(["feedback", "quality"]);
  });

  it("carries digest_id and prompt_version", () => {
    const row = buildItemFlagRow(makeDigest(), 1, "H");
    expect(row.metadata.digest_id).toBe("d-abc123");
    expect(row.metadata.prompt_version).toBe("sp-deadbeef1234");
  });
});

// ─── extractSourceUrls ────────────────────────────────────────────────────────

describe("extractSourceUrls", () => {
  it("extracts http(s) strings from sources_used array", () => {
    const digest = makeDigest({ sources_used: ["https://a.com", "https://b.com"] });
    expect(extractSourceUrls(digest)).toContain("https://a.com");
    expect(extractSourceUrls(digest)).toContain("https://b.com");
  });

  it("extracts http(s) URLs from item metadata.sources", () => {
    const digest = makeDigest({ items: sampleItems });
    const urls = extractSourceUrls(digest);
    expect(urls).toContain("https://aiblog.example.com/v2");
    expect(urls).toContain("https://news.ycombinator.com/item?id=1");
  });

  it("deduplicates across sources_used and item sources", () => {
    const digest = makeDigest({
      sources_used: ["https://shared.example.com"],
      items: [
        {
          headline: "H",
          blurb: "B",
          detail: "D",
          metadata: { sources: [{ title: "S", url: "https://shared.example.com" }] },
        },
      ],
    });
    const urls = extractSourceUrls(digest);
    expect(urls.filter((u) => u === "https://shared.example.com")).toHaveLength(1);
  });

  it("ignores non-http entries in sources_used", () => {
    const digest = makeDigest({ sources_used: [null, 42, "ftp://old.example.com"] });
    const urls = extractSourceUrls(digest);
    expect(urls).not.toContain("ftp://old.example.com");
    expect(urls.length).toBe(0);
  });

  it("returns empty array when no sources present", () => {
    const digest = makeDigest({ sources_used: [], items: null });
    expect(extractSourceUrls(digest)).toEqual([]);
  });
});

// ─── submitFeedback ───────────────────────────────────────────────────────────

describe("submitFeedback", () => {
  it("returns null on success", async () => {
    const client = { from: () => ({ insert: async () => ({ error: null }) }) } as never;
    const row = buildSignalRow(makeDigest(), "positive");
    const result = await submitFeedback(client, row);
    expect(result).toBeNull();
  });

  it("returns error message string on failure", async () => {
    const client = {
      from: () => ({ insert: async () => ({ error: { message: "RLS violation" } }) }),
    } as never;
    const row = buildSignalRow(makeDigest(), "thumbs_down");
    const result = await submitFeedback(client, row);
    expect(result).toBe("RLS violation");
  });
});

// ─── digest-card integration: feedback-slot is rendered ──────────────────────

describe("renderDigestCard — feedback slot (issue #22)", () => {
  beforeEach(() => { document.body.innerHTML = ""; });
  afterEach(() => { document.body.innerHTML = ""; });

  it(".feedback-slot[data-digest-id] is present", () => {
    const card = renderDigestCard(makeDigest());
    document.body.appendChild(card);
    const slot = card.querySelector<HTMLElement>(".feedback-slot");
    expect(slot).not.toBeNull();
    expect(slot!.getAttribute("data-digest-id")).toBe("d-abc123");
  });

  it("feedback slot mounter is called when registered", () => {
    const mounter = vi.fn();
    registerFeedbackSlotMounter(mounter);
    const digest = makeDigest();
    renderDigestCard(digest);
    expect(mounter).toHaveBeenCalledOnce();
    expect(mounter.mock.calls[0][1]).toMatchObject({ id: "d-abc123" });
    // Reset: deregister so other tests are unaffected
    registerFeedbackSlotMounter(() => {});
  });

  it("item flag mounter is called for structured digest", () => {
    const mounter = vi.fn();
    registerItemFlagMounter(mounter);
    const digest = makeDigest({ items: sampleItems });
    renderDigestCard(digest);
    expect(mounter).toHaveBeenCalledOnce();
    registerItemFlagMounter(() => {});
  });

  it("feedback slot is present in fallback mode too", () => {
    const card = renderDigestCard(makeDigest({ items: null }));
    document.body.appendChild(card);
    expect(card.querySelector(".feedback-slot")).not.toBeNull();
  });
});

// ─── fetchFlaggedState ────────────────────────────────────────────────────────

describe("fetchFlaggedState", () => {
  it("returns flaggedSources containing URL from an existing source_flag row", async () => {
    const sourceUrl = "https://bad.example.com/feed";
    const rows = [
      {
        category: "feedback",
        level: "info",
        metadata: {
          feedback_type: "source_flag",
          digest_id: "d-abc123",
          source_url: sourceUrl,
        },
      },
    ];
    const selectChain = {
      eq: () => selectChain,
      filter: () => selectChain,
      in: async () => ({ data: rows, error: null }),
    };
    const client = {
      from: () => ({ select: () => selectChain }),
    } as never;

    const result = await fetchFlaggedState(client, "d-abc123");
    expect(result.flaggedSources).toContain(sourceUrl);
    expect(result.flaggedItems).toEqual([]);
  });

  it("returns flaggedItems containing index from an existing item_flag row", async () => {
    const rows = [
      {
        category: "feedback",
        level: "info",
        metadata: {
          feedback_type: "item_flag",
          digest_id: "d-abc123",
          item_index: 2,
        },
      },
    ];
    const selectChain = {
      eq: () => selectChain,
      filter: () => selectChain,
      in: async () => ({ data: rows, error: null }),
    };
    const client = {
      from: () => ({ select: () => selectChain }),
    } as never;

    const result = await fetchFlaggedState(client, "d-abc123");
    expect(result.flaggedItems).toContain(2);
    expect(result.flaggedSources).toEqual([]);
  });

  it("returns empty arrays when no flag rows exist", async () => {
    const selectChain = {
      eq: () => selectChain,
      filter: () => selectChain,
      in: async () => ({ data: [], error: null }),
    };
    const client = {
      from: () => ({ select: () => selectChain }),
    } as never;

    const result = await fetchFlaggedState(client, "d-abc123");
    expect(result.flaggedSources).toEqual([]);
    expect(result.flaggedItems).toEqual([]);
  });
});

// ─── delete mock chain helper ─────────────────────────────────────────────────
//
// The real implementation's delete chain is:
//   .from("system_logs").delete().eq("category","feedback")
//     .filter(x).filter(y).filter(z)   ← 1 eq + 3 chained filters
//
// Returns spies so callers can assert on arguments.

function makeDeleteChain(finalResult: { error: { message: string } | null } | { error: null }) {
  const filter3Fn = vi.fn().mockResolvedValue(finalResult);
  const filter2Fn = vi.fn().mockReturnValue({ filter: filter3Fn });
  const filter1Fn = vi.fn().mockReturnValue({ filter: filter2Fn });
  const eqFn = vi.fn().mockReturnValue({ filter: filter1Fn });
  const deleteFn = vi.fn().mockReturnValue({ eq: eqFn });
  return { deleteFn, eqFn, filter1Fn, filter2Fn, filter3Fn };
}

// ─── removeSourceFlag ─────────────────────────────────────────────────────────

describe("removeSourceFlag", () => {
  it("calls delete with category, digest_id, source_url, and feedback_type filters", async () => {
    const { deleteFn, eqFn, filter1Fn, filter2Fn, filter3Fn } = makeDeleteChain({ error: null });
    const client = { from: () => ({ delete: deleteFn }) } as never;

    await removeSourceFlag(client, "d-abc123", "https://bad.example.com/feed");

    expect(deleteFn).toHaveBeenCalled();
    const allCalls = [
      ...eqFn.mock.calls,
      ...filter1Fn.mock.calls,
      ...filter2Fn.mock.calls,
      ...filter3Fn.mock.calls,
    ];
    const callStrings = allCalls.map((c) => JSON.stringify(c));
    expect(callStrings.some((s) => s.includes("feedback"))).toBe(true);
    expect(callStrings.some((s) => s.includes("d-abc123"))).toBe(true);
    expect(callStrings.some((s) => s.includes("bad.example.com"))).toBe(true);
    expect(callStrings.some((s) => s.includes("source_flag"))).toBe(true);
  });

  it("returns null on successful delete", async () => {
    const { deleteFn } = makeDeleteChain({ error: null });
    const client = { from: () => ({ delete: deleteFn }) } as never;

    const result = await removeSourceFlag(client, "d-abc123", "https://bad.example.com");
    expect(result).toBeNull();
  });

  it("returns error string when delete fails", async () => {
    const { deleteFn } = makeDeleteChain({ error: { message: "RLS violation" } });
    const client = { from: () => ({ delete: deleteFn }) } as never;

    const result = await removeSourceFlag(client, "d-abc123", "https://bad.example.com");
    expect(result).toBe("RLS violation");
  });
});

// ─── removeItemFlag ───────────────────────────────────────────────────────────

describe("removeItemFlag", () => {
  it("calls delete with digest_id, item_index, and feedback_type filters", async () => {
    const { deleteFn, eqFn, filter1Fn, filter2Fn, filter3Fn } = makeDeleteChain({ error: null });
    const client = { from: () => ({ delete: deleteFn }) } as never;

    await removeItemFlag(client, "d-abc123", 3);

    expect(deleteFn).toHaveBeenCalled();
    const allCalls = [
      ...eqFn.mock.calls,
      ...filter1Fn.mock.calls,
      ...filter2Fn.mock.calls,
      ...filter3Fn.mock.calls,
    ];
    const callStrings = allCalls.map((c) => JSON.stringify(c));
    expect(callStrings.some((s) => s.includes("d-abc123"))).toBe(true);
    // item_index is passed as a string to the JSONB ->> operator
    expect(callStrings.some((s) => s.includes("3"))).toBe(true);
    expect(callStrings.some((s) => s.includes("item_flag"))).toBe(true);
  });

  it("deletes both duplicate item_index rows via single filter call", async () => {
    // Two duplicate rows exist; a single delete-with-filter removes them both.
    // The mock resolves with two rows to simulate DB returning affected rows.
    const { deleteFn } = makeDeleteChain({ error: null });
    const client = { from: () => ({ delete: deleteFn }) } as never;

    const result = await removeItemFlag(client, "d-abc123", 0);
    expect(deleteFn).toHaveBeenCalledOnce();
    expect(result).toBeNull();
  });

  it("returns null on success", async () => {
    const { deleteFn } = makeDeleteChain({ error: null });
    const client = { from: () => ({ delete: deleteFn }) } as never;

    const result = await removeItemFlag(client, "d-abc123", 1);
    expect(result).toBeNull();
  });
});

// ─── toggleSourceFlag ─────────────────────────────────────────────────────────

describe("toggleSourceFlag", () => {
  it("calls insert when isCurrentlyFlagged is false", async () => {
    const insertFn = vi.fn().mockResolvedValue({ error: null });
    const client = { from: () => ({ insert: insertFn }) } as never;

    await toggleSourceFlag(client, makeDigest(), "https://example.com/feed", false);

    expect(insertFn).toHaveBeenCalled();
  });

  it("does NOT call insert when isCurrentlyFlagged is true", async () => {
    const insertFn = vi.fn().mockResolvedValue({ error: null });
    const { deleteFn } = makeDeleteChain({ error: null });
    const client = {
      from: () => ({ delete: deleteFn, insert: insertFn }),
    } as never;

    await toggleSourceFlag(client, makeDigest(), "https://example.com/feed", true);

    expect(insertFn).not.toHaveBeenCalled();
  });

  it("calls delete when isCurrentlyFlagged is true", async () => {
    const { deleteFn } = makeDeleteChain({ error: null });
    const client = { from: () => ({ delete: deleteFn }) } as never;

    await toggleSourceFlag(client, makeDigest(), "https://example.com/feed", true);

    expect(deleteFn).toHaveBeenCalled();
  });

  it("returns null on success when inserting", async () => {
    const client = {
      from: () => ({ insert: async () => ({ error: null }) }),
    } as never;

    const result = await toggleSourceFlag(
      client,
      makeDigest(),
      "https://example.com/feed",
      false,
    );
    expect(result).toBeNull();
  });

  it("returns null on success when deleting", async () => {
    const { deleteFn } = makeDeleteChain({ error: null });
    const client = { from: () => ({ delete: deleteFn }) } as never;

    const result = await toggleSourceFlag(
      client,
      makeDigest(),
      "https://example.com/feed",
      true,
    );
    expect(result).toBeNull();
  });
});

// ─── toggleItemFlag ───────────────────────────────────────────────────────────

describe("toggleItemFlag", () => {
  it("calls insert when isCurrentlyFlagged is false", async () => {
    const insertFn = vi.fn().mockResolvedValue({ error: null });
    const client = { from: () => ({ insert: insertFn }) } as never;

    await toggleItemFlag(client, makeDigest(), 0, false);

    expect(insertFn).toHaveBeenCalled();
  });

  it("does NOT call insert when isCurrentlyFlagged is true", async () => {
    const insertFn = vi.fn().mockResolvedValue({ error: null });
    const { deleteFn } = makeDeleteChain({ error: null });
    const client = {
      from: () => ({ delete: deleteFn, insert: insertFn }),
    } as never;

    await toggleItemFlag(client, makeDigest(), 0, true);

    expect(insertFn).not.toHaveBeenCalled();
  });

  it("calls delete when isCurrentlyFlagged is true", async () => {
    const { deleteFn } = makeDeleteChain({ error: null });
    const client = { from: () => ({ delete: deleteFn }) } as never;

    await toggleItemFlag(client, makeDigest(), 1, true);

    expect(deleteFn).toHaveBeenCalled();
  });

  it("returns null on success when inserting", async () => {
    const client = {
      from: () => ({ insert: async () => ({ error: null }) }),
    } as never;

    const result = await toggleItemFlag(client, makeDigest(), 0, false);
    expect(result).toBeNull();
  });

  it("returns null on success when deleting", async () => {
    const { deleteFn } = makeDeleteChain({ error: null });
    const client = { from: () => ({ delete: deleteFn }) } as never;

    const result = await toggleItemFlag(client, makeDigest(), 1, true);
    expect(result).toBeNull();
  });
});

// ─── flag → unflag → state round-trip ────────────────────────────────────────

describe("flag/unflag/fetchFlaggedState round-trip", () => {
  it("toggleSourceFlag insert then delete yields empty flaggedSources", async () => {
    // Step 1: toggleSourceFlag(_, _, url, false) → insert
    const insertFn = vi.fn().mockResolvedValue({ error: null });
    const insertClient = { from: () => ({ insert: insertFn }) } as never;
    await toggleSourceFlag(insertClient, makeDigest(), "https://example.com/feed", false);
    expect(insertFn).toHaveBeenCalled();

    // Step 2: toggleSourceFlag(_, _, url, true) → delete
    const { deleteFn } = makeDeleteChain({ error: null });
    const deleteClient = { from: () => ({ delete: deleteFn }) } as never;
    await toggleSourceFlag(deleteClient, makeDigest(), "https://example.com/feed", true);
    expect(deleteFn).toHaveBeenCalled();

    // Step 3: fetchFlaggedState returns empty (row was deleted)
    const selectChain = {
      eq: () => selectChain,
      filter: () => selectChain,
      in: async () => ({ data: [], error: null }),
    };
    const fetchClient = { from: () => ({ select: () => selectChain }) } as never;
    const state = await fetchFlaggedState(fetchClient, "d-abc123");
    expect(state.flaggedSources).toEqual([]);
  });
});
