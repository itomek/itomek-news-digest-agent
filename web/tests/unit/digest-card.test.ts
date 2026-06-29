// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderDigestCard } from "../../src/views/digest-card";
import type { Digest, DigestItem } from "../../src/lib/types";

function makeDigest(partial: Partial<Digest>): Digest {
  return {
    id: "test-id-1",
    topic_slug: "ai_models",
    content: "Fallback plain content for TTS.",
    cadence: "24h",
    digest_date: "2026-06-10",
    sources_used: [],
    token_count: 100,
    prompt_version: "sp-abc123",
    created_at: "2026-06-10T12:00:00Z",
    summary: null,
    items: null,
    ...partial,
  };
}

const sampleItems: DigestItem[] = [
  {
    headline: "AI Corp ships Model X",
    blurb: "A new frontier model. Beats previous baselines on key benchmarks.",
    detail: "Scores 95 on MMLU. The team trained for six months with new techniques.",
    metadata: {
      sources: [
        { title: "AI Blog", url: "https://example.com/blog" },
        { title: "GitHub", url: "https://github.com/org/repo" },
      ],
      tags: ["ai", "models"],
    },
  },
  {
    headline: "Open Source rival emerges",
    blurb: "A new open-source model matches commercial offerings.",
    detail: "Released under Apache 2. Fine-tuning kits ship next week.",
    metadata: {
      sources: [{ title: "HN Discussion", url: "https://news.ycombinator.com/item?id=1" }],
    },
  },
];

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Structured digest rendering
// ---------------------------------------------------------------------------

