import type { Digest, DigestItem } from "../lib/types";

// Renders a single digest. Includes an explicit, documented mount point for
// playback controls.
//
// #11 (TTS) mounts TTS controls into the `.playback-slot` element below WITHOUT
// editing this file's core: it provides a `mountPlaybackControls` hook that this
// renderer invokes against the slot. The slot carries `data-digest-id` so #11 can
// wire per-digest playback.
//
// Rendering modes (issue #58):
//   Structured: digest.items?.length > 0  →  summary + one <details> per item
//   Fallback:   items null/empty           →  <p class="digest-body"> from content

export type MountPlaybackControls = (slotEl: HTMLElement, digest: Digest) => void;

let playbackMounter: MountPlaybackControls | null = null;

/** #11 calls this once at boot to register its playback UI. */
export function registerPlaybackControls(fn: MountPlaybackControls): void {
  playbackMounter = fn;
}

/**
 * Guard a URL to allow only http(s) schemes.
 *
 * Returns the URL string unchanged when it starts with http:// or https://.
 * Returns null for javascript:, data:, or any other scheme — these must never
 * appear as an href value (LLM-generated source URLs could carry injected schemes).
 */
function safeHref(url: string): string | null {
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
  const sources = item.metadata?.sources ?? [];
  if (sources.length > 0) {
    const sourcesList = document.createElement("ul");
    sourcesList.className = "item-sources";
    for (const src of sources) {
      const href = safeHref(src.url);
      const li = document.createElement("li");
      if (href !== null) {
        const a = document.createElement("a");
        a.className = "source-link";
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = src.title;
        li.appendChild(a);
      } else {
        // Non-http(s) URL: render as plain text to avoid dropping the source name.
        li.textContent = src.title;
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
  const slot = document.createElement("div");
  slot.className = "playback-slot";
  slot.setAttribute("data-digest-id", digest.id);
  card.appendChild(slot);

  const hasStructuredItems = (digest.items?.length ?? 0) > 0;
  if (hasStructuredItems) {
    renderStructured(card, digest);
  } else {
    renderFallback(card, digest);
  }

  if (playbackMounter) {
    playbackMounter(slot, digest);
  }

  return card;
}
