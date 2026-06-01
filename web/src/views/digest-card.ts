import type { Digest } from "../lib/types";

// Renders a single digest. Includes an explicit, documented mount point for
// playback controls.
//
// #11 (TTS) mounts TTS controls into the `.playback-slot` element below WITHOUT
// editing this file's core: it provides a `mountPlaybackControls` hook that this
// renderer invokes against the slot. The slot carries `data-digest-id` so #11 can
// wire per-digest playback.

export type MountPlaybackControls = (slotEl: HTMLElement, digest: Digest) => void;

let playbackMounter: MountPlaybackControls | null = null;

/** #11 calls this once at boot to register its playback UI. */
export function registerPlaybackControls(fn: MountPlaybackControls): void {
  playbackMounter = fn;
}

export function renderDigestCard(digest: Digest): HTMLElement {
  const card = document.createElement("article");
  card.className = "digest-card";
  card.setAttribute("data-digest-id", digest.id);

  // #11 mounts TTS controls into .playback-slot
  const slot = document.createElement("div");
  slot.className = "playback-slot";
  slot.setAttribute("data-digest-id", digest.id);
  card.appendChild(slot);

  const body = document.createElement("p");
  body.className = "digest-body";
  body.textContent = digest.content;
  card.appendChild(body);

  if (playbackMounter) {
    playbackMounter(slot, digest);
  }

  return card;
}
