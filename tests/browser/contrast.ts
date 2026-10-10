import type { Page } from "@playwright/test";

// Shared accessibility measurement for the browser fixtures. Text and glyphs are
// composited over their real backgrounds (canvas resolves color-mix and alpha, so
// the numbers are what the user sees).

export const THEMES: [theme: "dark" | "light", palette: "default" | "colorblind" | "high-contrast"][] = [
  ["dark", "default"],
  ["light", "default"],
  ["dark", "colorblind"],
  ["light", "colorblind"],
  ["dark", "high-contrast"],
  ["light", "high-contrast"],
];

export type Failure = { kind: string; what: string; got: number; need: number };
/** What a measurement looked at, so a run that found nothing cannot pass for a clean one. */
export type Counts = {
  textNodes: number;
  glyphs: number;
  phases: number;
  /** Tree rows (`role="treeitem"`) in the measured scope. */
  rows: number;
  /** Graph gutter lines and curves, and graph nodes, checked at 3:1. */
  gutterLines: number;
  gutterNodes: number;
  rootChildren: number;
};
export type Measured = { failures: Failure[]; counts: Counts };

// Colors are measured at rest: a theme switch must not be caught mid-transition, and the now
// node's pulse must not be caught at its faint frame (the pulse is motion-safe decoration).
export async function freezeTransitions(page: Page) {
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
}

