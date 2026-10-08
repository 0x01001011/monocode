/** True when the user asked the OS for less motion. Safe where `matchMedia` is missing. */
export function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/** Read the shared CSS tokens so pointer gestures and CSS use the same timing. */
export function reorderMotion() {
  const style = window.getComputedStyle(document.documentElement);
  const duration = style.getPropertyValue("--motion-reorder-duration").trim();
  const milliseconds =
    parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000);
  return {
    duration: Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0,
    easing: style.getPropertyValue("--motion-ease-out").trim() || "linear",
  };
}

export function tabCloseDuration() {
  const value = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue("--motion-tab-close-duration")
    .trim();
  const duration = parseFloat(value) * (value.endsWith("ms") ? 1 : 1000);
  return (Number.isFinite(duration) && duration > 0 ? duration : 0) || 180;
}
