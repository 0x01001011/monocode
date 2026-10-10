import { useEffect, useLayoutEffect, useRef, type FocusEvent, type MutableRefObject, type RefObject } from "react";

/** A panel-side request: a new `token` opens the way to row `id`, scrolls it into view and focuses it. */
export type TreeReveal = { id: string; token: number };

// A reveal that has not found its row by then is dropped, so a late render cannot steal focus.
const REVEAL_WINDOW_MS = 500;

type RevealOptions = {
  reveal: TreeReveal | undefined;
  /** The tree's treeitems by row id; each item's first child is the visible row. */
  items: MutableRefObject<Map<string, HTMLElement>>;
  setActiveId: (id: string) => void;
  /** The ancestors of `id` that are closed now, or undefined when the tree does not know the id. */
  closedAncestors: (id: string) => string[] | undefined;
  toggle: (id: string) => void;
};

/**
 * Reveal for an ARIA tree. Opening ancestors renders later (a controlled parent updates on its
 * own schedule), so the row is looked for again after each render until it shows or the window ends.
 */
export function useTreeReveal({ reveal, items, setActiveId, closedAncestors, toggle }: RevealOptions) {
  const pendingReveal = useRef<string | undefined>(undefined);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastToken = useRef(reveal?.token);
  const showRow = (id: string): boolean => {
    const item = items.current.get(id);
    if (!item) return false;
    setActiveId(id);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    // Scroll the row itself: the item also contains its children, which can be far taller.
    (item.firstElementChild as HTMLElement | null)?.scrollIntoView?.({
      block: "nearest",
      behavior: reduce ? "auto" : "smooth",
    });
    item.focus({ preventScroll: true });
    return true;
  };
  useLayoutEffect(() => {
    const id = pendingReveal.current;
    if (id !== undefined && showRow(id)) {
      pendingReveal.current = undefined;
      clearTimeout(revealTimer.current);
    }
  });
  useLayoutEffect(() => {
    if (reveal === undefined || reveal.token === lastToken.current) return;
    lastToken.current = reveal.token;
    const closed = closedAncestors(reveal.id);
    if (closed === undefined) return;
    if (closed.length === 0) {
      showRow(reveal.id);
      return;
    }
    pendingReveal.current = reveal.id;
    clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(() => {
      pendingReveal.current = undefined;
    }, REVEAL_WINDOW_MS);
    for (const id of closed) toggle(id);
    // Only a new token reveals; a re-render with the same request must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.token]);
  useEffect(() => () => clearTimeout(revealTimer.current), []);
}

/**
 * When a collapse removes the focused row, keeps focus inside the tree on `tabId` (the row that
 * now holds the tab stop). Spread the returned handlers on the tree element.
 */
export function useFocusKeptInTree(
  tree: RefObject<HTMLElement | null>,
  items: MutableRefObject<Map<string, HTMLElement>>,
  tabId: string | undefined,
) {
  const focusInside = useRef(false);
  useLayoutEffect(() => {
    if (!focusInside.current || tabId === undefined) return;
    if (tree.current?.contains(document.activeElement)) return;
    items.current.get(tabId)?.focus();
  });
  return {
    onFocus: () => {
      focusInside.current = true;
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      // A removed row may blur with no target; only a real move out ends "inside".
      if (e.target.isConnected && !tree.current?.contains(e.relatedTarget as Node | null)) {
        focusInside.current = false;
      }
    },
  };
}
