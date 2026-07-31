import { describe, it, expect, vi, afterEach } from "vitest";
import { hoursSince, isoAfter } from "../../src/lib/date.utils.js";

describe("hoursSince", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 0 for null input", () => {
    expect(hoursSince(null)).toBe(0);
  });

  it("returns 0 for undefined input", () => {
    expect(hoursSince(undefined)).toBe(0);
  });

  it("returns approximately 1 for a timestamp exactly 1 hour ago", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = hoursSince(oneHourAgo);
    // Allow ±0.01h tolerance for test execution time
    expect(result).toBeGreaterThanOrEqual(0.99);
    expect(result).toBeLessThanOrEqual(1.01);
  });

  it("returns approximately 24 for a timestamp 24 hours ago", () => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const result = hoursSince(oneDayAgo);
    expect(result).toBeGreaterThanOrEqual(23.99);
    expect(result).toBeLessThanOrEqual(24.01);
  });

  it("returns a small positive number for a very recent timestamp", () => {
    const fiveSecondsAgo = new Date(Date.now() - 5 * 1000).toISOString();
    const result = hoursSince(fiveSecondsAgo);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(0.01); // less than 36 seconds
  });

  it("uses fake timers correctly for deterministic results", () => {
    vi.useFakeTimers();
    const fixedNow = new Date("2024-06-15T12:00:00.000Z").getTime();
    vi.setSystemTime(fixedNow);

    const twoHoursAgo = new Date(fixedNow - 2 * 60 * 60 * 1000).toISOString();
    expect(hoursSince(twoHoursAgo)).toBe(2);
  });
});

describe("isoAfter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an ISO-8601 string", () => {
    const result = isoAfter(24);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("returns a timestamp in the past", () => {
    const result = isoAfter(1);
    expect(new Date(result).getTime()).toBeLessThan(Date.now());
  });

  it("returns exactly N hours in the past (deterministic with fake timers)", () => {
    vi.useFakeTimers();
    const fixedNow = new Date("2024-06-15T12:00:00.000Z").getTime();
    vi.setSystemTime(fixedNow);

    const result = isoAfter(6);
    const expected = new Date(fixedNow - 6 * 60 * 60 * 1000).toISOString();
    expect(result).toBe(expected);
  });

  it("result for 0 hours is approximately now", () => {
    const before = Date.now();
    const result = new Date(isoAfter(0)).getTime();
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after + 1); // 1ms tolerance
  });

  it("hoursSince(isoAfter(N)) is approximately N — round-trip", () => {
    const N = 7;
    const ts = isoAfter(N);
    const elapsed = hoursSince(ts);
    expect(elapsed).toBeGreaterThanOrEqual(N - 0.01);
    expect(elapsed).toBeLessThanOrEqual(N + 0.01);
  });
});
