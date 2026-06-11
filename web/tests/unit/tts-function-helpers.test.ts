// Pure translation helpers of the `tts` Edge Function (supabase/functions/tts).
// The serve() wiring is Deno-only; these helpers are plain TS so they get unit
// coverage here alongside the web suite.
import { describe, expect, it } from "vitest";
import {
  clampSpeed,
  friendlyLabel,
  languageCodeOf,
  pickVoices,
} from "../../../supabase/functions/tts/helpers";

describe("friendlyLabel", () => {
  it("labels a Chirp 3 HD voice", () => {
    expect(friendlyLabel("en-US-Chirp3-HD-Aoede")).toBe("Aoede (US, Chirp 3 HD)");
  });

  it("labels a Neural2 voice", () => {
    expect(friendlyLabel("en-US-Neural2-A")).toBe("A (US, Neural2)");
  });

  it("falls back to the raw name when the shape is unexpected", () => {
    expect(friendlyLabel("weird")).toBe("weird");
    expect(friendlyLabel("en-US-X")).toBe("en-US-X");
  });
});

describe("languageCodeOf", () => {
  it("takes the first two segments of the voice name", () => {
    expect(languageCodeOf("en-US-Chirp3-HD-Aoede")).toBe("en-US");
    expect(languageCodeOf("en-GB-Neural2-B")).toBe("en-GB");
  });
});

describe("clampSpeed", () => {
  it("clamps to Google's 0.25–2.0 range", () => {
    expect(clampSpeed(3)).toBe(2.0);
    expect(clampSpeed(0.1)).toBe(0.25);
    expect(clampSpeed(1.2)).toBe(1.2);
  });

  it("defaults to 1.0 for non-numeric input", () => {
    expect(clampSpeed(undefined)).toBe(1.0);
    expect(clampSpeed("fast")).toBe(1.0);
    expect(clampSpeed(NaN)).toBe(1.0);
  });
});

describe("pickVoices", () => {
  it("prefers Chirp3-HD voices", () => {
    const all = [
      { name: "en-US-Chirp3-HD-Aoede" },
      { name: "en-US-Neural2-A" },
      { name: "en-US-Standard-C" },
    ];
    expect(pickVoices(all).map((v) => v.name)).toEqual(["en-US-Chirp3-HD-Aoede"]);
  });

  it("falls back to Neural2 when no Chirp3-HD voices exist", () => {
    const all = [{ name: "en-US-Neural2-A" }, { name: "en-US-Standard-C" }];
    expect(pickVoices(all).map((v) => v.name)).toEqual(["en-US-Neural2-A"]);
  });

  it("returns empty when neither family is present", () => {
    expect(pickVoices([{ name: "en-US-Standard-C" }])).toEqual([]);
  });
});
