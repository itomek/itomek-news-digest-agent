// Neural HTTP TtsBackend for digest playback (#63).
//
// Talks to the `tts` Supabase Edge Function (a proxy over Google Cloud TTS,
// see supabase/functions/tts/) through an OpenAI-style speech API:
//   POST /v1/audio/speech  { model, input, voice, response_format, speed } -> mp3 bytes
//   GET  /v1/audio/voices  -> { voices: [{ id, name }] }
//
// Responsibilities:
//   - Synthesize one chunk per request, play via a FIXED POOL of two
//     pre-unlocked HTMLAudioElements (ping-pong double-buffer).  The pool is
//     built and both elements are primed in unlock() (inside the user gesture)
//     so BOTH carry autoplay permission.  prefetch() pre-loads the next chunk
//     onto the spare; speak() promotes the spare to active (gapless fast-path)
//     or falls back to fetching on the active element.
//   - Attach caller-provided headers (Supabase JWT) to every request — the
//     function is deployed with JWT verification on.
//   - In-memory cache keyed `${voice}|${rate}|hash(text)` -> object URL so a
//     replay within the session skips the round-trip (soft cap, evict oldest).
//   - Real seek within the current chunk via `currentTime`.
//   - A speak() superseded by cancel() must never start playing late (session
//     token guards the async fetch).
//   - Fetch/decoding failure -> call onEnd so the player advances instead of
//     wedging; never throw out of speak().
//   - unlock() builds the pool and primes both elements inside the user gesture
//     (Safari/Chrome per-element autoplay fix).

import type { TtsBackend, TtsVoice } from "./tts";

const MAX_CACHE_ENTRIES = 64;
// Google Chirp 3 HD synthesis costs ~9 ms/char, so first-audio latency is set
// by the FIRST chunk's size: ~240 chars measures ~2.3s (vs ~6.6s at 700, ~36s
// at 4000). Each chunk's audio runs ~3x longer than its own synth time, so the
// player's prefetch (Fix #2) keeps every later chunk ready with no gap; only
// the first chunk is unavoidably synchronous. ~240 chars is also 1–3 whole
// sentences, so per-chunk prosody stays natural.
const NEURAL_MAX_CHUNK_CHARS = 240;

// Minimal silent MP3 (44 bytes): used to prime both pool elements in unlock()
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
   * Injectable for tests; called exactly twice during unlock() to build the
   * pool of two pre-unlocked HTMLAudioElements (ping-pong double-buffer).
   * In the degraded path (speak() without prior unlock()), called once lazily
   * to create pool[0] only.  Defaults to `new Audio()`.
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

/** Preload slot: identifies which chunk the spare pool element has buffered. */
interface PreloadSlot {
  key: string;
  url: string;
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

  // Fixed pool of exactly 2 pre-unlocked elements, built in unlock().
  // pool[activeIndex] is the element we play on; pool[1-activeIndex] is the spare.
  // Lazily grown: if speak() is called before unlock(), we create pool[0] only
  // (degraded path — no gapless, but no crash).
  private pool: HTMLAudioElement[] = [];
  private activeIndex = 0;

  // The object URL assigned to each pool element's .src right now. Tracked so
  // cache eviction never revokes a URL either element is still streaming.
  // Index-aligned with pool[].
  private poolSrc: (string | null)[] = [null, null];

  // Pending preload: the chunk buffered onto the spare element, ready for the
  // gapless fast-path swap in speak().  Cleared by cancel().
  private preloadSlot: PreloadSlot | null = null;

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
   * Build the 2-element pool and prime BOTH elements inside a user gesture so
   * Safari/Chrome grant autoplay permission to each.  Call this synchronously
   * at the top of any user-gesture handler (e.g. TtsPlayer.play()) BEFORE any
   * awaits.  Idempotent — safe to call multiple times; the pool is built once.
   *
   * Browser autoplay policy binds permission per-element to the element(s)
   * play()'d inside the gesture.  Both pool elements must be primed here so
   * the ping-pong swap can play on either without being blocked.
   */
  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    // Build both pool elements synchronously and prime each with the silent
    // clip so both carry autoplay permission for all future play() calls.
    for (let i = 0; i < 2; i++) {
      const audio = this.audioFactory();
      this.pool.push(audio);
      audio.src = SILENT_MP3_DATA_URI;
      try {
        const p = audio.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {
        // ignore — element still registered with Safari's policy.
      }
      try {
        audio.pause();
      } catch {
        // ignore
      }
    }
    // Reset poolSrc to track only the 2 pool elements.
    this.poolSrc = [null, null];
  }

