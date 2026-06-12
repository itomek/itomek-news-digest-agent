// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildSignalRow,
  buildCommentRow,
  buildSourceFlagRow,
  buildItemFlagRow,
  extractSourceUrls,
  submitFeedback,
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
