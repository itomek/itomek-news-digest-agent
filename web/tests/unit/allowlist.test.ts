import { describe, expect, it } from "vitest";
import { isEmailAllowed, normalizeEmail } from "../../src/lib/allowlist";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Foo@Example.COM ")).toBe("foo@example.com");
  });
});

describe("isEmailAllowed", () => {
  const list = ["owner@example.com", "Second@Example.com"];

  it("accepts an exact allowlisted email", () => {
    expect(isEmailAllowed("owner@example.com", list)).toBe(true);
  });

  it("is case-insensitive and trims whitespace on both sides", () => {
    expect(isEmailAllowed("  OWNER@EXAMPLE.COM ", list)).toBe(true);
    expect(isEmailAllowed("second@example.com", list)).toBe(true);
  });

  it("rejects a non-allowlisted email", () => {
    expect(isEmailAllowed("intruder@evil.com", list)).toBe(false);
  });

  it("rejects empty / blank input", () => {
    expect(isEmailAllowed("", list)).toBe(false);
    expect(isEmailAllowed("   ", list)).toBe(false);
  });

  it("rejects everything when the allowlist is empty", () => {
    expect(isEmailAllowed("owner@example.com", [])).toBe(false);
  });
});
