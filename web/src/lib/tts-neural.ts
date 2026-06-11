// Neural HTTP TtsBackend for digest playback (#63).
//
// Talks to the `tts` Supabase Edge Function (a proxy over Google Cloud TTS,
// see supabase/functions/tts/) through an OpenAI-style speech API:
//   POST /v1/audio/speech  { model, input, voice, response_format, speed } -> mp3 bytes
//   GET  /v1/audio/voices  -> { voices: [{ id, name }] }
//
// Responsibilities:
//   - Synthesize one chunk per request, play via a SINGLE long-lived
//     HTMLAudioElement (src is swapped per chunk — never a new element).
//   - Attach caller-provided headers (Supabase JWT) to every request — the
//     function is deployed with JWT verification on.
//   - In-memory cache keyed `${voice}|${rate}|hash(text)` -> object URL so a
//     replay within the session skips the round-trip (soft cap, evict oldest).
//   - Real seek within the current chunk via `currentTime`.
//   - A speak() superseded by cancel() must never start playing late (session
//     token guards the async fetch).
//   - Fetch/decoding failure -> call onEnd so the player advances instead of
//     wedging; never throw out of speak().
//   - unlock() primes the element inside the user gesture (Safari autoplay fix).

import type { TtsBackend, TtsVoice } from "./tts";

const MAX_CACHE_ENTRIES = 64;
// Google Chirp 3 HD synthesis costs ~9 ms/char, so first-audio latency is set
// by the FIRST chunk's size: ~240 chars measures ~2.3s (vs ~6.6s at 700, ~36s
// at 4000). Each chunk's audio runs ~3x longer than its own synth time, so the
// player's prefetch (Fix #2) keeps every later chunk ready with no gap; only
// the first chunk is unavoidably synchronous. ~240 chars is also 1–3 whole
// sentences, so per-chunk prosody stays natural.
const NEURAL_MAX_CHUNK_CHARS = 240;

// Minimal silent MP3 (44 bytes): used to prime the audio element in unlock()
// without triggering audible output.  The howler.js-style Safari unlock pattern
// requires a real play() call on the element inside the gesture; a data-URI of
// a tiny silent clip avoids a network round-trip.
const SILENT_MP3_DATA_URI =
  "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//tQxAADwAABpAAAACAAADSAAAAETEFNRTMuOTkuNVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";

export type HeadersProvider = () =>
  | Record<string, string>
  | Promise<Record<string, string>>;

export interface NeuralHttpBackendOptions {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Injectable for tests; called at most once to create the single long-lived
   * HTMLAudioElement.  Subsequent speaks reassign .src on the same element.
   * Defaults to `new Audio()`.
   */
  audioFactory?: () => HTMLAudioElement;
  /** Cache size cap; defaults to 64. */
  maxCacheEntries?: number;
  /** Extra request headers (auth) applied to every voices/speech request. */
  headers?: HeadersProvider;
}

/** Tiny non-cryptographic string hash (djb2) for cache keys. */
function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

export class NeuralHttpBackend implements TtsBackend {
  readonly supportsRealSeek = true;
  readonly maxChunkChars = NEURAL_MAX_CHUNK_CHARS;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly audioFactory: () => HTMLAudioElement;
  private readonly maxCacheEntries: number;
  private readonly headers?: HeadersProvider;

  // key -> object URL. Map preserves insertion order, so the first key is the
  // oldest entry when we need to evict.
  private readonly cache = new Map<string, string>();
  // The single long-lived audio element, created lazily on first use.
  private audioEl: HTMLAudioElement | null = null;
  // The object URL actually assigned to audioEl.src right now. Tracked so cache
  // eviction never revokes a URL the element is still streaming. Survives
  // cancel() (the src stays loaded until the next speak() overwrites it).
  private elementSrc: string | null = null;
  // True while a (non-cancelled) chunk is the current track — drives
  // getProgress()/seekWithinCurrent(), which must report nothing after cancel().
  private hasCurrentTrack = false;
  // True once unlock() has run, so we don't re-prime on repeated calls.
  private unlocked = false;
  // Monotonic token: cancel() bumps it, so an in-flight speak() whose token no
  // longer matches must not start playback or report an end.
  private session = 0;

  constructor(baseUrl: string, opts: NeuralHttpBackendOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.audioFactory =
      opts.audioFactory ??
      (() =>
        new (globalThis as unknown as { Audio: new () => HTMLAudioElement }).Audio());
    this.maxCacheEntries = opts.maxCacheEntries ?? MAX_CACHE_ENTRIES;
    this.headers = opts.headers;
  }