describe("renderDigestCard — structured digest (items present)", () => {
  it("renders the top-level summary", () => {
    const digest = makeDigest({ summary: "Top news today.", items: sampleItems });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const summary = card.querySelector(".digest-summary");
    expect(summary).not.toBeNull();
    expect(summary!.textContent).toContain("Top news today.");
  });

  it("renders one <details> per item", () => {
    const digest = makeDigest({ summary: "Summary.", items: sampleItems });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const details = card.querySelectorAll("details.digest-item");
    expect(details.length).toBe(sampleItems.length);
  });

  it("renders headline and blurb in the <summary> element", () => {
    const digest = makeDigest({ summary: "S.", items: sampleItems });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const firstDetails = card.querySelector("details.digest-item");
    const sumEl = firstDetails?.querySelector("summary");
    expect(sumEl?.textContent).toContain("AI Corp ships Model X");
    expect(sumEl?.textContent).toContain("Beats previous baselines");
  });

  it("renders detail text in the expanded body", () => {
    const digest = makeDigest({ summary: "S.", items: sampleItems });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const firstDetails = card.querySelector("details.digest-item");
    const detail = firstDetails?.querySelector(".item-detail");
    expect(detail?.textContent).toContain("Scores 95 on MMLU");
  });

  it("renders source links with correct href from metadata.sources", () => {
    const digest = makeDigest({ summary: "S.", items: sampleItems });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const links = card.querySelectorAll<HTMLAnchorElement>("a.source-link");
    const hrefs = Array.from(links).map((a) => a.href);
    expect(hrefs).toContain("https://example.com/blog");
    expect(hrefs).toContain("https://github.com/org/repo");
    expect(hrefs).toContain("https://news.ycombinator.com/item?id=1");
  });

  it("does not render the content-only fallback <p> when items are present", () => {
    const digest = makeDigest({ summary: "S.", items: sampleItems });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const fallback = card.querySelector("p.digest-body");
    expect(fallback).toBeNull();
  });

  // XSS guard: javascript: and data: URLs must not appear as href
  it("does not emit javascript: URLs as href (XSS guard)", () => {
    const xssItem: DigestItem = {
      headline: "Malicious",
      blurb: "Injected source.",
      detail: "Details.",
      metadata: {
        sources: [
          { title: "Evil", url: "javascript:alert('xss')" },
          { title: "Good", url: "https://safe.example.com" },
        ],
      },
    };
    const digest = makeDigest({ summary: "S.", items: [xssItem] });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const links = card.querySelectorAll<HTMLAnchorElement>("a.source-link");
    const hrefs = Array.from(links).map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => h?.startsWith("javascript:"))).toBe(false);
    // the safe link is still rendered
    expect(hrefs).toContain("https://safe.example.com");
  });

  it("does not emit data: URLs as href (XSS guard)", () => {
    const xssItem: DigestItem = {
      headline: "Data URI",
      blurb: "Data URL test.",
      detail: "Details.",
      metadata: {
        sources: [{ title: "Data", url: "data:text/html,<script>bad()</script>" }],
      },
    };
    const digest = makeDigest({ summary: "S.", items: [xssItem] });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const links = card.querySelectorAll<HTMLAnchorElement>("a.source-link");
    const hrefs = Array.from(links).map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => h?.startsWith("data:"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fallback rendering (items null/empty)
// ---------------------------------------------------------------------------

describe("renderDigestCard — content-only fallback", () => {
  it("renders <p class=digest-body> when items is null", () => {
    const digest = makeDigest({ items: null });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const body = card.querySelector("p.digest-body");
    expect(body).not.toBeNull();
    expect(body!.textContent).toContain("Fallback plain content for TTS.");
  });

  it("renders <p class=digest-body> when items is empty array", () => {
    const digest = makeDigest({ summary: "Summary.", items: [] });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const body = card.querySelector("p.digest-body");
    expect(body).not.toBeNull();
  });

  it("does not render <details> elements in fallback mode", () => {
    const digest = makeDigest({ items: null });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    expect(card.querySelectorAll("details").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #67 — Visible title on each digest item block
// ---------------------------------------------------------------------------

describe("renderDigestCard — item headline element (issue #67)", () => {
  it("renders headline text inside .item-headline", () => {
    const digest = makeDigest({ summary: "S.", items: sampleItems });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const firstDetails = card.querySelector("details.digest-item");
    const headline = firstDetails?.querySelector(".item-headline");
    expect(headline).not.toBeNull();
    expect(headline!.textContent).toBe("AI Corp ships Model X");
  });

  it("renders blurb inside .item-blurb, separate from .item-headline", () => {
    const digest = makeDigest({ summary: "S.", items: sampleItems });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const firstDetails = card.querySelector("details.digest-item");
    const headline = firstDetails?.querySelector(".item-headline");
    const blurb = firstDetails?.querySelector(".item-blurb");
    expect(headline).not.toBeNull();
    expect(blurb).not.toBeNull();
    // They must be separate DOM nodes
    expect(headline).not.toBe(blurb);
    expect(blurb!.textContent).toContain("A new frontier model");
  });

  it("headline and blurb are separate elements (not nested)", () => {
    const digest = makeDigest({ summary: "S.", items: sampleItems });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const firstSummary = card.querySelector("details.digest-item > summary");
    expect(firstSummary).not.toBeNull();
    const children = Array.from(firstSummary!.children);
    const headlineEl = children.find((el) => el.classList.contains("item-headline"));
    const blurbEl = children.find((el) => el.classList.contains("item-blurb"));
    expect(headlineEl).toBeDefined();
    expect(blurbEl).toBeDefined();
    // Blurb is NOT inside headline
    expect(headlineEl!.contains(blurbEl!)).toBe(false);
  });

  it("falls back to first sentence of blurb when headline is empty string", () => {
    const noHeadlineItem: DigestItem = {
      headline: "",
      blurb: "First sentence of blurb. Second sentence follows here.",
      detail: "Full details here.",
      metadata: { sources: [] },
    };
    const digest = makeDigest({ summary: "S.", items: [noHeadlineItem] });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const headline = card.querySelector(".item-headline");
    expect(headline).not.toBeNull();
    // Must be non-empty
    expect(headline!.textContent!.trim()).not.toBe("");
    // Should derive from blurb's first sentence
    expect(headline!.textContent).toContain("First sentence of blurb");
  });

  it("falls back to first sentence of blurb when headline is whitespace-only", () => {
    const noHeadlineItem: DigestItem = {
      headline: "   ",
      blurb: "Blurb sentence one. Blurb sentence two.",
      detail: "Detail text.",
      metadata: { sources: [] },
    };
    const digest = makeDigest({ summary: "S.", items: [noHeadlineItem] });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const headline = card.querySelector(".item-headline");
    expect(headline!.textContent!.trim()).toBe("Blurb sentence one.");
  });

  it("falls back to first sentence of detail when headline and blurb are both empty", () => {
    const noTextItem: DigestItem = {
      headline: "",
      blurb: "",
      detail: "Detail fallback sentence. More detail here.",
      metadata: { sources: [] },
    };
    const digest = makeDigest({ summary: "S.", items: [noTextItem] });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const headline = card.querySelector(".item-headline");
    expect(headline!.textContent!.trim()).toBe("Detail fallback sentence.");
  });

  it("never renders an .item-headline with empty text content", () => {
    const emptyItem: DigestItem = {
      headline: "",
      blurb: "",
      detail: "",
      metadata: { sources: [] },
    };
    const digest = makeDigest({ summary: "S.", items: [emptyItem] });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const headline = card.querySelector(".item-headline");
    // Even with all empty, headline element must not be rendered empty
    // (it may be absent or have fallback text — never empty string)
    if (headline !== null) {
      expect(headline.textContent!.trim()).not.toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #19 — per-item sentiment badge (metadata.sentiment)
// ---------------------------------------------------------------------------

describe("renderDigestCard — sentiment badge (issue #19)", () => {
  function makeSentimentItem(sentiment: unknown): DigestItem {
    return {
      headline: "World event",
      blurb: "Something happened.",
      detail: "Details about the event.",
      metadata: {
        sources: [{ title: "NYT", url: "https://nytimes.com/a" }],
        sentiment: sentiment as string,
      },
    };
  }

  it.each(["positive", "negative", "neutral", "concerning"])(
    "renders a badge for valid sentiment %s",
    (sentiment) => {
      const digest = makeDigest({ summary: "S.", items: [makeSentimentItem(sentiment)] });
      const card = renderDigestCard(digest);
      document.body.appendChild(card);
      const badge = card.querySelector(".item-sentiment");
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toBe(sentiment);
      expect(badge!.classList.contains(`item-sentiment--${sentiment}`)).toBe(true);
    },
  );

  it("renders the badge inside the item's <summary> header", () => {
    const digest = makeDigest({ summary: "S.", items: [makeSentimentItem("concerning")] });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const badge = card.querySelector("details.digest-item > summary .item-sentiment");
    expect(badge).not.toBeNull();
  });

  it.each(["", "good", "POSITIVE", "Neutral", "<script>alert(1)</script>", 42, null])(
    "does not render a badge for invalid sentiment %s",
    (bad) => {
      const digest = makeDigest({ summary: "S.", items: [makeSentimentItem(bad)] });
      const card = renderDigestCard(digest);
      document.body.appendChild(card);
      expect(card.querySelector(".item-sentiment")).toBeNull();
    },
  );

  it("does not render a badge when sentiment key is absent", () => {
    const digest = makeDigest({ summary: "S.", items: sampleItems });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    expect(card.querySelector(".item-sentiment")).toBeNull();
  });

  it("does not pick up sentiment words from the tags array", () => {
    const item: DigestItem = {
      headline: "Tagged item",
      blurb: "Blurb.",
      detail: "Detail.",
      metadata: { sources: [], tags: ["concerning", "geopolitics"] },
    };
    const digest = makeDigest({ summary: "S.", items: [item] });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    expect(card.querySelector(".item-sentiment")).toBeNull();
  });

  it("renders injected markup as inert text, never as HTML (XSS guard)", () => {
    // Even though invalid values are filtered, verify the badge path uses
    // textContent semantics by checking no script element can appear.
    const digest = makeDigest({
      summary: "S.",
      items: [makeSentimentItem("<img src=x onerror=alert(1)>")],
    });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector("script")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Issue #121 — renderItem resilience: malformed sources must not throw (AC3)
// ---------------------------------------------------------------------------

describe("renderDigestCard — malformed-source resilience (AC3)", () => {
  it("does not throw when a source entry has no url property", () => {
    const itemMissingUrl: DigestItem = {
      headline: "Article with broken source",
      blurb: "Something interesting happened.",
      detail: "Full details here.",
      metadata: {
        sources: [
          { title: "Good Source", url: "https://example.com/good" },
          // url is intentionally missing — cast to exercise the runtime path
          { title: "Broken Source" } as unknown as { title: string; url: string },
        ],
      },
    };
    const digest = makeDigest({ summary: "S.", items: [itemMissingUrl] });
    expect(() => renderDigestCard(digest)).not.toThrow();
  });

  it("still renders the <details class=digest-item> element when a source url is missing", () => {
    const itemMissingUrl: DigestItem = {
      headline: "Article with broken source",
      blurb: "Blurb text.",
      detail: "Detail text.",
      metadata: {
        sources: [{ title: "No URL" } as unknown as { title: string; url: string }],
      },
    };
    const digest = makeDigest({ summary: "S.", items: [itemMissingUrl] });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    expect(card.querySelector("details.digest-item")).not.toBeNull();
  });

  it("does not produce an <a class=source-link> anchor when source url is undefined", () => {
    const itemUndefinedUrl: DigestItem = {
      headline: "Article with undefined url source",
      blurb: "Blurb.",
      detail: "Detail.",
      metadata: {
        sources: [{ title: "No URL" } as unknown as { title: string; url: string }],
      },
    };
    const digest = makeDigest({ summary: "S.", items: [itemUndefinedUrl] });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const links = card.querySelectorAll("a.source-link");
    expect(links.length).toBe(0);
  });

  it("does not throw when a source entry is null (non-object)", () => {
    const itemNullSource: DigestItem = {
      headline: "Article with null source",
      blurb: "Blurb.",
      detail: "Detail.",
      metadata: {
        sources: [null as unknown as { title: string; url: string }],
      },
    };
    const digest = makeDigest({ summary: "S.", items: [itemNullSource] });
    expect(() => renderDigestCard(digest)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TTS playback slot preserved in both modes (issue #11 contract)
// ---------------------------------------------------------------------------

describe("renderDigestCard — playback slot preserved", () => {
  it("structured mode: .playback-slot[data-digest-id] is present", () => {
    const digest = makeDigest({ summary: "S.", items: sampleItems });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const slot = card.querySelector<HTMLElement>(".playback-slot");
    expect(slot).not.toBeNull();
    expect(slot!.getAttribute("data-digest-id")).toBe("test-id-1");
  });

  it("fallback mode: .playback-slot[data-digest-id] is present", () => {
    const digest = makeDigest({ items: null });
    const card = renderDigestCard(digest);
    document.body.appendChild(card);
    const slot = card.querySelector<HTMLElement>(".playback-slot");
    expect(slot).not.toBeNull();
    expect(slot!.getAttribute("data-digest-id")).toBe("test-id-1");
  });
});
