/** Measured width of one rail node with its title (`full`) and without (`compact`). */
export type RailNodeWidth = { number: number; full: number; compact: number };

export type RailFit = {
  mode: "full" | "compact" | "scroll";
  /** PR numbers drawn without their titles. */
  compactNumbers: number[];
};

/**
 * How the Inbox stack rail fits `available` pixels, ported from the mockup's
 * `fitRail()`. Titles drop one node at a time, farthest from the viewed PR
 * first (the base side first on a tie), stopping as soon as the rail fits.
 * The viewed node keeps its title. When numbers alone still overflow, the
 * rail scrolls. An unknown `current` counts as the first node.
 */
export function fitRail(
  widths: RailNodeWidth[],
  available: number,
  current: number,
): RailFit {
  let total = widths.reduce((sum, node) => sum + node.full, 0);
  if (total <= available) return { mode: "full", compactNumbers: [] };
  const cur = Math.max(
    0,
    widths.findIndex((node) => node.number === current),
  );
  const byDistance = widths
    .map((node, i) => ({ node, d: Math.abs(i - cur) }))
    .filter((x) => x.d > 0)
    // Array sort is stable, so equal distances keep base-first order.
    .sort((a, b) => b.d - a.d);
  const compactNumbers: number[] = [];
  for (const { node } of byDistance) {
    compactNumbers.push(node.number);
    total -= node.full - node.compact;
    if (total <= available) return { mode: "compact", compactNumbers };
  }
  return { mode: "scroll", compactNumbers };
}