  /**
   * Prime the single audio element inside a user gesture so Safari grants
   * autoplay permission for all future chunk plays on the same element.
   * Call this synchronously at the top of any user-gesture handler (e.g.
   * TtsPlayer.play()) BEFORE any awaits.  Idempotent — safe to call multiple
   * times; the unlock only happens once.
   */
  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    const audio = this.getOrCreateElement();
    // howler.js-style Safari unlock: assign a silent clip and play+pause
    // immediately inside the gesture.  This registers the element's origin
    // with Safari's autoplay policy so later play() calls (outside the
    // gesture, after an async fetch) are permitted on the SAME element.
    audio.src = SILENT_MP3_DATA_URI;
    try {
      const p = audio.play();
      // Swallow a rejected play() promise (autoplay refusal pre-gesture, jsdom
      // with no media stack) so unlock never throws into the click handler.
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      // ignore — element still registered with Safari's policy.
    }
    // Pause synchronously, inside the same gesture, so no audible blip plays.
    try {
      audio.pause();
    } catch {
      // ignore
    }
  }

  speak(
    text: string,
    opts: { rate: number; voiceURI: string | null },
    onEnd: () => void,
  ): void {
    this.cancel();
    const session = this.session;
    // Empty voice -> the proxy applies its server-side default.
    const voice = opts.voiceURI ?? "";

    void this.getAudioUrl(text, voice, opts.rate)
      .then((url) => {
        if (session !== this.session) return; // superseded while fetching
        const audio = this.getOrCreateElement();
        // Detach any handlers from a previous chunk before reassigning.
        audio.onended = null;
        audio.onerror = null;
        // Swap the SAME element's source to this chunk. elementSrc records the
        // URL the element is now streaming so eviction never revokes it.
        this.elementSrc = url;
        this.hasCurrentTrack = true;
        audio.src = url;
        const finish = (): void => {
          if (session !== this.session) return;
          this.hasCurrentTrack = false;
          onEnd();
        };
        audio.onended = finish;
        audio.onerror = finish;
        const p = audio.play();
        // play() returns a promise in browsers; a rejection (autoplay policy,
        // decode failure) must advance the queue, not wedge it.
        if (p && typeof p.catch === "function") {
          p.catch(() => {
            if (session !== this.session) return;
            this.hasCurrentTrack = false;
            onEnd();
          });
        }
      })
      .catch(() => {
        // Synthesis failed (network/server). Report the end so the player
        // moves on; it will go idle if every chunk fails.
        if (session !== this.session) return;
        onEnd();
      });
  }

  pause(): void {
    try {
      this.audioEl?.pause();
    } catch {
      // ignore
    }
  }

  resume(): void {
    const p = this.audioEl?.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }

  cancel(): void {
    this.session += 1;
    const audio = this.audioEl;
    // Stop reporting progress/seek for this track, but keep the element alive
    // for reuse and keep elementSrc set — the src stays loaded until the next
    // speak() overwrites it, so we must not let eviction revoke it meanwhile.
    this.hasCurrentTrack = false;
    if (!audio) return;
    audio.onended = null;
    audio.onerror = null;
    try {
      audio.pause();
    } catch {
      // ignore
    }
  }

  /**
   * Seek within the playing chunk by bumping `currentTime`.
   * Returns false (caller should advance) when there is no current audio or
   * the target is at/past the end of the chunk.
   */
  seekWithinCurrent(seconds: number): boolean {
    const audio = this.audioEl;
    if (!audio || !this.hasCurrentTrack) return false;
    const target = audio.currentTime + seconds;
    if (Number.isFinite(audio.duration) && target >= audio.duration) return false;
    audio.currentTime = Math.max(0, target);
    return true;
  }

  async listVoices(): Promise<TtsVoice[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/audio/voices`, {
      headers: await this.resolveHeaders(),
    });
    if (!res.ok) throw new Error(`voices endpoint returned ${res.status}`);
    const data = (await res.json()) as { voices?: unknown[] };
    const voices = Array.isArray(data.voices) ? data.voices : [];
    return voices.map((v) => {
      // Locked contract is [{id, name}]; tolerate bare string ids too.
      if (typeof v === "string") return { id: v, label: v };
      const o = v as { id: string; name?: string };
      return { id: o.id, label: o.name ?? o.id };
    });
  }

  /**
   * Warm the cache for `text` without playing it. Call this while the current
   * chunk is playing so the next chunk is ready when its turn arrives.
   * All failures are swallowed — a cache miss is the only side-effect.
   */
  prefetch(text: string, opts: { rate: number; voiceURI: string | null }): Promise<void> {
    const voice = opts.voiceURI ?? "";
    return this.getAudioUrl(text, voice, opts.rate).then(
      () => { /* cached; no playback */ },
      () => { /* silently ignore fetch errors */ },
    );
  }

  /**
   * Return the current audio element's playback position.
   * Returns null when no audio is loaded or duration is not yet finite
   * (still buffering), so callers can tell the difference between "no audio"
   * and "audio is playing but metadata not ready yet".
   */
  getProgress(): { currentTime: number; duration: number } | null {
    const audio = this.audioEl;
    if (!audio || !this.hasCurrentTrack || !Number.isFinite(audio.duration)) return null;
    return { currentTime: audio.currentTime, duration: audio.duration };
  }

  // --- internals ------------------------------------------------------------

  /** Lazily create and return the single reused audio element. */
  private getOrCreateElement(): HTMLAudioElement {
    if (!this.audioEl) {
      this.audioEl = this.audioFactory();
    }
    return this.audioEl;
  }

  private async resolveHeaders(): Promise<Record<string, string>> {
    if (!this.headers) return {};
    return await this.headers();
  }

  private async getAudioUrl(text: string, voice: string, rate: number): Promise<string> {
    const key = `${voice}|${rate}|${hashText(text)}`;
    const cached = this.cache.get(key);
    if (cached) {
      // Refresh recency so hot entries survive eviction.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const res = await this.fetchImpl(`${this.baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: { ...(await this.resolveHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "tts-1",
        input: text,
        voice,
        response_format: "mp3",
        speed: rate,
      }),
    });
    if (!res.ok) throw new Error(`speech endpoint returned ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);

    this.cache.set(key, url);
    if (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value as string;
      const evicted = this.cache.get(oldest);
      this.cache.delete(oldest);
      // Never revoke a URL that is currently set as the element's src — the
      // browser may still be streaming it.  Defer: it will be overwritten the
      // next time speak() runs, at which point it is safe to drop.
      if (evicted && evicted !== this.elementSrc) {
        URL.revokeObjectURL(evicted);
      }
    }
    return url;
  }
}
