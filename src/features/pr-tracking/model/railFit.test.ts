import { describe, expect, it } from "vitest";
import { fitRail, type RailNodeWidth } from "./railFit";

/** Nodes numbered from 1, each 100 wide with its title and 40 without. */
function nodes(count: number, full = 100, compact = 40): RailNodeWidth[] {
  return Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    full,
    compact,
  }));
}

describe("fitRail", () => {
  it.each([
    {
      name: "fits with room to spare",
      widths: nodes(3),
      available: 400,
      current: 2,
      expected: { mode: "full", compactNumbers: [] },
    },
    {
      name: "fits exactly",
      widths: nodes(3),
      available: 300,
      current: 2,
      expected: { mode: "full", compactNumbers: [] },
    },
    {
      name: "compacts the farthest node first and stops as soon as it fits",
      // 6 nodes, viewing #3: farthest is #6 (3 away), then #5 and #1 (2 away).
      widths: nodes(6),
      available: 540,
      current: 3,
      expected: { mode: "compact", compactNumbers: [6] },
    },
    {
      name: "compacts one at a time by distance, base side first on a tie",
      widths: nodes(6),
      available: 420,
      current: 3,
      expected: { mode: "compact", compactNumbers: [6, 1, 5] },
    },
    {
      name: "never compacts the viewed node; falls to scroll when the rest is not enough",
      widths: nodes(6),
      // 100 + 5 * 40 = 300 is the narrowest the rail gets.
      available: 299,
      current: 3,
      expected: { mode: "scroll", compactNumbers: [6, 1, 5, 2, 4] },
    },
    {
      name: "single node that fits",
      widths: nodes(1),
      available: 100,
      current: 1,
      expected: { mode: "full", compactNumbers: [] },
    },
    {
      name: "single node that does not fit scrolls",
      widths: nodes(1),
      available: 60,
      current: 1,
      expected: { mode: "scroll", compactNumbers: [] },
    },
    {
      name: "viewing the base compacts from the tip",
      widths: nodes(4),
      available: 300,
      current: 1,
      expected: { mode: "compact", compactNumbers: [4, 3] },
    },
    {
      name: "viewing the tip compacts from the base",
      widths: nodes(4),
      available: 300,
      current: 4,
      expected: { mode: "compact", compactNumbers: [1, 2] },
    },
  ])("$name", ({ widths, available, current, expected }) => {
    expect(fitRail(widths, available, current)).toEqual(expected);
  });

  it("uses each node's own widths", () => {
    const widths: RailNodeWidth[] = [
      { number: 10, full: 200, compact: 50 },
      { number: 11, full: 90, compact: 50 },
      { number: 12, full: 90, compact: 50 },
    ];
    // Viewing #12: #10 is farthest; compacting it alone saves 150.
    expect(fitRail(widths, 240, 12)).toEqual({
      mode: "compact",
      compactNumbers: [10],
    });
  });

  it("treats an unknown current like the base and an empty rail as fitting", () => {
    expect(fitRail(nodes(3), 250, 99)).toEqual({
      mode: "compact",
      compactNumbers: [3],
    });
    expect(fitRail([], 0, 1)).toEqual({ mode: "full", compactNumbers: [] });
  });
});
