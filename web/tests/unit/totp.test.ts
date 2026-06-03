import { describe, expect, it } from "vitest";
import { base32Decode, generateTotp, hotp } from "../../src/lib/totp";

// RFC 4226 Appendix D — HOTP test vectors for the ASCII secret
// "12345678901234567890" (truncated 6-digit values for counts 0..9).
const HOTP_SECRET = new TextEncoder().encode("12345678901234567890");
const HOTP_VECTORS = [
  "755224",
  "287082",
  "359152",
  "969429",
  "338314",
  "254676",
  "287922",
  "162583",
  "399871",
  "520489",
];

describe("hotp (RFC 4226 Appendix D)", () => {
  it.each(HOTP_VECTORS.map((v, i) => [i, v] as const))(
    "counter %i -> %s",
    async (counter, expected) => {
      expect(await hotp(HOTP_SECRET, counter, 6)).toBe(expected);
    },
  );
});

describe("generateTotp (RFC 6238, SHA-1, 30s period)", () => {
  // RFC 6238 Appendix B SHA-1 vectors use the same 20-byte ASCII secret.
  // T = floor(unixSeconds / 30). The published 8-digit values are derived here
  // for the documented test times; we verify the 8-digit truncation matches.
  const cases: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  it.each(cases)("time %i -> %s", async (unixSeconds, expected) => {
    expect(await generateTotp(HOTP_SECRET, { period: 30, digits: 8, unixSeconds })).toBe(
      expected,
    );
  });

  it("decodes a base32 secret and produces a 6-digit code", async () => {
    // "12345678901234567890" base32-encoded.
    const b32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const decoded = base32Decode(b32);
    expect(decoded).toEqual(HOTP_SECRET);
    const code = await generateTotp(decoded, { period: 30, digits: 6, unixSeconds: 59 });
    expect(code).toMatch(/^\d{6}$/);
  });
});
