import { expect, test, type Page } from "@playwright/test";
import { LIVE_AUTH, LIVE_AUTH_SKIP, signInAal2 } from "./live-auth";

// Playback renders over real digests read from Supabase, so it needs a genuine
// authenticated (AAL2) session — RLS gates reads to the `authenticated` role.
test.skip(!LIVE_AUTH, LIVE_AUTH_SKIP);

// Stub the Web Speech API before any app code runs. Headless chromium emits no
// audio, so we record speak/pause/cancel calls and let tests fire `onend` to
// drive the queue. Records land on window.__tts.
async function stubSpeech(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Rec {
      speaks: string[];
      pauses: number;
      resumes: number;
      cancels: number;
      utterances: any[];
    }
    const rec: Rec = { speaks: [], pauses: 0, resumes: 0, cancels: 0, utterances: [] };
    (window as any).__tts = rec;

    class FakeUtterance {
      text: string;
      rate = 1;
      voice: any = null;
      lang = "";
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onstart: (() => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    (window as any).SpeechSynthesisUtterance = FakeUtterance;

    let current: FakeUtterance | null = null;
    const synth = {
      speaking: false,
      paused: false,
      pending: false,
      speak(u: FakeUtterance) {
        rec.speaks.push(u.text);
        rec.utterances.push(u);
        current = u;
        synth.speaking = true;
        synth.paused = false;
      },
      pause() {
        rec.pauses += 1;
        synth.paused = true;
      },
      resume() {
        rec.resumes += 1;
        synth.paused = false;
      },
      cancel() {
        rec.cancels += 1;
        synth.speaking = false;
        current = null;
      },
      getVoices() {
        return [];
      },
      addEventListener() {},
      removeEventListener() {},
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });

    // Test hook: fire onend of the most-recent utterance to advance the queue.
    (window as any).__ttsFinish = () => {
      const u = current;
      current = null;
      synth.speaking = false;
      u?.onend?.();
    };
  });
}

async function gotoApp(page: Page): Promise<void> {
  await stubSpeech(page);
  await signInAal2(page);
  await page.goto("/");
  await expect(page.locator(".digest-card").first()).toBeVisible({ timeout: 15_000 });
}

test("each digest card renders playback controls", async ({ page }) => {
  await gotoApp(page);
  // Scope to the per-card control group (.tts-controls) so the first card's
  // play-all bar (which shares a Stop label) doesn't cause ambiguity.
  const controls = page.locator(".digest-card").first().locator(".tts-controls");
  await expect(controls.locator("button.tts-play")).toBeVisible();
  await expect(controls.locator("button.tts-pause")).toBeVisible();
  await expect(controls.locator("button.tts-stop")).toBeVisible();
  await expect(controls.locator("button.tts-skip")).toBeVisible();
  // Every card has its own control group.
  const cardCount = await page.locator(".digest-card").count();
  expect(await page.locator(".tts-controls").count()).toBe(cardCount);
});

test("clicking Play invokes speechSynthesis.speak and transitions UI state", async ({ page }) => {
  await gotoApp(page);
  const card = page.locator(".digest-card").first();
  const controls = card.locator(".tts-controls");
  await controls.locator("button.tts-play").click();

  const speaks = await page.evaluate(() => (window as any).__tts.speaks.length);
  expect(speaks).toBeGreaterThan(0);

  // Playing state reflected on the card.
  await expect(card).toHaveAttribute("data-tts-state", "playing");

  // Pause records a pause and flips state.
  await controls.locator("button.tts-pause").click();
  await expect(card).toHaveAttribute("data-tts-state", "paused");
  expect(await page.evaluate(() => (window as any).__tts.pauses)).toBeGreaterThan(0);

  // Stop cancels and resets.
  await controls.locator("button.tts-stop").click();
  await expect(card).toHaveAttribute("data-tts-state", "idle");
  expect(await page.evaluate(() => (window as any).__tts.cancels)).toBeGreaterThan(0);
});

test("skip-30s utters again from an advanced position", async ({ page }) => {
  await gotoApp(page);
  // Pick the card with the most body text so a 30s (~90 word) skip lands mid-item
  // rather than past the end of a short digest.
  const cardCount = await page.locator(".digest-card").count();
  let target = 0;
  let best = -1;
  for (let i = 0; i < cardCount; i++) {
    const len = (await page.locator(".digest-card").nth(i).locator(".digest-body").innerText()).length;
    if (len > best) {
      best = len;
      target = i;
    }
  }
  const controls = page.locator(".digest-card").nth(target).locator(".tts-controls");
  await controls.locator("button.tts-play").click();
  const before = await page.evaluate(() => (window as any).__tts.speaks.length);
  await controls.locator("button.tts-skip").click();
  const after = await page.evaluate(() => (window as any).__tts.speaks.length);
  expect(after).toBeGreaterThan(before);
});

test("Play all advances the queue across multiple digests", async ({ page }) => {
  await gotoApp(page);
  const cardCount = await page.locator(".digest-card").count();
  test.skip(cardCount < 2, "needs >= 2 digests to exercise the queue");

  await page.getByRole("button", { name: /play all/i }).click();
  const first = await page.evaluate(() => (window as any).__tts.speaks.length);
  expect(first).toBeGreaterThan(0);

  // Drive the queue to exhaustion; each finish should eventually trigger the
  // next item's utterance. Assert more than one item got spoken.
  for (let i = 0; i < 200; i++) {
    await page.evaluate(() => (window as any).__ttsFinish());
  }
  const total = await page.evaluate(() => (window as any).__tts.speaks.length);
  expect(total).toBeGreaterThan(first);
});

test("voice and rate persist to localStorage", async ({ page }) => {
  await gotoApp(page);
  const rate = page.locator(".digest-card").first().locator(".tts-controls input.tts-rate");
  await expect(rate).toBeVisible();
  // type=range isn't fillable; set the value and fire input/change so the
  // component's listener persists it.
  await rate.evaluate((el: HTMLInputElement) => {
    el.value = "1.5";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const stored = await page.evaluate(() => window.localStorage.getItem("tts.rate"));
  expect(Number(stored)).toBeCloseTo(1.5);
});
