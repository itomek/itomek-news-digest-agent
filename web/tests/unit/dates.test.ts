import { describe, expect, it } from "vitest";
import { appToday, isToday } from "../../src/lib/dates";

describe("appToday", () => {
  it("returns a YYYY-MM-DD string", () => {
    const result = appToday();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("uses America/New_York timezone, not UTC", () => {
    // 2026-06-15 02:00:00 UTC is 2026-06-14 22:00 Eastern (UTC-4 in summer)
    // So appToday should return 2026-06-14, not 2026-06-15
    const utcMidnightPlus2h = new Date("2026-06-15T02:00:00Z");
    expect(appToday(utcMidnightPlus2h)).toBe("2026-06-14");
  });

  it("returns the UTC date for a mid-day UTC moment (same day in Eastern)", () => {
    // 2026-06-15T15:00:00Z is 2026-06-15 11:00 Eastern — same calendar day
    const midDayUtc = new Date("2026-06-15T15:00:00Z");
    expect(appToday(midDayUtc)).toBe("2026-06-15");
  });

  it("handles a winter UTC offset (EST = UTC-5)", () => {
    // 2026-01-10T03:00:00Z is 2026-01-09 22:00 EST (UTC-5)
    const winterMoment = new Date("2026-01-10T03:00:00Z");
    expect(appToday(winterMoment)).toBe("2026-01-09");
  });
});

describe("isToday", () => {
  it("returns true when digestDate matches Eastern date of given moment", () => {
    const utcMidnightPlus2h = new Date("2026-06-15T02:00:00Z");
    // Eastern date of this moment is 2026-06-14
    expect(isToday("2026-06-14", utcMidnightPlus2h)).toBe(true);
  });

  it("returns false when digestDate is a UTC date but not the Eastern date", () => {
    const utcMidnightPlus2h = new Date("2026-06-15T02:00:00Z");
    // 2026-06-15 is the UTC date, but Eastern date is 2026-06-14
    expect(isToday("2026-06-15", utcMidnightPlus2h)).toBe(false);
  });

  it("returns false for a past date", () => {
    const now = new Date("2026-06-15T15:00:00Z");
    expect(isToday("2026-06-01", now)).toBe(false);
  });

  it("returns false for a future date", () => {
    const now = new Date("2026-06-15T15:00:00Z");
    expect(isToday("2026-06-16", now)).toBe(false);
  });

  it("uses current time when no now is provided", () => {
    // Just verifies it doesn't throw and returns a boolean
    const result = isToday("2026-06-15");
    expect(typeof result).toBe("boolean");
  });
});
