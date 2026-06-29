// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
// safeHref will be exported after the fix; import fails until then (tests are intentionally red)
import { safeHref } from "../../src/views/digest-card";

// ---------------------------------------------------------------------------
// AC1: null / undefined / empty inputs → null
// ---------------------------------------------------------------------------

describe("safeHref — null and nullish inputs (AC1)", () => {
  it("returns null for undefined", () => {
    expect(safeHref(undefined)).toBeNull();
  });

  it("returns null for null", () => {
    expect(safeHref(null)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(safeHref("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC2: scheme allow-list — XSS-dangerous schemes → null; http/https → URL
// ---------------------------------------------------------------------------

describe("safeHref — scheme allow-list (AC2)", () => {
  it("returns null for javascript: scheme (XSS guard)", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
  });

  it("returns null for data: scheme (XSS guard)", () => {
    expect(safeHref("data:text/html,<h1>hi</h1>")).toBeNull();
  });

  it("returns the URL unchanged for https scheme", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
  });

  it("returns the URL unchanged for http scheme", () => {
    expect(safeHref("http://example.com")).toBe("http://example.com");
  });
});
