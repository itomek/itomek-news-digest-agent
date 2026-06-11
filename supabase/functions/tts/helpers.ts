// Pure translation helpers for the `tts` Edge Function. No Deno APIs here so
// the web unit suite (vitest) can import and test them directly.

export interface GoogleVoice {
  name: string;
  languageCodes?: string[];
  ssmlGender?: string;
}

// Google speakingRate accepts 0.25–2.0; clamp so out-of-range player rates never 400.
const MIN_SPEED = 0.25;
const MAX_SPEED = 2.0;

/**
 * "en-US-Chirp3-HD-Aoede" -> "Aoede (US, Chirp 3 HD)";
 * "en-US-Neural2-A" -> "A (US, Neural2)". Falls back to the raw name.
 */
export function friendlyLabel(name: string): string {
  const parts = name.split("-");
  if (parts.length < 4) return name;
  const region = parts[1];
  const speaker = parts[parts.length - 1];
  const family = parts
    .slice(2, -1)
    .join(" ")
    .replace("Chirp3", "Chirp 3");
  return `${speaker} (${region}, ${family})`;
}

/** "en-US-Chirp3-HD-Aoede" -> "en-US". */
export function languageCodeOf(voiceName: string): string {
  return voiceName.split("-").slice(0, 2).join("-");
}

export function clampSpeed(speed: unknown): number {
  const n = Number(speed);
  if (!Number.isFinite(n)) return 1.0;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, n));
}

/** Prefer Chirp 3 HD voices; fall back to Neural2 when none are returned. */
export function pickVoices(all: GoogleVoice[]): GoogleVoice[] {
  const chirp = all.filter((v) => v.name.includes("Chirp3-HD"));
  if (chirp.length > 0) return chirp;
  return all.filter((v) => v.name.includes("Neural2"));
}
