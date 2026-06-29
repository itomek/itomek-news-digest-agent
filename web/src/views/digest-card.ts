import type { Digest, DigestItem } from "../lib/types";

// Renders a single digest. Includes explicit, documented mount points for
// playback and feedback controls.
//
// #11 (TTS) mounts TTS controls into the `.playback-slot` element below WITHOUT
// editing this file's core: it provides a `mountPlaybackControls` hook that this
// renderer invokes against the slot. The slot carries `data-digest-id` so #11 can
// wire per-digest playback.
//
// #22 (feedback) mounts feedback controls into the `.feedback-slot` element
// via a parallel `registerFeedbackSlotMounter` hook. Item-flag buttons are
// injected into each `.digest-item` via a `registerItemFlagMounter` hook.
//
// Rendering modes (issue #58):
//   Structured: digest.items?.length > 0  →  summary + one <details> per item
//   Fallback:   items null/empty           →  <p class="digest-body"> from content

export type MountPlaybackControls = (slotEl: HTMLElement, digest: Digest) => void;
export type MountFeedbackSlot = (slotEl: HTMLElement, digest: Digest) => void;
export type MountItemFlags = (card: HTMLElement, digest: Digest) => void;

let playbackMounter: MountPlaybackControls | null = null;
let feedbackSlotMounter: MountFeedbackSlot | null = null;
let itemFlagMounter: MountItemFlags | null = null;

/** #11 calls this once at boot to register its playback UI. */
export function registerPlaybackControls(fn: MountPlaybackControls): void {
  playbackMounter = fn;
}

/** #22 calls this once at boot to register feedback panel UI. */
export function registerFeedbackSlotMounter(fn: MountFeedbackSlot): void {
  feedbackSlotMounter = fn;
}

/** #22 calls this once at boot to register per-item flag buttons. */
export function registerItemFlagMounter(fn: MountItemFlags): void {
  itemFlagMounter = fn;
}

/**
 * Guard a URL to allow only http(s) schemes.
 *
 * Returns the URL string unchanged when it starts with http:// or https://.
 * Returns null for javascript:, data:, or any other scheme — these must never
 * appear as an href value (LLM-generated source URLs could carry injected schemes).
 *
 * Also returns null for non-string input (null/undefined) and empty strings:
 * malformed digests (e.g. garbled JSON from the heavy model) can yield a source
 * whose `url` is missing, and a bad source must never throw — issue #121. The
 * http(s) scheme allow-list above is unchanged; this only adds a type guard.
 */
export function safeHref(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url === "") {
    return null;
  }
  if (url.startsWith("https://") || url.startsWith("http://")) {
    return url;
  }
  return null;
}

function renderStructured(card: HTMLElement, digest: Digest): void {
  const items = digest.items!;

  if (digest.summary) {
    const summaryEl = document.createElement("p");
    summaryEl.className = "digest-summary";
    summaryEl.textContent = digest.summary;
    card.appendChild(summaryEl);
  }

  for (const item of items) {
    card.appendChild(renderItem(item));
  }
}

/**
 * Allowed per-item sentiment values (world_news topic, issue #19).
 * Mirrors SENTIMENT_TAGS in src/news_digest/prompts.py and the contract in
 * docs/architecture.md §7.2. Anything else in metadata.sentiment is ignored —
 * the value is LLM-generated and must be whitelisted before rendering.
 */
const SENTIMENT_VALUES = ["positive", "negative", "neutral", "concerning"] as const;

type Sentiment = (typeof SENTIMENT_VALUES)[number];

/** Validate an LLM-supplied sentiment value against the whitelist. */
function validSentiment(value: unknown): Sentiment | null {
  return SENTIMENT_VALUES.includes(value as Sentiment) ? (value as Sentiment) : null;
}

/**
 * Extract the first sentence of a string (terminated by `.`, `!`, or `?`).
 * Returns the full string trimmed if no sentence-ending punctuation is found.
 */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^.+?[.!?]/);
  return match ? match[0] : trimmed;
}

/**
 * Derive a non-empty headline for a digest item.
 * Priority: item.headline → first sentence of item.blurb → first sentence of item.detail
 * Returns null only when all three are empty/whitespace.
 */
function deriveHeadline(item: DigestItem): string | null {
  if (item.headline.trim()) return item.headline.trim();
  if (item.blurb.trim()) return firstSentence(item.blurb);
  if (item.detail.trim()) return firstSentence(item.detail);
  return null;
}

