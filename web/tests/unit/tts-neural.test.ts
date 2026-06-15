// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NeuralHttpBackend } from "../../src/lib/tts-neural";
import { createDefaultBackend, TtsPlayer, WebSpeechBackend } from "../../src/lib/tts";

// --- fakes -------------------------------------------------------------------

/** Minimal HTMLAudioElement stand-in: records calls, lets tests fire events. */
class FakeAudio {
  src = "";
  currentTime = 0;
  duration = NaN;
  paused = true;
  playCalls = 0;
  pauseCalls = 0;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;

  play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** fetch stub returning fake mp3 bytes for speech and a voice list for voices. */
function makeFetch(opts: { failSpeech?: boolean; failVoices?: boolean } = {}) {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith("/v1/audio/voices")) {
      if (opts.failVoices) throw new Error("connection refused");
      return {
        ok: true,
        json: async () => ({
          voices: [
            { id: "en-US-Chirp3-HD-Aoede", name: "Aoede" },
            { id: "en-US-Chirp3-HD-Puck", name: "Puck" },
          ],
        }),
      } as unknown as Response;
    }
    if (opts.failSpeech) throw new Error("connection refused");
    return {
      ok: true,
      blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" }),
    } as unknown as Response;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

/**
 * Build a backend with an injectable audioFactory that returns a single
 * FakeAudio.  The factory is called at most once (lazy element creation);
 * subsequent speaks just reassign .src on the same element.
 */
function makeBackend(
  fetchImpl: typeof fetch,
  singleAudio: { ref: FakeAudio | null },
  cacheCap?: number,
): NeuralHttpBackend {
  return new NeuralHttpBackend("http://tts.local:8880", {
    fetchImpl,
    audioFactory: () => {
      const a = new FakeAudio();
      singleAudio.ref = a;
      return a as unknown as HTMLAudioElement;
    },
    maxCacheEntries: cacheCap,
  });
}

/** Flush pending microtasks/timers so speak()'s fetch chain settles. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

let urlCounter = 0;

beforeEach(() => {
  localStorage.clear();
  urlCounter = 0;
  // jsdom lacks createObjectURL; the backend turns blobs into object URLs.
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => `blob:fake-${urlCounter++}`),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- speak: request contract ---------------------------------------------------

describe("NeuralHttpBackend.speak", () => {
  it("POSTs the locked OpenAI-compatible body to /v1/audio/speech", async () => {
    const { fetchImpl, calls } = makeFetch();
    const audio = { ref: null as FakeAudio | null };
    const backend = makeBackend(fetchImpl, audio);

    backend.speak("Hello world.", { rate: 1.5, voiceURI: "en-US-Chirp3-HD-Puck" }, () => {});
    await flush();

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://tts.local:8880/v1/audio/speech");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({
      model: "tts-1",
      input: "Hello world.",
      voice: "en-US-Chirp3-HD-Puck",
      response_format: "mp3",
      speed: 1.5,
    });
  });

  it("sends an empty voice when voiceURI is null so the server default applies", async () => {
    const { fetchImpl, calls } = makeFetch();
    const backend = makeBackend(fetchImpl, { ref: null });
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.voice).toBe("");
  });

  it("turns the response blob into an object URL and plays it via the single element", async () => {
    const { fetchImpl } = makeFetch();
    const audioRef = { ref: null as FakeAudio | null };
    const backend = makeBackend(fetchImpl, audioRef);
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    expect(audioRef.ref).not.toBeNull();
    expect(audioRef.ref!.src).toMatch(/^blob:fake-/);
    expect(audioRef.ref!.playCalls).toBe(1);
  });

  it("fires onEnd when the audio element ends", async () => {
    const { fetchImpl } = makeFetch();
    const audioRef = { ref: null as FakeAudio | null };
    const backend = makeBackend(fetchImpl, audioRef);
    let ended = 0;
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {
      ended += 1;
    });
    await flush();
    audioRef.ref!.onended?.();
    expect(ended).toBe(1);
  });

  it("fires onEnd (graceful, no crash) when fetch rejects", async () => {
    const { fetchImpl } = makeFetch({ failSpeech: true });
    const backend = makeBackend(fetchImpl, { ref: null });
    let ended = 0;
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {
      ended += 1;
    });
    await flush();
    expect(ended).toBe(1);
  });

  it("does not play or call onEnd when cancelled before the fetch resolves", async () => {
    const { fetchImpl } = makeFetch();
    const audioRef = { ref: null as FakeAudio | null };
    const backend = makeBackend(fetchImpl, audioRef);
    let ended = 0;
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {
      ended += 1;
    });
    backend.cancel(); // before flush — fetch still in flight
    await flush();
    // Even if element was created by unlock(), play() must not have been called.
    expect(audioRef.ref?.playCalls ?? 0).toBe(0);
    expect(ended).toBe(0);
  });
});

// --- single reused element (Fix #63) -------------------------------------------

describe("NeuralHttpBackend single reused audio element", () => {
  it("reuses the same element instance across multiple speak() calls", async () => {
    const { fetchImpl } = makeFetch();
    const audioRef = { ref: null as FakeAudio | null };
    const backend = makeBackend(fetchImpl, audioRef);

    backend.speak("Chunk one.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    const firstInstance = audioRef.ref;
    expect(firstInstance).not.toBeNull();
    // Simulate chunk end so second speak happens next in queue.
    firstInstance!.onended?.();

    backend.speak("Chunk two.", { rate: 1, voiceURI: null }, () => {});
    await flush();

    // The element instance is the same object — no new element was created.
    expect(audioRef.ref).toBe(firstInstance);
    // .src was updated to the new chunk's URL.
    expect(audioRef.ref!.src).toMatch(/^blob:fake-1/);
    // play() was called for both chunks.
    expect(audioRef.ref!.playCalls).toBe(2);
  });

  it("sets .src on the existing element rather than creating a fresh one per chunk", async () => {
    const { fetchImpl } = makeFetch();
    let factoryCalls = 0;
    const backend = new NeuralHttpBackend("http://tts.local:8880", {
      fetchImpl,
      audioFactory: () => {
        factoryCalls += 1;
        const a = new FakeAudio();
        return a as unknown as HTMLAudioElement;
      },
    });

    backend.speak("A.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    backend.speak("B.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    backend.speak("C.", { rate: 1, voiceURI: null }, () => {});
    await flush();

    // Factory called exactly once regardless of how many speak()s.
    expect(factoryCalls).toBe(1);
  });

  it("onended on the reused element advances the queue to the next chunk", async () => {
    const { fetchImpl } = makeFetch();
    const audioRef = { ref: null as FakeAudio | null };
    const backend = makeBackend(fetchImpl, audioRef);

    const endedOrder: string[] = [];
    // Simulate TtsPlayer driving two sequential chunks on the backend.
    const speakNext = () => {
      backend.speak("Chunk two.", { rate: 1, voiceURI: null }, () => {
        endedOrder.push("two");
      });
    };
    backend.speak("Chunk one.", { rate: 1, voiceURI: null }, () => {
      endedOrder.push("one");
      speakNext();
    });
    await flush();

    // Fire onended on the element — should advance queue.
    audioRef.ref!.onended?.();
    await flush();

    audioRef.ref!.onended?.();
    await flush();

    expect(endedOrder).toEqual(["one", "two"]);
  });
});

// --- unlock (Fix #63 Safari) -----------------------------------------------------

describe("NeuralHttpBackend.unlock", () => {
  it("unlock() is callable and idempotent (no throws)", () => {
    const { fetchImpl } = makeFetch();
    const audioRef = { ref: null as FakeAudio | null };
    const backend = makeBackend(fetchImpl, audioRef);
    // Must not throw and must be callable multiple times.
    expect(() => {
      backend.unlock();
      backend.unlock();
      backend.unlock();
    }).not.toThrow();
  });

  it("unlock() creates and primes the audio element (play+pause pattern)", () => {
    const { fetchImpl } = makeFetch();
    const audioRef = { ref: null as FakeAudio | null };
    const backend = makeBackend(fetchImpl, audioRef);

    backend.unlock();

    // Element must be created synchronously inside unlock.
    expect(audioRef.ref).not.toBeNull();
    // Safari unlock pattern: play() was called to prime the element.
    expect(audioRef.ref!.playCalls).toBeGreaterThanOrEqual(1);
    // Followed immediately by pause() — Safari doesn't actually play silent audio.
    expect(audioRef.ref!.pauseCalls).toBeGreaterThanOrEqual(1);
  });

  it("unlock() called twice does not create a second element", () => {
    const { fetchImpl } = makeFetch();
    let factoryCalls = 0;
    const backend = new NeuralHttpBackend("http://tts.local:8880", {
      fetchImpl,
      audioFactory: () => {
        factoryCalls += 1;
        return new FakeAudio() as unknown as HTMLAudioElement;
      },
    });
    backend.unlock();
    backend.unlock();
    expect(factoryCalls).toBe(1);
  });

  it("TtsPlayer.play() calls unlock() on the backend before speakCurrentChunk", () => {
    const { fetchImpl } = makeFetch();
    const unlockCalls: number[] = [];
    const backend = new NeuralHttpBackend("http://tts.local:8880", {
      fetchImpl,
      audioFactory: () => new FakeAudio() as unknown as HTMLAudioElement,
    });
    // Spy on unlock.
    const origUnlock = backend.unlock.bind(backend);
    backend.unlock = () => {
      unlockCalls.push(Date.now());
      origUnlock();
    };

    const player = new TtsPlayer({ backend });
    player.play([{ id: "1", text: "Hello." }]);

    // unlock must have been called (synchronously in play()).
    expect(unlockCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// --- caching -------------------------------------------------------------------

describe("NeuralHttpBackend cache", () => {
  it("serves a repeat of the same voice|rate|text from cache (no 2nd fetch)", async () => {
    const { fetchImpl, calls } = makeFetch();
    const audioRef = { ref: null as FakeAudio | null };
    const backend = makeBackend(fetchImpl, audioRef);

    backend.speak("Same text.", { rate: 1.2, voiceURI: "en-US-Chirp3-HD-Aoede" }, () => {});
    await flush();
    backend.speak("Same text.", { rate: 1.2, voiceURI: "en-US-Chirp3-HD-Aoede" }, () => {});
    await flush();

    const speechCalls = calls.filter((c) => c.url.endsWith("/v1/audio/speech"));
    expect(speechCalls.length).toBe(1);
    // Played twice on the same element.
    expect(audioRef.ref!.playCalls).toBe(2);
  });

  it("misses the cache when rate or voice differs", async () => {
    const { fetchImpl, calls } = makeFetch();
    const backend = makeBackend(fetchImpl, { ref: null });
    backend.speak("Same text.", { rate: 1.2, voiceURI: "en-US-Chirp3-HD-Aoede" }, () => {});
    await flush();
    backend.speak("Same text.", { rate: 1.5, voiceURI: "en-US-Chirp3-HD-Aoede" }, () => {});
    await flush();
    backend.speak("Same text.", { rate: 1.2, voiceURI: "en-US-Chirp3-HD-Puck" }, () => {});
    await flush();
    const speechCalls = calls.filter((c) => c.url.endsWith("/v1/audio/speech"));
    expect(speechCalls.length).toBe(3);
  });

  it("evicts the oldest entry (and revokes its URL) past the cap", async () => {
    const { fetchImpl, calls } = makeFetch();
    const backend = makeBackend(fetchImpl, { ref: null }, 2); // tiny cap for the test

    backend.speak("One.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    backend.speak("Two.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    backend.speak("Three.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    // "One." should have been evicted — speaking it again re-fetches.
    backend.speak("One.", { rate: 1, voiceURI: null }, () => {});
    await flush();

    const speechCalls = calls.filter((c) => c.url.endsWith("/v1/audio/speech"));
    expect(speechCalls.length).toBe(4);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("does NOT revoke a blob URL while it is still the element's live src", async () => {
    const { fetchImpl } = makeFetch();
    const audioRef = { ref: null as FakeAudio | null };
    // cap=1 so every new speak() evicts the previous entry
    const backend = makeBackend(fetchImpl, audioRef, 1);

    // Speak "One." — its URL goes into cache and becomes current src.
    backend.speak("One.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    const urlForOne = audioRef.ref!.src;
    expect(urlForOne).toMatch(/^blob:fake-/);

    // The eviction of "One." (which happens inside getAudioUrl for "Two.",
    // before the new src is assigned) must NOT revoke urlForOne — at that
    // instant the element is still streaming it. We assert by spying on the
    // moment of revocation: when revokeObjectURL is called for urlForOne, the
    // element's src must already have moved on (it is no longer the live src).
    const revokedWhileLive: string[] = [];
    (URL.revokeObjectURL as ReturnType<typeof vi.fn>).mockImplementation((u: string) => {
      if (u === urlForOne && audioRef.ref!.src === urlForOne) {
        revokedWhileLive.push(u);
      }
    });

    backend.speak("Two.", { rate: 1, voiceURI: null }, () => {});
    await flush();

    // urlForOne was never revoked while it was still the element's src.
    expect(revokedWhileLive).toEqual([]);
  });

  it("eventually revokes a deferred URL once the element's src moves on (no leak)", async () => {
    const { fetchImpl } = makeFetch();
    const audioRef = { ref: null as FakeAudio | null };
    const backend = makeBackend(fetchImpl, audioRef, 1);

    backend.speak("One.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    const urlForOne = audioRef.ref!.src;

    // "Two." evicts "One." (deferred, since it's live), then reassigns src and
    // revokes the now-orphaned urlForOne so it does not leak.
    backend.speak("Two.", { rate: 1, voiceURI: null }, () => {});
    await flush();

    const revoked = (URL.revokeObjectURL as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(revoked).toContain(urlForOne);
    // And the element has moved on to "Two."'s URL.
    expect(audioRef.ref!.src).not.toBe(urlForOne);
  });
});

// --- transport controls ---------------------------------------------------------

describe("NeuralHttpBackend transport", () => {
  async function playing(): Promise<{ backend: NeuralHttpBackend; audio: FakeAudio }> {
    const { fetchImpl } = makeFetch();
    const audioRef = { ref: null as FakeAudio | null };
    const backend = makeBackend(fetchImpl, audioRef);
    backend.speak("Hello.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    return { backend, audio: audioRef.ref! };
  }

  it("pause/resume drive the audio element", async () => {
    const { backend, audio } = await playing();
    backend.pause();
    expect(audio.pauseCalls).toBe(1);
    backend.resume();
    expect(audio.playCalls).toBe(2);
  });

  it("cancel pauses and detaches the current audio", async () => {
    const { backend, audio } = await playing();
    let endedAfterCancel = 0;
    audio.onended = () => {
      endedAfterCancel += 1;
    };
    backend.cancel();
    expect(audio.pauseCalls).toBe(1);
    // Handlers detached: a late ended event must not fire through.
    expect(audio.onended).toBeNull();
    expect(endedAfterCancel).toBe(0);
  });

  it("cancel keeps the element alive (does not discard it)", async () => {
    const { fetchImpl } = makeFetch();
    let factoryCalls = 0;
    const backend = new NeuralHttpBackend("http://tts.local:8880", {
      fetchImpl,
      audioFactory: () => {
        factoryCalls += 1;
        return new FakeAudio() as unknown as HTMLAudioElement;
      },
    });
    backend.speak("A.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    backend.cancel();
    backend.speak("B.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    // Factory still called only once — element reused after cancel.
    expect(factoryCalls).toBe(1);
  });

  it("seekWithinCurrent bumps currentTime and returns true within bounds", async () => {
    const { backend, audio } = await playing();
    audio.duration = 100;
    audio.currentTime = 10;
    expect(backend.seekWithinCurrent(30)).toBe(true);
    expect(audio.currentTime).toBe(40);
  });

  it("seekWithinCurrent returns false past the end so the player advances", async () => {
    const { backend, audio } = await playing();
    audio.duration = 20;
    audio.currentTime = 10;
    expect(backend.seekWithinCurrent(30)).toBe(false);
  });

  it("seekWithinCurrent returns false with no current audio", () => {
    const { fetchImpl } = makeFetch();
    const backend = makeBackend(fetchImpl, { ref: null });
    expect(backend.seekWithinCurrent(30)).toBe(false);
  });

  it("advertises real seek and small chunks for low-latency first audio", () => {
    const { fetchImpl } = makeFetch();
    const backend = makeBackend(fetchImpl, { ref: null });
    expect(backend.supportsRealSeek).toBe(true);
    // Fix #1: small chunks so first audio arrives in ~2s, not 4000 chars (~36s).
    // Measured ~9ms/char on Chirp 3 HD; ~240 chars ≈ 2.3s first audio.
    expect(backend.maxChunkChars).toBeGreaterThanOrEqual(160);
    expect(backend.maxChunkChars).toBeLessThanOrEqual(320);
  });
});

// --- listVoices ------------------------------------------------------------------

describe("NeuralHttpBackend.listVoices", () => {
  it("GETs /v1/audio/voices and maps {id, name} to {id, label}", async () => {
    const { fetchImpl, calls } = makeFetch();
    const backend = makeBackend(fetchImpl, { ref: null });
    const voices = await backend.listVoices();
    expect(calls[0].url).toBe("http://tts.local:8880/v1/audio/voices");
    expect(voices).toEqual([
      { id: "en-US-Chirp3-HD-Aoede", label: "Aoede" },
      { id: "en-US-Chirp3-HD-Puck", label: "Puck" },
    ]);
  });

  it("handles a bare string voice list defensively", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ voices: ["en-US-Chirp3-HD-Aoede", "en-US-Chirp3-HD-Puck"] }),
    })) as unknown as typeof fetch;
    const backend = new NeuralHttpBackend("http://tts.local:8880", { fetchImpl });
    const voices = await backend.listVoices();
    expect(voices).toEqual([
      { id: "en-US-Chirp3-HD-Aoede", label: "en-US-Chirp3-HD-Aoede" },
      { id: "en-US-Chirp3-HD-Puck", label: "en-US-Chirp3-HD-Puck" },
    ]);
  });

  it("rejects when the endpoint is unreachable (probe contract)", async () => {
    const { fetchImpl } = makeFetch({ failVoices: true });
    const backend = makeBackend(fetchImpl, { ref: null });
    await expect(backend.listVoices()).rejects.toThrow();
  });
});

// --- createDefaultBackend ----------------------------------------------------------

describe("createDefaultBackend", () => {
  function installSpeechStubs(): void {
    Object.defineProperty(globalThis, "speechSynthesis", {
      value: { getVoices: () => [], speak() {}, pause() {}, resume() {}, cancel() {} },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
      value: class {
        text: string;
        constructor(t: string) {
          this.text = t;
        }
      },
      configurable: true,
      writable: true,
    });
  }

  it("returns NeuralHttpBackend when a URL is set and the probe succeeds", async () => {
    installSpeechStubs();
    const { fetchImpl } = makeFetch();
    const backend = await createDefaultBackend({
      neuralUrl: "http://tts.local:8880",
      fetchImpl,
    });
    expect(backend).toBeInstanceOf(NeuralHttpBackend);
  });

  it("falls back to WebSpeechBackend when the probe fails", async () => {
    installSpeechStubs();
    const { fetchImpl } = makeFetch({ failVoices: true });
    const backend = await createDefaultBackend({
      neuralUrl: "http://tts.local:8880",
      fetchImpl,
    });
    expect(backend).toBeInstanceOf(WebSpeechBackend);
  });

  it("returns WebSpeechBackend when no URL is configured", async () => {
    installSpeechStubs();
    const backend = await createDefaultBackend({ neuralUrl: "" });
    expect(backend).toBeInstanceOf(WebSpeechBackend);
  });

  it("passes the headers provider through to the probe request", async () => {
    installSpeechStubs();
    const { fetchImpl, calls } = makeFetch();
    await createDefaultBackend({
      neuralUrl: "http://tts.local:8880",
      fetchImpl,
      headers: () => ({ Authorization: "Bearer probe-token" }),
    });
    const probe = calls.find((c) => c.url.endsWith("/v1/audio/voices"));
    expect(probe).toBeTruthy();
    expect((probe!.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer probe-token",
    );
  });
});

// --- auth headers ------------------------------------------------------------------

describe("NeuralHttpBackend headers provider", () => {
  function authedBackend(fetchImpl: typeof fetch, audioRef: { ref: FakeAudio | null }) {
    return new NeuralHttpBackend("http://tts.local:8880", {
      fetchImpl,
      audioFactory: () => {
        const a = new FakeAudio();
        audioRef.ref = a;
        return a as unknown as HTMLAudioElement;
      },
      headers: () => ({ Authorization: "Bearer test-token", apikey: "anon-key" }),
    });
  }

  it("attaches headers to the speech POST", async () => {
    const { fetchImpl, calls } = makeFetch();
    const backend = authedBackend(fetchImpl, { ref: null });
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    const speech = calls.find((c) => c.url.endsWith("/v1/audio/speech"))!;
    const headers = speech.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers.apikey).toBe("anon-key");
    // Content type is still set alongside the auth headers.
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("attaches headers to listVoices", async () => {
    const { fetchImpl, calls } = makeFetch();
    const backend = authedBackend(fetchImpl, { ref: null });
    await backend.listVoices();
    const voices = calls.find((c) => c.url.endsWith("/v1/audio/voices"))!;
    expect((voices.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
  });

  it("supports an async headers provider", async () => {
    const { fetchImpl, calls } = makeFetch();
    const backend = new NeuralHttpBackend("http://tts.local:8880", {
      fetchImpl,
      headers: async () => ({ Authorization: "Bearer async-token" }),
    });
    await backend.listVoices();
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer async-token",
    );
  });

  it("speaks fine (no headers) when the provider is omitted", async () => {
    const { fetchImpl, calls } = makeFetch();
    const audioRef = { ref: null as FakeAudio | null };
    const backend = makeBackend(fetchImpl, audioRef);
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    expect(audioRef.ref).not.toBeNull();
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("still ends gracefully when the headers provider throws", async () => {
    const { fetchImpl } = makeFetch();
    const backend = new NeuralHttpBackend("http://tts.local:8880", {
      fetchImpl,
      headers: () => {
        throw new Error("no session");
      },
    });
    let ended = 0;
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {
      ended += 1;
    });
    await flush();
    expect(ended).toBe(1);
  });
});

// --- prefetch (Fix #2) ----------------------------------------------------------------

describe("NeuralHttpBackend.prefetch", () => {
  it("warms the cache so a subsequent speak causes no new fetch", async () => {
    const { fetchImpl, calls } = makeFetch();
    const audioRef = { ref: null as FakeAudio | null };
    const backend = makeBackend(fetchImpl, audioRef);

    // prefetch the text without playing it
    await backend.prefetch("Prefetched text.", { rate: 1.2, voiceURI: "en-US-Chirp3-HD-Aoede" });

    const callsAfterPrefetch = calls.filter((c) => c.url.endsWith("/v1/audio/speech")).length;
    expect(callsAfterPrefetch).toBe(1); // one fetch to warm cache

    // speak the same text — must use cache, no new request
    backend.speak("Prefetched text.", { rate: 1.2, voiceURI: "en-US-Chirp3-HD-Aoede" }, () => {});
    await flush();

    const callsAfterSpeak = calls.filter((c) => c.url.endsWith("/v1/audio/speech")).length;
    expect(callsAfterSpeak).toBe(1); // still 1 — cache was hit
    // audio element was created and played
    expect(audioRef.ref).not.toBeNull();
    expect(audioRef.ref!.playCalls).toBe(1);
  });

  it("prefetch failure is swallowed (never rejects)", async () => {
    const { fetchImpl } = makeFetch({ failSpeech: true });
    const backend = makeBackend(fetchImpl, { ref: null });
    // Must not throw or reject
    await expect(
      backend.prefetch("Some text.", { rate: 1, voiceURI: null }),
    ).resolves.toBeUndefined();
  });

  it("prefetch does not start audio playback", async () => {
    const { fetchImpl } = makeFetch();
    const audioRef = { ref: null as FakeAudio | null };
    const backend = makeBackend(fetchImpl, audioRef);
    await backend.prefetch("No play.", { rate: 1, voiceURI: null });
    // No play() should have been called — audioFactory not invoked for prefetch,
    // or if the element was pre-created by unlock(), no play() triggered.
    expect(audioRef.ref?.playCalls ?? 0).toBe(0);
  });

  it("prefetch does not disturb current session (ongoing speak is unaffected)", async () => {
    const { fetchImpl } = makeFetch();
    const audioRef = { ref: null as FakeAudio | null };
    const backend = makeBackend(fetchImpl, audioRef);

    let ended = 0;
    backend.speak("Current chunk.", { rate: 1, voiceURI: null }, () => { ended += 1; });
    await flush();

    // prefetch a different chunk while audio is playing
    await backend.prefetch("Next chunk.", { rate: 1, voiceURI: null });

    // current audio still active; simulating end fires our onEnd
    audioRef.ref!.onended?.();
    expect(ended).toBe(1);
  });

  // Regression guard for #103: the double-buffer rewrite preloaded each next
  // chunk into a FRESH HTMLAudioElement and played on it. Browser autoplay
  // policy binds permission per-element to the one unlocked inside the user
  // gesture (see unlock()), so playing on a fresh element is blocked and
  // playback dies after the first chunk. Every chunk MUST play on the single
  // unlocked element. Do not "optimize" this back into per-chunk elements.
  it("regression #103: plays every chunk on ONE unlocked element (no per-chunk element)", async () => {
    const { fetchImpl } = makeFetch();
    let factoryCalls = 0;
    const elements: FakeAudio[] = [];
    const backend = new NeuralHttpBackend("http://tts.local:8880", {
      fetchImpl,
      audioFactory: () => {
        factoryCalls += 1;
        const a = new FakeAudio();
        elements.push(a);
        return a as unknown as HTMLAudioElement;
      },
    });
    backend.unlock(); // primes the single element inside the user gesture
    backend.speak("First chunk.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    await backend.prefetch("Second chunk.", { rate: 1, voiceURI: null });
    await flush();
    backend.speak("Second chunk.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    expect(factoryCalls).toBe(1);
    expect(elements).toHaveLength(1);
    expect(elements[0].playCalls).toBeGreaterThanOrEqual(2);
  });
});

// --- getProgress (Fix #3) ------------------------------------------------------------

describe("NeuralHttpBackend.getProgress", () => {
  it("returns null when no audio is playing", () => {
    const { fetchImpl } = makeFetch();
    const backend = makeBackend(fetchImpl, { ref: null });
    expect(backend.getProgress()).toBeNull();
  });

  it("returns null when audio duration is not finite yet (still buffering)", async () => {
    const { fetchImpl } = makeFetch();
    const audioRef = { ref: null as FakeAudio | null };
    const backend = makeBackend(fetchImpl, audioRef);
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    // duration is NaN by default in FakeAudio
    expect(backend.getProgress()).toBeNull();
  });

  it("returns { currentTime, duration } once duration is finite", async () => {
    const { fetchImpl } = makeFetch();
    const audioRef = { ref: null as FakeAudio | null };
    const backend = makeBackend(fetchImpl, audioRef);
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    audioRef.ref!.duration = 12.5;
    audioRef.ref!.currentTime = 3.0;
    const prog = backend.getProgress();
    expect(prog).toEqual({ currentTime: 3.0, duration: 12.5 });
  });

  it("returns null after cancel", async () => {
    const { fetchImpl } = makeFetch();
    const audioRef = { ref: null as FakeAudio | null };
    const backend = makeBackend(fetchImpl, audioRef);
    backend.speak("Hi.", { rate: 1, voiceURI: null }, () => {});
    await flush();
    audioRef.ref!.duration = 5;
    backend.cancel();
    expect(backend.getProgress()).toBeNull();
  });
});
