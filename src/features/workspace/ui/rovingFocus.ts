/**
 * Target index for the Left, Right, Home and End keys on a horizontal roving
 * strip (tabs, a menu bar), wrapping at both ends. Returns `null` for any
 * other key or when the strip has nothing to move to.
 */
export function nextRovingIndex(
  key: string,
  current: number,
  count: number,
): number | null {
  if (count <= 0 || current < 0 || current >= count) return null;
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
