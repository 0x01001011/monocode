const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]",
].join(",");

/** Tabbable descendants of `root` in document order. */
export function tabbableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => {
      if (element.tabIndex < 0) return false;
      if (element.closest("[hidden], [inert]")) return false;
      const style =
        element.ownerDocument.defaultView?.getComputedStyle(element);
      return style?.display !== "none" && style?.visibility !== "hidden";
    },
  );
}

/**
 * Keeps Tab and Shift+Tab inside `root`. Returns true when it handled the key.
 * Events that come from outside `root` in the DOM (a popover portaled to
 * `document.body` that React still bubbles through the dialog) are left alone.
 */
export function trapTab(event: KeyboardEvent, root: HTMLElement): boolean {
  if (event.key !== "Tab" || event.defaultPrevented) return false;
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  if (!(event.target instanceof Node) || !root.contains(event.target)) {
    return false;
  }
  const items = tabbableWithin(root);
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) {
    event.preventDefault();
    root.focus();
    return true;
  }
  const active = root.ownerDocument.activeElement;
  const outsideList = active === root || !items.includes(active as HTMLElement);
  if (event.shiftKey && (active === first || outsideList)) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && (active === last || outsideList)) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

const inertCounts = new WeakMap<Element, { count: number; was: boolean }>();

/**
 * Makes the app behind a modal unreachable by keyboard, pointer and screen
 * reader. Only the app root is made inert, so popovers and toasts that portal
 * to `document.body` stay live. Nested modals are counted, and a root that was
 * already inert is left that way on release. Does nothing when `panel` lives
 * inside the root. Returns a release function.
 */
export function inertBackground(
  doc: Document,
  panel: Element,
  rootSelector = "#root",
): () => void {
  const root = doc.querySelector(rootSelector);
  if (!root || root.contains(panel)) return () => {};
  const entry = inertCounts.get(root) ?? {
    count: 0,
    was: root.hasAttribute("inert"),
  };
  entry.count += 1;
  inertCounts.set(root, entry);
  root.setAttribute("inert", "");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.count -= 1;
    if (entry.count > 0) return;
    inertCounts.delete(root);
    if (!entry.was) root.removeAttribute("inert");
  };
}

/**
 * Puts focus back on the element that opened a dialog. Skipped when the trigger
 * is gone, or when something else took focus on purpose while the dialog closed.
 */
export function restoreFocus(doc: Document, target: Element | null) {
  if (!(target instanceof HTMLElement) || !target.isConnected) return;
  const active = doc.activeElement;
  if (active && active !== doc.body && active !== doc.documentElement) return;
  target.focus({ preventScroll: true });
}
