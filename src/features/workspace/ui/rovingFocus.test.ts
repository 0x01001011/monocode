import { describe, expect, it } from "vitest";
import { nextRovingIndex } from "./rovingFocus";

describe("nextRovingIndex", () => {
  it("moves with the arrow keys and wraps at both ends", () => {
    expect(nextRovingIndex("ArrowRight", 0, 3)).toBe(1);
    expect(nextRovingIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextRovingIndex("ArrowLeft", 1, 3)).toBe(0);
    expect(nextRovingIndex("ArrowLeft", 0, 3)).toBe(2);
  });

  it("jumps to the ends with Home and End", () => {
    expect(nextRovingIndex("Home", 2, 4)).toBe(0);
    expect(nextRovingIndex("End", 0, 4)).toBe(3);
  });

  it("ignores other keys and empty or out-of-range strips", () => {
    expect(nextRovingIndex("ArrowDown", 0, 3)).toBeNull();
    expect(nextRovingIndex("Enter", 0, 3)).toBeNull();
    expect(nextRovingIndex("ArrowRight", 0, 0)).toBeNull();
    expect(nextRovingIndex("ArrowRight", -1, 3)).toBeNull();
    expect(nextRovingIndex("ArrowRight", 3, 3)).toBeNull();
  });
});
