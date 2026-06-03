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
      nextGateStep({ hasSession: false, currentLevel: null, hasVerifiedTotp: false, mfaSatisfied: false }),
    ).toBe("password");
  });

  it("enrolls a real first-login account (aal1, no factor, mfaSatisfied=true)", () => {
    // This is the bug-catching case: a fresh account has no factor so isMfaSatisfied returns
    // true (nextLevel=aal1), but the user still needs to enroll. The old 3-field signature
    // could never reach this state in production.
    expect(
      nextGateStep({ hasSession: true, currentLevel: "aal1", hasVerifiedTotp: false, mfaSatisfied: true }),
    ).toBe("enroll");
  });

  it("challenges a returning user with a verified factor but an aal1 session", () => {
    expect(
      nextGateStep({ hasSession: true, currentLevel: "aal1", hasVerifiedTotp: true, mfaSatisfied: false }),
    ).toBe("challenge");
  });

  it("is done when fully stepped up to aal2", () => {
    expect(
      nextGateStep({ hasSession: true, currentLevel: "aal2", hasVerifiedTotp: true, mfaSatisfied: true }),
    ).toBe("done");
  });

  it("is done for a seeded/undecodable session (currentLevel null, no factor)", () => {
    // The seeded e2e access_token is a publishable key, not a JWT — decode throws and
    // getAalState returns null. These sessions should pass through without forcing enrollment.
    expect(
      nextGateStep({ hasSession: true, currentLevel: null, hasVerifiedTotp: false, mfaSatisfied: true }),
    ).toBe("done");
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
