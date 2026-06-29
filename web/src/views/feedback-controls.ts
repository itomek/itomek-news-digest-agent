// Feedback controls — mounts per-digest feedback UI into a .feedback-slot element.
//
// Provides:
//   - Thumbs-down button (negative signal)
//   - "This was great" button (positive signal)
//   - Free-text comment textarea (max 500 chars) + submit
//   - Per-source flag dropdown (sources from the digest)
//   - Per-item flag button on each .digest-item (structured mode only)
//
// All writes go via lib/feedback.ts → system_logs(category='feedback').
// XSS safety: all user-supplied values are set via textContent / .value; no
// innerHTML with untrusted data.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Digest } from "../lib/types";
import {
  buildCommentRow,
  buildSignalRow,
  extractSourceUrls,
  fetchFlaggedState,
  submitFeedback,
  toggleItemFlag,
  toggleSourceFlag,
} from "../lib/feedback";

// ─── status helper ──────────────────────────────────────────────────────────

function showStatus(el: HTMLElement, text: string, isError = false): void {
  el.textContent = text;
  el.className = isError ? "feedback-status feedback-status--error" : "feedback-status";
}

// ─── per-item flag button ───────────────────────────────────────────────────

/**
 * Append a toggle flag button to each .digest-item <details> element inside
 * the card. Reflects persisted flag state on mount, and re-enables the button
 * after each flag/unflag action so it can be toggled again.
 * Called once after the card is rendered.
 */
export function mountItemFlagButtons(
  card: HTMLElement,
  digest: Digest,
  client: SupabaseClient,
): void {
  const items = card.querySelectorAll<HTMLElement>("details.digest-item");

  void (async () => {
    // Fetch current flag state once for all items on this card.
    const { flaggedItems } = await fetchFlaggedState(client, digest.id);

    items.forEach((detailsEl, index) => {
      const headlineEl = detailsEl.querySelector(".item-headline");
      const headline = headlineEl?.textContent?.trim() ?? "";

      let isFlagged = flaggedItems.includes(index);

      const flagBtn = document.createElement("button");
      flagBtn.type = "button";
      flagBtn.className = "item-flag-btn";
      flagBtn.setAttribute("data-item-index", String(index));

      const itemStatus = document.createElement("span");
      itemStatus.className = "feedback-status";
      itemStatus.setAttribute("role", "status");
      itemStatus.setAttribute("aria-live", "polite");

      function applyFlagState(flagged: boolean): void {
        isFlagged = flagged;
        flagBtn.textContent = flagged ? "Flagged ✓" : "Flag item";
        flagBtn.setAttribute("aria-pressed", String(flagged));
        flagBtn.setAttribute(
          "aria-label",
          flagged
            ? `Unflag item: ${headline || `item ${index + 1}`}`
            : `Flag item: ${headline || `item ${index + 1}`}`,
        );
      }

      applyFlagState(isFlagged);

      flagBtn.addEventListener("click", () => {
        flagBtn.disabled = true;
        showStatus(itemStatus, isFlagged ? "Unflagging…" : "Flagging…");
        void (async () => {
          const wasFlag = isFlagged;
          const err = await toggleItemFlag(client, digest, index, isFlagged, headline);
          flagBtn.disabled = false;
          if (err) {
            showStatus(itemStatus, `Could not ${wasFlag ? "unflag" : "flag"}: ${err}`, true);
          } else {
            applyFlagState(!wasFlag);
            showStatus(itemStatus, wasFlag ? "Unflagged." : "Flagged.");
          }
        })();
      });

      const wrapper = document.createElement("div");
      wrapper.className = "item-flag-row";
      wrapper.appendChild(flagBtn);
      wrapper.appendChild(itemStatus);

      detailsEl.appendChild(wrapper);
    });
  })();
}

// ─── digest-level feedback panel ───────────────────────────────────────────

