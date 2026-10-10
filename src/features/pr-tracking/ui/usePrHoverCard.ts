import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

/** Composer chip timings (the sidebar glyph opens after 400ms). */
export const PR_CARD_OPEN_DELAY = 220;
export const PR_CARD_CLOSE_DELAY = 100;

type Mode = "closed" | "hover" | "pinned";

const ROW = "[data-pr-row]";

function focusables(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>("a[href], button, [tabindex]"),
  ].filter(
    (el) =>
      el.tabIndex >= 0 &&
      !(el as HTMLButtonElement).disabled &&
      !el.closest("[aria-hidden='true']"),
  );
}

/**
 * Hover preview and pinned card in one non-modal dialog, ported from the
 * mockup's popover script. Hover opens after `openDelay` and closes
 * `closeDelay` after the pointer leaves both the trigger and the card; the
 * hover card never takes focus. Click (and so Enter / Space on the button)
 * pins it and focuses the first row. Esc closes it from anywhere while it is
 * open, returning focus to the trigger only when the card was pinned or held
 * focus. Tabbing past either end of the card closes it onto the trigger.
 *
 * Escape is heard on `document` in the capture phase, after `window`. A
 * Popover opened from inside the card (a row's ⋯ menu) handles Escape on
 * `window` and stops propagation, so the menu closes alone.
 */
export function usePrHoverCard({
  openDelay = PR_CARD_OPEN_DELAY,
  closeDelay = PR_CARD_CLOSE_DELAY,
}: { openDelay?: number; closeDelay?: number } = {}) {
  const [mode, setMode] = useState<Mode>("closed");
  const cardId = useId();
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const modeRef = useRef<Mode>(mode);
  modeRef.current = mode;
  /** Pinning from the trigger moves focus in; a click inside the card does not. */
  const focusOnPin = useRef(false);

  const clearTimers = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const close = useCallback(
    (returnFocus: boolean) => {
      clearTimers();
      if (modeRef.current === "closed") return;
      // Move focus before the card unmounts so it never falls to the body.
      if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
      modeRef.current = "closed";
      setMode("closed");
    },
    [clearTimers],
  );

  const pin = useCallback(
    (focusFirst: boolean) => {
      clearTimers();
      focusOnPin.current = focusFirst;
      modeRef.current = "pinned";
      setMode("pinned");
    },
    [clearTimers],
  );

  const scheduleClose = useCallback(() => {
    clearTimeout(closeTimer.current);
    if (modeRef.current !== "hover") return;
    closeTimer.current = setTimeout(() => close(false), closeDelay);
  }, [close, closeDelay]);

  const open = mode !== "closed";
  const pinned = mode === "pinned";

  // Pinned from the trigger: focus the roving row (else the first control).
  // Popover measures itself hidden first, and a hidden element cannot take
  // focus, so retry on the next frame when the first try does not land.
  useEffect(() => {
    if (!pinned || !focusOnPin.current) return;
    focusOnPin.current = false;
    const attempt = () => {
      const surface = surfaceRef.current;
      if (!surface) return false;
      const target =
        surface.querySelector<HTMLElement>(`${ROW}[tabindex="0"]`) ??
        focusables(surface)[0];
      target?.focus({ preventScroll: true });
      return !!target && document.activeElement === target;
    };
    if (attempt()) return;
    const frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [pinned]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent | globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const inside = !!surfaceRef.current?.contains(document.activeElement);
      const owned = modeRef.current === "pinned" || inside;
      // A hover preview over someone else's focus closes, but their Escape
      // still reaches them.
      if (owned) {
        event.preventDefault();
        event.stopPropagation();
      }
      close(owned);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  const triggerProps = {
    "aria-haspopup": "dialog" as const,
    "aria-expanded": open,
    "aria-controls": open ? cardId : undefined,
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch") return;
      clearTimeout(closeTimer.current);
      if (modeRef.current !== "closed") return;
      clearTimeout(openTimer.current);
      openTimer.current = setTimeout(() => {
        if (modeRef.current !== "closed") return;
        modeRef.current = "hover";
        setMode("hover");
      }, openDelay);
    },
    onPointerLeave: () => {
      clearTimeout(openTimer.current);
      scheduleClose();
    },
    onClick: () => {
      clearTimeout(openTimer.current);
      if (modeRef.current === "pinned") close(true);
      else pin(true);
    },
  };

  const surfaceProps = {
    id: cardId,
    role: "dialog" as const,
    "aria-modal": false as const,
    "aria-labelledby": titleId,
    onPointerEnter: () => clearTimeout(closeTimer.current),
    onPointerLeave: scheduleClose,
    // Reaching into a hover preview means the user is working in it.
    onPointerDown: () => {
      if (modeRef.current === "hover") pin(false);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      const surface = surfaceRef.current;
      // Keys from a portalled child (a row's menu) bubble here through React.
      if (!surface || !surface.contains(event.target as Node)) return;
      const stops = focusables(surface);
      const at = stops.indexOf(document.activeElement as HTMLElement);
      const pastEnd = !event.shiftKey && at === stops.length - 1;
      const pastStart = event.shiftKey && at <= 0;
      if (!pastEnd && !pastStart) return;
      event.preventDefault();
      close(true);
    },
  };

  return {
    open,
    pinned,
    cardId,
    titleId,
    triggerRef,
    surfaceRef,
    triggerProps,
    surfaceProps,
    close,
  };
}

/**
 * One tab stop for a list of PR rows (`[data-pr-row]`) with ↑/↓ (wrapping),
 * Home and End inside it. Put `onKeyDown` / `onFocus` on the element that
 * holds every row and give each row `tabIndex={i === activeIndex ? 0 : -1}`.
 */
export function useRovingRows(count: number) {
  const [active, setActive] = useState(0);
  const activeIndex = count === 0 ? 0 : Math.min(active, count - 1);

  const rows = (root: HTMLElement) => [
    ...root.querySelectorAll<HTMLElement>(ROW),
  ];

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (!target.matches?.(ROW)) return;
    const list = rows(event.currentTarget);
    const at = list.indexOf(target);
    if (at < 0 || list.length === 0) return;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (at + 1) % list.length;
    else if (event.key === "ArrowUp")
      next = (at - 1 + list.length) % list.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = list.length - 1;
    if (next == null) return;
    event.preventDefault();
    setActive(next);
    list[next].focus();
  };

  const onFocus = (event: FocusEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (!target.matches?.(ROW)) return;
    const at = rows(event.currentTarget).indexOf(target);
    if (at >= 0) setActive(at);
  };

  return { activeIndex, onKeyDown, onFocus };
}
