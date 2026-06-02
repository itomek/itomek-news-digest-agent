import { describe, expect, it } from "vitest";
import { hasValidSession } from "../../src/lib/auth";

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