  speak(
    text: string,
    opts: { rate: number; voiceURI: string | null },
    onEnd: () => void,
  ): void {
    // Capture pending preload BEFORE cancel() clears it.
    const pendingSlot = this.preloadSlot;
    this.cancel();
    const session = this.session;
    const voice = opts.voiceURI ?? "";
    const key = `${voice}|${opts.rate}|${hashText(text)}`;

    // --- Gapless fast-path: spare element already has this chunk buffered. ---
    if (pendingSlot && pendingSlot.key === key && this.pool.length >= 2) {
      // Promote the spare to active (ping-pong swap).
      this.activeIndex = 1 - this.activeIndex;
      const audio = this.pool[this.activeIndex]!;
      const url = pendingSlot.url;

      // Wire handlers on the now-active element.
      audio.onended = null;
      audio.onerror = null;
      const previousSrc = this.poolSrc[this.activeIndex] ?? null;
      this.poolSrc[this.activeIndex] = url;
      this.hasCurrentTrack = true;

      // Deferred revocation of the old URL this pool slot had (if evicted).
      if (previousSrc && previousSrc !== url && !this.cacheHasUrl(previousSrc)) {
        URL.revokeObjectURL(previousSrc);
      }

      const finish = (): void => {
        if (session !== this.session) return;
        this.hasCurrentTrack = false;
        onEnd();
      };
      audio.onended = finish;
      audio.onerror = finish;
      const p = audio.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          if (session !== this.session) return;
          this.hasCurrentTrack = false;
          onEnd();
        });
      }
      return;
    }

    // --- Fallback path: fetch (or cache-hit) then play on the active element. ---
    void this.getAudioUrl(text, voice, opts.rate)
      .then((url) => {
        if (session !== this.session) return; // superseded while fetching
        const audio = this.getOrCreateActive();
        audio.onended = null;
        audio.onerror = null;
        const previousSrc = this.poolSrc[this.activeIndex] ?? null;
        this.poolSrc[this.activeIndex] = url;
        this.hasCurrentTrack = true;
        audio.src = url;
        if (previousSrc && previousSrc !== url && !this.cacheHasUrl(previousSrc)) {
          URL.revokeObjectURL(previousSrc);
        }
        const finish = (): void => {
          if (session !== this.session) return;
          this.hasCurrentTrack = false;
          onEnd();
        };
        audio.onended = finish;
        audio.onerror = finish;
        const p = audio.play();
        if (p && typeof p.catch === "function") {
          p.catch(() => {
            if (session !== this.session) return;
            this.hasCurrentTrack = false;
            onEnd();
          });
        }
      })
      .catch(() => {
        if (session !== this.session) return;
        onEnd();
      });
  }

  pause(): void {
    try {
      this.pool[this.activeIndex]?.pause();
    } catch {
      // ignore
    }
  }

  resume(): void {
    const p = this.pool[this.activeIndex]?.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }

  cancel(): void {
    this.session += 1;
    this.preloadSlot = null;
    this.hasCurrentTrack = false;
    const audio = this.pool[this.activeIndex];
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
    const audio = this.pool[this.activeIndex];
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
      if (typeof v === "string") return { id: v, label: v };
      const o = v as { id: string; name?: string };
      return { id: o.id, label: o.name ?? o.id };
    });
  }

  /**
   * Pre-load the next chunk onto the SPARE pool element so speak() can do a
   * gapless swap.  If the pool hasn't been built yet (unlock() not called),
   * falls back to cache-warming only (no element buffering).
   * All failures are swallowed — a cache miss is the only side-effect.
   */
  prefetch(text: string, opts: { rate: number; voiceURI: string | null }): Promise<void> {
    const voice = opts.voiceURI ?? "";
    const key = `${voice}|${opts.rate}|${hashText(text)}`;

    // Short-circuit: spare is already loaded with this exact chunk.
    if (this.preloadSlot?.key === key) return Promise.resolve();

    return this.getAudioUrl(text, voice, opts.rate).then(
      (url) => {
        // If the pool is available, buffer the URL onto the spare element.
        if (this.pool.length >= 2) {
          const spareIndex = 1 - this.activeIndex;
          const spare = this.pool[spareIndex]!;
          const previousSrc = this.poolSrc[spareIndex] ?? null;
          // Set src to buffer the audio (no play() — just preload).
          spare.src = url;
          this.poolSrc[spareIndex] = url;
          // Deferred revocation for any URL the spare previously held.
          if (previousSrc && previousSrc !== url && !this.cacheHasUrl(previousSrc)
              && !this.poolSrcInUse(previousSrc)) {
            URL.revokeObjectURL(previousSrc);
          }
        }
        // Record the preload slot regardless (cache-warmed or element-buffered).
        this.preloadSlot = { key, url };
      },
      () => { /* silently swallow fetch errors */ },
    );
  }

  /**
   * Return the current audio element's playback position.
   * Returns null when no audio is loaded or duration is not yet finite
   * (still buffering), so callers can tell the difference between "no audio"
   * and "audio is playing but metadata not ready yet".
   */
  getProgress(): { currentTime: number; duration: number } | null {
    const audio = this.pool[this.activeIndex];
    if (!audio || !this.hasCurrentTrack || !Number.isFinite(audio.duration)) return null;
    return { currentTime: audio.currentTime, duration: audio.duration };
  }

  // --- internals ------------------------------------------------------------

  /**
   * Return the active pool element, lazily creating pool[0] if speak() was
   * called before unlock() (degraded path — no gapless, no crash).
   */
  private getOrCreateActive(): HTMLAudioElement {
    if (this.pool.length === 0) {
      const audio = this.audioFactory();
      this.pool.push(audio);
      this.poolSrc = [null];
    }
    return this.pool[this.activeIndex]!;
  }

  /** True when `url` is still held by the cache (so it must not be revoked). */
  private cacheHasUrl(url: string): boolean {
    for (const v of this.cache.values()) {
      if (v === url) return true;
    }
    return false;
  }

  /** True when `url` is currently the .src of ANY pool element. */
  private poolSrcInUse(url: string): boolean {
    return this.poolSrc.some((s) => s === url);
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
      // Never revoke a URL that is currently buffered in any pool element —
      // the browser may still be streaming or have it loaded.  Defer: it will
      // be overwritten the next time that element's src is reassigned, at which
      // point it is safe to drop.
      if (evicted && !this.poolSrcInUse(evicted)) {
        URL.revokeObjectURL(evicted);
      }
    }
    return url;
  }
}
