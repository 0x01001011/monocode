import { describe, expect, it } from "vitest";
import { formatDuration } from "./duration";

describe("formatDuration", () => {
  it("shows seconds while running under a minute", () => {
    expect(formatDuration(48_000, true)).toBe("48s");
  });

  it("shows minutes and seconds while running under 10 minutes", () => {
    expect(formatDuration(134_000, true)).toBe("2m 14s");
  });

  it("shows whole minutes while running 10 to 59 minutes", () => {
    expect(formatDuration(600_000, true)).toBe("10m");
  });

  it("shows hours and zero-padded minutes while running an hour or more", () => {
    expect(formatDuration(3_720_000, true)).toBe("1h 02m");
  });

  it("shows whole minutes once finished", () => {
    expect(formatDuration(2 * 60_000, false)).toBe("2m");
    expect(formatDuration(19 * 60_000 + 20_000, false)).toBe("19m");
  });

  it("shows hours and zero-padded minutes once finished", () => {
    expect(formatDuration(3_720_000, false)).toBe("1h 02m");
  });

  it("shows <1m when finished in under a minute", () => {
    expect(formatDuration(30_000, false)).toBe("<1m");
  });

  it("shows a dash for unknown durations", () => {
    expect(formatDuration(undefined, true)).toBe("—");
    expect(formatDuration(undefined, false)).toBe("—");
  });

  it("shows a dash for negative or NaN durations", () => {
    expect(formatDuration(-1, false)).toBe("—");
    expect(formatDuration(-5_000, true)).toBe("—");
    expect(formatDuration(Number.NaN, true)).toBe("—");
  });
});