function renderItem(item: DigestItem): HTMLElement {
  const details = document.createElement("details");
  details.className = "digest-item";

  const summaryEl = document.createElement("summary");
  // Headline and blurb go in the collapsed header.
  const headlineSpan = document.createElement("span");
  headlineSpan.className = "item-headline";
  const headlineText = deriveHeadline(item);
  if (headlineText !== null) {
    headlineSpan.textContent = headlineText;
    summaryEl.appendChild(headlineSpan);
  }

  // Sentiment badge (issue #19) — only whitelisted values are rendered;
  // textContent assignment keeps any unexpected payload inert.
  const sentiment = validSentiment(item.metadata?.sentiment);
  if (sentiment !== null) {
    const badge = document.createElement("span");
    badge.className = `item-sentiment item-sentiment--${sentiment}`;
    badge.textContent = sentiment;
    summaryEl.appendChild(badge);
  }

  if (item.blurb) {
    const blurbSpan = document.createElement("span");
    blurbSpan.className = "item-blurb";
    blurbSpan.textContent = item.blurb;
    summaryEl.appendChild(blurbSpan);
  }
  details.appendChild(summaryEl);

  // Expanded body: detail prose.
  if (item.detail) {
    const detailEl = document.createElement("p");
    detailEl.className = "item-detail";
    detailEl.textContent = item.detail;
    details.appendChild(detailEl);
  }

  // Source links — only http(s) URLs are emitted as anchors.
  // Malformed digests (issue #121) can yield a source that is not a well-formed
  // { url, title } object: a non-object entry, or a missing/non-string url.
  // Such entries are skipped rather than throwing — one bad source must never
  // blank the item (or the whole list above it).
  const sources = Array.isArray(item.metadata?.sources) ? item.metadata.sources : [];
  if (sources.length > 0) {
    const sourcesList = document.createElement("ul");
    sourcesList.className = "item-sources";
    for (const src of sources) {
      if (src === null || typeof src !== "object") {
        continue; // non-object source entry — nothing to render
      }
      const href = safeHref(src.url);
      const title = typeof src.title === "string" ? src.title : null;
      const li = document.createElement("li");
      if (href !== null) {
        const a = document.createElement("a");
        a.className = "source-link";
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = title ?? href;
        li.appendChild(a);
      } else if (title !== null) {
        // Non-http(s) URL but a usable title: render as plain text to avoid
        // dropping the source name. A url-less/title-less entry is skipped.
        li.textContent = title;
      } else {
        continue; // no usable href and no title — skip entirely
      }
      sourcesList.appendChild(li);
    }
    details.appendChild(sourcesList);
  }

  return details;
}

function renderFallback(card: HTMLElement, digest: Digest): void {
  const body = document.createElement("p");
  body.className = "digest-body";
  body.textContent = digest.content;
  card.appendChild(body);
}

export function renderDigestCard(digest: Digest): HTMLElement {
  const card = document.createElement("article");
  card.className = "digest-card";
  card.setAttribute("data-digest-id", digest.id);

  // #11 mounts TTS controls into .playback-slot — always present regardless of
  // rendering mode. TTS reads digest.content (flat prose), never the structured fields.
  const playbackSlot = document.createElement("div");
  playbackSlot.className = "playback-slot";
  playbackSlot.setAttribute("data-digest-id", digest.id);
  card.appendChild(playbackSlot);

  const hasStructuredItems = (digest.items?.length ?? 0) > 0;
  if (hasStructuredItems) {
    renderStructured(card, digest);
  } else {
    renderFallback(card, digest);
  }

  // #22 mounts per-item flag buttons into each .digest-item after rendering.
  if (itemFlagMounter) {
    itemFlagMounter(card, digest);
  }

  // #22 mounts the feedback panel into .feedback-slot.
  const feedbackSlot = document.createElement("div");
  feedbackSlot.className = "feedback-slot";
  feedbackSlot.setAttribute("data-digest-id", digest.id);
  card.appendChild(feedbackSlot);

  if (playbackMounter) {
    playbackMounter(playbackSlot, digest);
  }

  if (feedbackSlotMounter) {
    feedbackSlotMounter(feedbackSlot, digest);
  }

  return card;
}
