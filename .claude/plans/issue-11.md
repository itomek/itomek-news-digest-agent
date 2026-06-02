---
type: plan
source-issue: 11
repo: itomek/itomek-news-digest-agent
title: "Implement Web Speech API text-to-speech for digest playback"
created: 2026-06-01
status: in-progress
work_type: code-feature
complexity: standard
tdd_required: true
suggested_team_size: 2
estimated_files_changed: 6
test_command: "ssh tomas@t-nx-radeon 'bash -lc \"cd ~/ndw-issue11 && npm run test:unit && npm run test:e2e\"'"
build_command: "ssh tomas@t-nx-radeon 'bash -lc \"cd ~/ndw-issue11 && npm run build\"'"
lint_command: "ssh tomas@t-nx-radeon 'bash -lc \"cd ~/ndw-issue11 && npm run lint\"'"
branch: feat/issue-11-tts
reflection_iterations: 1
agents_used: [planning, execution, validation]
---

# Issue #11 — Web Speech API TTS for digest playback

## #10 hooks (mapped)

- `web/src/views/digest-card.ts` exports `registerPlaybackControls(fn: MountPlaybackControls)`
  and a `MountPlaybackControls = (slotEl: HTMLElement, digest: Digest) => void` type.
  Each rendered card creates a `.playback-slot` div carrying `data-digest-id`, and invokes
  the registered mounter against that slot. This is the ONLY hook I implement against.
- `web/src/main.ts` imports pages once. The single allowed touchpoint: add one import line
  for `./components/playback` so it auto-registers on boot.
- `web/styles.css` has `.playback-slot:empty { display:none }`. I will NOT edit styles.css;
  playback.ts injects a scoped `<style id="tts-styles">` block once on first mount to stay in lane.
- Cards render newest-first grouped by topic/date (`digest-list.ts`). "Play all today" must
  enqueue digests in DOM order. The playback registry tracks every mounted digest in order;
  a play-all bar is mounted into the first card's slot region (a `.tts-playall` element).

## Design

### `web/src/lib/tts.ts` (pure-ish, unit-tested)
- `stripFormatting(text)`: remove markdown headers (`#`), bold/italic asterisks & underscores,
  list markers (`-`, `*`, `1.`), links `[text](url)` -> `text`, inline code backticks, blockquote
  `>`, stray `#`/`*`/`_`. Collapse whitespace. Pure fn — directly unit-tested.
- `chunkText(text, max=200)`: split on sentence boundaries (`.`/`!`/`?` + space) accumulating
  up to ~200 chars to dodge iOS long-utterance cutoff. Long sentences split on clause/space.
  Pure fn — unit-tested.
- `loadPrefs()/savePrefs()`: voice (URI string) + rate from localStorage keys
  `tts.voiceURI`, `tts.rate`. Default rate 1.2. Unit-tested for round-trip + defaults.
- `class TtsPlayer`: wraps `speechSynthesis`. Holds a `playlist` (array of {id, text}).
  - `play(items)`: builds queue, sets current index, speaks first chunk. First `speak()` must
    fire from the caller's user gesture (we never auto-speak).
  - chunk queue: each item is split via chunkText; `onend` advances to next chunk, then next item.
  - `pause()/resume()/stop()`: map to speechSynthesis. stop clears queue + resets index.
  - `skip(seconds=30)`: estimate words/sec from rate (~2.7 wps * rate baseline 150wpm),
    advance within current item's remaining text by that many words → re-chunk + speak.
    Unit-tested: given text + rate, skip advances the word offset by the expected count.
  - `visibilitychange` handler: on `visible` if state was "playing" and synthesis is paused
    (iOS suspends on background), call `resume()`. Registered in constructor; idempotent.
  - Events: emits state changes via a callback so UI can reflect play/pause/stop.
  - Injectable `synth` + `utteranceFactory` for tests (default to globals).

### `web/src/components/playback.ts` (DOM, e2e-tested)
- `registerPlaybackControls()` calls digest-card's `registerPlaybackControls(mountFn)`.
- `mountFn(slot, digest)`: renders per-card controls — Play, Pause, Stop, Skip 30s buttons,
  plus a voice `<select>` + rate `<input type=range>` (persist to localStorage on change).
  Tracks the digest in an ordered registry (Map keyed by id, insertion order). On the FIRST
  mount, also inserts a "Play all today" bar at the top of that slot.
- A single shared `TtsPlayer` instance drives everything. Play on a card enqueues just that
  digest; Play-all enqueues every registered digest in order.
- Injects scoped styles once.
- Auto-registers at import time (so the one main.ts import wires it).

## TDD test breakdown

### Unit (Vitest, jsdom) — `web/tests/unit/tts.test.ts`
1. stripFormatting: `**bold**`, `## Header`, `- item`, `[link](url)`, backticks, `>` → clean.
2. chunkText: long multi-sentence text → chunks each <= ~200 chars, split on sentence ends;
   no chunk empty; concatenation preserves words.
3. prefs: default rate 1.2 & null voice; save then load round-trips; rate persists as number.
4. queue advance: TtsPlayer with stubbed synth — play([2 items]); firing onend N times walks
   through all chunks/items in order; speak called once per chunk.
5. skip-30s math: pure helper `wordsForSkip(rate, seconds)` and offset advance — given rate 1.2,
   skip(30) advances ~ (150*1.2/60*30)=90 words; assert exact via helper.
- Requires adding `jsdom` devDep + `environment: "jsdom"` for the new file. Use a per-file
  `// @vitest-environment jsdom` docblock so existing node-env tests are untouched, and
  stub `globalThis.speechSynthesis` / `SpeechSynthesisUtterance` in the test.

### Integration (Playwright chromium @390x844) — `web/tests/e2e/playback.spec.ts`
- `page.addInitScript` stubs `window.speechSynthesis` + `SpeechSynthesisUtterance` to record
  speak/pause/cancel calls on `window.__tts` and auto-fire `onend` on demand.
- Seed session (reuse `./session`), goto `/`.
- Assert each `.digest-card` has playback controls (play/pause/stop/skip buttons render).
- Click Play → assert `speechSynthesis.speak` called + button state transitions to playing.
- Pause → recorded pause; Stop → recorded cancel + state reset.
- Skip-30s → speak called again (re-utter from advanced offset).
- Play-all → queue advances across >1 digest (speak called for multiple ids in order).

## Validation
- rsync to radeon ~/ndw-issue11; npm install (adds jsdom); build; test:unit; test:e2e.
- code-reviewer subagent (high-confidence >=80), fix Critical only, max 3 iterations.
- Lighthouse mobile >=90: note in handoff (orchestrator may run). No headless audio.

## Acceptance criteria mapping
- Play/pause/stop/skip-30s per digest → playback.ts per-card buttons + TtsPlayer; e2e + unit.
- Play-all queue across today's digests → ordered registry + TtsPlayer.play(all); e2e.
- Voice+rate persist in localStorage → loadPrefs/savePrefs; unit.
- iOS first speak from gesture + visibilitychange resume → no autoplay; visibilitychange
  handler; CP-3 human checkpoint for real device.
- No TTS artifacts → stripFormatting before speaking; unit.