/** Measures the whole fixture root, or only the element matching `scope` (for states like hover). */
export function measure(page: Page, scope?: string): Promise<Measured> {
  return page.evaluate((scopeSelector) => {
    const panel = document.getElementById("root")!;
    const scopeEl = scopeSelector ? document.querySelector(scopeSelector) : panel;
    if (!scopeEl) throw new Error(`measure: nothing matches ${scopeSelector}`);
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const cx = cv.getContext("2d", { willReadFrequently: true })!;
    const rgba = (c: string): number[] => {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = "#000";
      cx.fillStyle = c;
      cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const over = (top: number[], bot: number[]) => {
      const a = top[3];
      return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1];
    };
    const lum = (c: number[]) => {
      const f = (v: number) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (a: number[], b: number[]) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const bgOf = (el: Element) => {
      const chain: Element[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) chain.push(e);
      let base = [0, 0, 0, 1];
      for (const e of chain.reverse()) {
        const c = rgba(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) base = over(c, base);
      }
      return base;
    };
    const fails: { kind: string; what: string; got: number; need: number }[] = [];
    const check = (kind: string, what: string, got: number, need: number) => {
      if (got + 0.005 < need || (window as unknown as { __all?: boolean }).__all) fails.push({ kind, what, got: +got.toFixed(2), need });
    };

    // Text: 4.5:1, or 3:1 for large text (24px+, or bold 18.66px+). Glyph marks are checked below.
    const walker = document.createTreeWalker(scopeEl, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    let textNodes = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement!;
      const text = (n.textContent ?? "").trim();
      if (!text || seen.has(el) || el.closest('[role="img"]')) continue;
      seen.add(el);
      textNodes++;
      const cs = getComputedStyle(el);
      const bg = bgOf(el);
      const fg = rgba(cs.color);
      fg[3] *= Number(cs.opacity);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (Number(cs.fontWeight) >= 700 && size >= 18.66);
      check("text", text.slice(0, 40), ratio(over(fg, bg), bg), large ? 3 : 4.5);
    }

    // Glyphs. Borders are non-text controls (3:1). A text mark on a fill is text (4.5:1).
    // An svg or dot mark is a graphic (3:1). A tinted fill with no mark is decorative.
    const glyphEls = Array.from(scopeEl.querySelectorAll('[role="img"]'));
    for (const el of glyphEls) {
      const label = el.getAttribute("aria-label") ?? "glyph";
      const cs = getComputedStyle(el);
      const bg = bgOf(el.parentElement!);
      if (parseFloat(cs.borderTopWidth) > 0) {
        const bc = rgba(cs.borderTopColor);
        if (bc[3] > 0) check("glyph border", label, ratio(over(bc, bg), bg), 3);
      }
      const fill = rgba(cs.backgroundColor);
      const base = fill[3] > 0 ? over(fill, bg) : bg;
      const mark = rgba(cs.color);
      const text = (el.textContent ?? "").trim();
      if (text) check("glyph mark", `${label} ${text}`, ratio(over(mark, base), base), 4.5);
      for (const child of Array.from(el.children)) {
        // An unfilled track (a segment not started yet) is the absence of a status, not a mark:
        // the counts line and the tree say the same in words, so it carries no 3:1 requirement.
        if (child.hasAttribute("data-track")) continue;
        const ccs = getComputedStyle(child);
        if (child instanceof SVGElement) {
          check("glyph svg", label, ratio(over(rgba(ccs.color), base), base), 3);
        } else {
          const dot = rgba(ccs.backgroundColor);
          if (dot[3] > 0) check("glyph dot", label, ratio(over(dot, base), base), 3);
        }
      }
    }

    // The commit graph gutter: lines and nodes are non-text graphics (3:1) against the row they
    // sit in. Lines take `currentColor` from the muted wrapper; a node passes when its fill or its
    // outline stands out (a hollow node's fill is the background on purpose).
    const paint = (value: string, fallback: string) => {
      const v = value.trim();
      if (!v || v === "none" || v.startsWith("url(")) return undefined;
      return rgba(v.toLowerCase() === "currentcolor" ? fallback : v);
    };
    const opacityWithin = (el: Element, stop: Element) => {
      let alpha = 1;
      for (let e: Element | null = el; e && e !== stop.parentElement; e = e.parentElement) alpha *= Number(getComputedStyle(e).opacity);
      return alpha;
    };
    let gutterLines = 0;
    let gutterNodes = 0;
    for (const svg of Array.from(scopeEl.querySelectorAll("svg[data-gutter]"))) {
      const bg = bgOf(svg.parentElement!);
      const row = svg.closest('[role="treeitem"]');
      const name = (row?.getAttribute("aria-label") ?? "row").slice(0, 30);
      const toned = (el: Element, value: string, ccs: CSSStyleDeclaration) => {
        const c = paint(value, ccs.color);
        if (!c || c[3] === 0) return undefined;
        c[3] *= opacityWithin(el, svg);
        return ratio(over(c, bg), bg);
      };
      for (const line of Array.from(svg.querySelectorAll("[data-line], [data-curve]"))) {
        const ccs = getComputedStyle(line);
        if (parseFloat(ccs.strokeWidth) <= 0) continue;
        const got = toned(line, ccs.stroke, ccs);
        if (got === undefined) continue;
        gutterLines++;
        check("gutter line", `${name} ${line.getAttribute("data-line") ?? "curve"}`, got, 3);
      }
      for (const node of Array.from(svg.querySelectorAll("[data-node]"))) {
        const shapes = node.tagName.toLowerCase() === "g" ? Array.from(node.children) : [node];
        for (const shape of shapes) {
          const ccs = getComputedStyle(shape);
          const fill = toned(shape, ccs.fill, ccs) ?? 1;
          const stroke = parseFloat(ccs.strokeWidth) > 0 ? (toned(shape, ccs.stroke, ccs) ?? 1) : 1;
          gutterNodes++;
          check("gutter node", `${name} ${shape.tagName.toLowerCase()}`, Math.max(fill, stroke), 3);
        }
      }
    }

    // Targets. An element that is not rendered (display: none at this width) is no target.
    const targets = Array.from(scopeEl.querySelectorAll('button, select, [role="treeitem"] > [data-row]'));
    if (scopeEl.matches("button, select")) targets.push(scopeEl);
    for (const el of targets) {
      if (el.getClientRects().length === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.height + 0.5 < 24) check("target", (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30), r.height, 24);
    }
    return {
      failures: fails,
      counts: {
        textNodes,
        glyphs: glyphEls.length,
        phases: document.querySelectorAll('ol[aria-label="Superpowers flow"] > li').length,
        rows: scopeEl.querySelectorAll('[role="treeitem"]').length,
        gutterLines,
        gutterNodes,
        rootChildren: panel.childElementCount,
      },
    };
  }, scope);
}

export type FocusStop = {
  /** A readable name for the stop, e.g. `button "Show all 5"`. */
  label: string;
  /** What kind of control it is, so a run can prove it reached each kind. */
  kind: "treeitem" | "select" | "flow-strip" | "overview-pill" | "button" | "heading" | "other";
  /** True the first time this element is seen on the page, so repeated stops are not double counted. */
  fresh: boolean;
  outlineStyle: string;
  outlineWidth: number;
  /** Distance from the border edge to the inner edge of the ring; negative is inward. */
  outlineOffset: number;
  /** The lower of the ring's contrasts against what it is drawn over (parent, and the element's own fill when the ring touches it). */
  contrast: number;
  /** The first overflow-clipping ancestor that cuts the ring, if any. */
  clippedBy: string | null;
  /** Why this stop has no visible ring, or null when it has one. */
  problem: string | null;
};

/**
 * Describes the focus ring of the focused element (the `[data-row]` child for a treeitem, where the
 * ring is drawn): style, width, contrast against the real background under it, and whether an
 * `overflow` ancestor clips it. Returns null when focus is on the body (it left the page).
 */
export function focusStop(page: Page): Promise<FocusStop | null> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) return null;
    const seenSet = ((window as unknown as { __focusSeen?: WeakSet<Element> }).__focusSeen ??= new WeakSet());
    const fresh = !seenSet.has(active);
    seenSet.add(active);

    const isTreeitem = active.getAttribute("role") === "treeitem";
    const target = isTreeitem ? (active.querySelector(":scope > [data-row]") ?? active) : active;
    const cs = getComputedStyle(target);

    // Same canvas compositing as `measure`, so the numbers match what the user sees.
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const cx = cv.getContext("2d", { willReadFrequently: true })!;
    const rgba = (c: string): number[] => {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = "#000";
      cx.fillStyle = c;
      cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const over = (top: number[], bot: number[]) => {
      const a = top[3];
      return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1];
    };
    const lum = (c: number[]) => {
      const f = (v: number) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (a: number[], b: number[]) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const backdrop = (el: Element | null) => {
      const chain: Element[] = [];
      for (let e = el; e; e = e.parentElement) chain.push(e);
      let base = [0, 0, 0, 1];
      for (const e of chain.reverse()) {
        const c = rgba(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) base = over(c, base);
      }
      return base;
    };

    const outlineStyle = cs.outlineStyle;
    const outlineWidth = parseFloat(cs.outlineWidth) || 0;
    const outlineOffset = parseFloat(cs.outlineOffset) || 0;
    const ring = rgba(cs.outlineColor);
    const below = backdrop(target.parentElement);
    const withOwn = over(rgba(cs.backgroundColor), below);
    // The ring spans [offset, offset + width] outward from the border edge.
    const outer = outlineOffset + outlineWidth;
    const touchesOutside = outer > 0.01;
    const touchesInside = outlineOffset < -0.01;
    const against: number[][] = [];
    if (touchesOutside) against.push(below);
    if (touchesInside) against.push(withOwn);
    if (against.length === 0) against.push(below);
    const contrast = Math.min(...against.map((bg) => ratio(over(ring, bg), bg)));

    // The ring's outer rectangle must sit inside every clipping ancestor's padding box.
    const rect = target.getBoundingClientRect();
    const grow = Math.max(outer, 0);
    let clippedBy: string | null = null;
    for (let a = target.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const acs = getComputedStyle(a);
      if (acs.overflowX === "visible" && acs.overflowY === "visible") continue;
      const r = a.getBoundingClientRect();
      const left = r.left + parseFloat(acs.borderLeftWidth);
      const right = r.right - parseFloat(acs.borderRightWidth);
      const top = r.top + parseFloat(acs.borderTopWidth);
      const bottom = r.bottom - parseFloat(acs.borderBottomWidth);
      const cutX = acs.overflowX !== "visible" && (rect.left - grow < left - 0.5 || rect.right + grow > right + 0.5);
      const cutY = acs.overflowY !== "visible" && (rect.top - grow < top - 0.5 || rect.bottom + grow > bottom + 0.5);
      if (cutX || cutY) {
        clippedBy = `${a.tagName.toLowerCase()}.${a.className.toString().slice(0, 50)}`;
        break;
      }
    }

    const name = (active.getAttribute("aria-label") ?? active.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    const tag = active.tagName.toLowerCase();
    const kind: FocusStop["kind"] = isTreeitem
      ? "treeitem"
      : tag === "select"
        ? "select"
        : tag === "button" && active.closest('ol[aria-label="Superpowers flow"]')
          ? "flow-strip"
          : tag === "button" && active.closest("[data-problems]")
            ? "overview-pill"
            : tag === "button"
              ? "button"
              : tag === "h3"
                ? "heading"
                : "other";

    let problem: string | null = null;
    if (outlineStyle === "none" || outlineStyle === "hidden") problem = `outline-style is ${outlineStyle}`;
    else if (outlineWidth < 2) problem = `outline-width ${outlineWidth}px`;
    else if (contrast + 0.005 < 3) problem = `ring contrast ${contrast.toFixed(2)}:1`;
    else if (clippedBy) problem = `ring clipped by ${clippedBy}`;

    return { label: `${kind} "${name}"`, kind, fresh, outlineStyle, outlineWidth, outlineOffset, contrast: +contrast.toFixed(2), clippedBy, problem };
  });
}

