// RFC 4226 (HOTP) + RFC 6238 (TOTP), SHA-1, via WebCrypto. Used only by the MFA
// integration test to compute a code from the secret Supabase returns at enrollment —
// it is NOT part of the app's runtime login path. Kept dependency-free (no otplib).

/** Decode an RFC 4648 base32 string (A-Z, 2-7, optional `=` padding) to bytes. */
export function base32Decode(input: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function counterToBytes(counter: number): Uint8Array {
  const buf = new Uint8Array(8);
  let n = counter;
  for (let i = 7; i >= 0; i--) {
    buf[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return buf;
}

/** HMAC-SHA1-based HOTP (RFC 4226), returning a zero-padded `digits`-length code. */
export async function hotp(
  secret: Uint8Array,
  counter: number,
  digits = 6,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, counterToBytes(counter) as unknown as ArrayBuffer),
  );
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  const code = binary % 10 ** digits;
  return code.toString().padStart(digits, "0");
}

export interface TotpOptions {
  /** Step size in seconds (authenticator default: 30). */
  period?: number;
  /** Code length (authenticator default: 6). */
  digits?: number;
  /** Override the clock for deterministic tests; defaults to now. */
  unixSeconds?: number;
}

/** TOTP (RFC 6238): time-stepped HOTP. */
export async function generateTotp(
  secret: Uint8Array,
  opts: TotpOptions = {},
): Promise<string> {
  const period = opts.period ?? 30;
  const digits = opts.digits ?? 6;
  const now = opts.unixSeconds ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(now / period);
  return hotp(secret, counter, digits);
}