/** Build and wire up the full feedback panel for a digest. */
export function mountFeedbackControls(
  slotEl: HTMLElement,
  digest: Digest,
  client: SupabaseClient,
): void {
  const panel = document.createElement("div");
  panel.className = "feedback-panel";
  panel.setAttribute("data-digest-id", digest.id);

  const statusEl = document.createElement("p");
  statusEl.className = "feedback-status";
  statusEl.setAttribute("role", "status");
  statusEl.setAttribute("aria-live", "polite");

  // ── Signal row: thumbs-down + positive ─────────────────────────────────
  const signalRow = document.createElement("div");
  signalRow.className = "feedback-signal-row";

  const thumbsBtn = document.createElement("button");
  thumbsBtn.type = "button";
  thumbsBtn.className = "feedback-btn feedback-btn--thumbs-down";
  thumbsBtn.setAttribute("aria-label", "Thumbs down — this digest was not useful");
  thumbsBtn.textContent = "👎 Not useful";

  const positiveBtn = document.createElement("button");
  positiveBtn.type = "button";
  positiveBtn.className = "feedback-btn feedback-btn--positive";
  positiveBtn.setAttribute("aria-label", "This was great");
  positiveBtn.textContent = "👍 This was great";

  function onSignal(type: "thumbs_down" | "positive", btn: HTMLButtonElement): void {
    btn.disabled = true;
    showStatus(statusEl, "Saving…");
    void (async () => {
      const row = buildSignalRow(digest, type);
      const err = await submitFeedback(client, row);
      btn.disabled = false;
      if (err) {
        showStatus(statusEl, `Could not save: ${err}`, true);
      } else {
        btn.textContent = type === "thumbs_down" ? "👎 Noted" : "👍 Thanks!";
        btn.disabled = true;
        showStatus(statusEl, "Feedback saved.");
      }
    })();
  }

  thumbsBtn.addEventListener("click", () => onSignal("thumbs_down", thumbsBtn));
  positiveBtn.addEventListener("click", () => onSignal("positive", positiveBtn));

  signalRow.appendChild(thumbsBtn);
  signalRow.appendChild(positiveBtn);

  // ── Comment section ─────────────────────────────────────────────────────
  const commentDetails = document.createElement("details");
  commentDetails.className = "feedback-comment-section";

  const commentSummary = document.createElement("summary");
  commentSummary.className = "feedback-comment-toggle";
  commentSummary.textContent = "Add a comment";
  commentDetails.appendChild(commentSummary);

  const textarea = document.createElement("textarea");
  textarea.className = "feedback-textarea";
  textarea.setAttribute("aria-label", "Comment on this digest (max 500 characters)");
  textarea.setAttribute("maxlength", "500");
  textarea.placeholder = "What could be better? (max 500 chars)";
  textarea.rows = 3;

  const charCount = document.createElement("span");
  charCount.className = "feedback-char-count";
  charCount.setAttribute("aria-live", "polite");
  charCount.textContent = "0 / 500";

  textarea.addEventListener("input", () => {
    const len = textarea.value.length;
    charCount.textContent = `${len} / 500`;
  });

  const commentSubmit = document.createElement("button");
  commentSubmit.type = "button";
  commentSubmit.className = "feedback-btn feedback-btn--comment-submit";
  commentSubmit.textContent = "Submit comment";

  const commentStatus = document.createElement("p");
  commentStatus.className = "feedback-status";
  commentStatus.setAttribute("role", "status");
  commentStatus.setAttribute("aria-live", "polite");

  commentSubmit.addEventListener("click", () => {
    const text = textarea.value.trim();
    if (!text) {
      showStatus(commentStatus, "Please enter a comment.", true);
      return;
    }
    commentSubmit.disabled = true;
    showStatus(commentStatus, "Saving…");
    void (async () => {
      const row = buildCommentRow(digest, text);
      const err = await submitFeedback(client, row);
      commentSubmit.disabled = false;
      if (err) {
        showStatus(commentStatus, `Could not save: ${err}`, true);
      } else {
        textarea.value = "";
        charCount.textContent = "0 / 500";
        showStatus(commentStatus, "Comment saved. Thank you.");
        commentDetails.open = false;
      }
    })();
  });

  commentDetails.appendChild(textarea);
  commentDetails.appendChild(charCount);
  commentDetails.appendChild(commentSubmit);
  commentDetails.appendChild(commentStatus);

  // ── Source flag section ─────────────────────────────────────────────────
  const sourceUrls = extractSourceUrls(digest);
  if (sourceUrls.length > 0) {
    const sourceDetails = document.createElement("details");
    sourceDetails.className = "feedback-source-section";

    const sourceSummary = document.createElement("summary");
    sourceSummary.className = "feedback-comment-toggle";
    sourceSummary.textContent = "Flag a source";
    sourceDetails.appendChild(sourceSummary);

    const sourceRow = document.createElement("div");
    sourceRow.className = "feedback-source-row";

    const select = document.createElement("select");
    select.className = "feedback-source-select";
    select.setAttribute("aria-label", "Select a source to flag");

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose a source…";
    select.appendChild(placeholder);

    for (const url of sourceUrls) {
      const option = document.createElement("option");
      // value and label are set via .value / .textContent (XSS-safe)
      option.value = url;
      option.textContent = url;
      select.appendChild(option);
    }

    const sourceFlagBtn = document.createElement("button");
    sourceFlagBtn.type = "button";
    sourceFlagBtn.className = "feedback-btn feedback-btn--source-flag";
    sourceFlagBtn.textContent = "Flag source";

    const sourceStatus = document.createElement("p");
    sourceStatus.className = "feedback-status";
    sourceStatus.setAttribute("role", "status");
    sourceStatus.setAttribute("aria-live", "polite");

    // Track which sources are currently flagged; populated after mount.
    const flaggedSourceSet = new Set<string>();

    function updateSourceFlagBtn(url: string): void {
      const flagged = url !== "" && flaggedSourceSet.has(url);
      sourceFlagBtn.textContent = flagged ? "Unflag source" : "Flag source";
      sourceFlagBtn.setAttribute("aria-pressed", String(flagged));
    }

    // Keep button label in sync as the user changes the dropdown.
    select.addEventListener("change", () => updateSourceFlagBtn(select.value));

    sourceFlagBtn.addEventListener("click", () => {
      const url = select.value;
      if (!url) {
        showStatus(sourceStatus, "Please select a source.", true);
        return;
      }
      const isFlagged = flaggedSourceSet.has(url);
      sourceFlagBtn.disabled = true;
      showStatus(sourceStatus, isFlagged ? "Unflagging…" : "Flagging…");
      void (async () => {
        const err = await toggleSourceFlag(client, digest, url, isFlagged);
        sourceFlagBtn.disabled = false;
        if (err) {
          showStatus(sourceStatus, `Could not ${isFlagged ? "unflag" : "flag"}: ${err}`, true);
        } else {
          if (isFlagged) {
            flaggedSourceSet.delete(url);
            showStatus(sourceStatus, "Source unflagged.");
          } else {
            flaggedSourceSet.add(url);
            showStatus(sourceStatus, "Source flagged. Thank you.");
          }
          updateSourceFlagBtn(url);
        }
      })();
    });

    // Populate initial flag state asynchronously.
    void fetchFlaggedState(client, digest.id).then(({ flaggedSources }) => {
      for (const src of flaggedSources) flaggedSourceSet.add(src);
      updateSourceFlagBtn(select.value);
    });

    sourceRow.appendChild(select);
    sourceRow.appendChild(sourceFlagBtn);
    sourceDetails.appendChild(sourceRow);
    sourceDetails.appendChild(sourceStatus);

    panel.appendChild(signalRow);
    panel.appendChild(statusEl);
    panel.appendChild(commentDetails);
    panel.appendChild(sourceDetails);
  } else {
    panel.appendChild(signalRow);
    panel.appendChild(statusEl);
    panel.appendChild(commentDetails);
  }

  slotEl.appendChild(panel);
}
