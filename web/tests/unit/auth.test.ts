import { describe, expect, it } from "vitest";
import {
  hasValidSession,
  isMfaSatisfied,
  nextGateStep,
  validateEmail,
  validatePassword,
  validateTotpCode,
} from "../../src/lib/auth";

const nowSec = Math.floor(Date.now() / 1000);

describe("hasValidSession", () => {
  it("is false for a null session", () => {
    expect(hasValidSession(null)).toBe(false);
  });

  it("is false for a session missing an access token", () => {
    expect(hasValidSession({ access_token: "", expires_at: nowSec + 3600 } as never)).toBe(false);
  });

  it("is false for an expired session", () => {
    expect(
      hasValidSession({ access_token: "tok", expires_at: nowSec - 10 } as never),
    ).toBe(false);
  });

  it("is true for a live session with a token", () => {
    expect(
      hasValidSession({ access_token: "tok", expires_at: nowSec + 3600 } as never),
    ).toBe(true);
  });

  it("treats a missing expires_at as valid when a token is present", () => {
    expect(hasValidSession({ access_token: "tok" } as never)).toBe(true);
  });
});

describe("isMfaSatisfied", () => {
  it("is satisfied when the session is already at aal2", () => {
    expect(isMfaSatisfied({ currentLevel: "aal2", nextLevel: "aal2" })).toBe(true);
  });

  it("is NOT satisfied when a verified factor requires aal2 but the session is aal1", () => {
    expect(isMfaSatisfied({ currentLevel: "aal1", nextLevel: "aal2" })).toBe(false);
  });

  it("is satisfied when there is no factor to satisfy (nextLevel aal1)", () => {
    expect(isMfaSatisfied({ currentLevel: "aal1", nextLevel: "aal1" })).toBe(true);
  });

  it("is satisfied when the AAL is unknown (decode/network failure)", () => {
    expect(isMfaSatisfied({ currentLevel: null, nextLevel: null })).toBe(true);
  });
});

describe("nextGateStep", () => {
  it("asks for a password when there is no session", () => {
    expect(
      nextGateStep({ hasSession: false, hasVerifiedTotp: false, mfaSatisfied: false }),
    ).toBe("password");
  });

  it("is done when a session is present and MFA is satisfied", () => {
    expect(
      nextGateStep({ hasSession: true, hasVerifiedTotp: true, mfaSatisfied: true }),
    ).toBe("done");
  });

  it("challenges a returning user with a verified factor but an aal1 session", () => {
    expect(
      nextGateStep({ hasSession: true, hasVerifiedTotp: true, mfaSatisfied: false }),
    ).toBe("challenge");
  });

  it("enrolls a first-run user with a session but no verified factor", () => {
    expect(
      nextGateStep({ hasSession: true, hasVerifiedTotp: false, mfaSatisfied: false }),
    ).toBe("enroll");
  });
});

describe("validateEmail", () => {
  it("rejects empty input", () => {
    expect(validateEmail("")).not.toBeNull();
    expect(validateEmail("   ")).not.toBeNull();
  });

  it("rejects malformed addresses", () => {
    expect(validateEmail("nope")).not.toBeNull();
    expect(validateEmail("a@b")).not.toBeNull();
  });

  it("accepts a well-formed address", () => {
    expect(validateEmail("owner@example.com")).toBeNull();
  });
});

describe("validatePassword", () => {
  it("rejects empty input", () => {
    expect(validatePassword("")).not.toBeNull();
  });

  it("rejects short passwords", () => {
    expect(validatePassword("ab3")).not.toBeNull();
  });

  it("accepts a sufficiently long password", () => {
    expect(validatePassword("hunter2hunter2")).toBeNull();
  });
});

describe("validateTotpCode", () => {
  it("rejects non-6-digit input", () => {
    expect(validateTotpCode("")).not.toBeNull();
    expect(validateTotpCode("12345")).not.toBeNull();
    expect(validateTotpCode("1234567")).not.toBeNull();
    expect(validateTotpCode("12ab56")).not.toBeNull();
  });

  it("accepts exactly six digits (trimming surrounding whitespace)", () => {
    expect(validateTotpCode("123456")).toBeNull();
    expect(validateTotpCode(" 123456 ")).toBeNull();
  });
});