/**
 * Horizontal overflow of the fixture column: the scroller (the root's first child) must not scroll
 * sideways, no visible control, ref or text block may poke past the column's edges, and none may be
 * cut off by an `overflow` ancestor inside the scroller (text that does not fit must truncate with
 * an ellipsis, not lose its end silently). Row actions are collapsed on purpose until shown.
 */
export function overflowFailures(page: Page): Promise<Failure[]> {
  return page.evaluate(() => {
    const root = document.getElementById("root")!;
    const scroller = root.firstElementChild as HTMLElement | null;
    const fails: { kind: string; what: string; got: number; need: number }[] = [];
    if (!scroller) return [{ kind: "overflow", what: "no panel", got: 0, need: 1 }];
    if (scroller.scrollWidth > scroller.clientWidth) {
      fails.push({ kind: "overflow", what: "the panel scrolls sideways", got: scroller.scrollWidth, need: scroller.clientWidth });
    }
    const column = scroller.getBoundingClientRect();
    const parts = scroller.querySelectorAll("button, select, [role=radiogroup], [data-ref], [data-meta], [data-now-pill], [data-counts], [data-time], [data-strip], li, h3, p");
    for (const el of Array.from(parts)) {
      if (el.getClientRects().length === 0) continue;
      const r = el.getBoundingClientRect();
      if (el.closest("[data-actions]")) continue;
      let left = r.left;
      let right = r.right;
      for (let a = el.parentElement; a && a !== scroller; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX === "visible") continue;
        const ar = a.getBoundingClientRect();
        left = Math.max(left, ar.left);
        right = Math.min(right, ar.right);
      }
      const what = (el.getAttribute("aria-label") ?? el.textContent ?? el.tagName).trim().replace(/\s+/g, " ").slice(0, 40);
      if (right - left <= 0.5) {
        if (r.width > 0.5) fails.push({ kind: "overflow", what: `clipped away: ${what}`, got: 0, need: +r.width.toFixed(1) });
        continue;
      }
      if (right > column.right + 0.5 || left < column.left - 0.5) {
        fails.push({ kind: "overflow", what, got: +Math.max(right - column.right, column.left - left).toFixed(1), need: 0 });
      } else if (r.right > right + 0.5 || r.left < left - 0.5) {
        fails.push({ kind: "overflow", what: `clipped: ${what}`, got: +(right - left).toFixed(1), need: +r.width.toFixed(1) });
      }
    }
    return fails;
  });
}
