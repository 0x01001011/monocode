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
export type Counts = { textNodes: number; glyphs: number; phases: number; rows: number; rootChildren: number };
export type Measured = { failures: Failure[]; counts: Counts };

// Colors are measured at rest: a theme switch must not be caught mid-transition.
export async function freezeTransitions(page: Page) {
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
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
      if (got + 0.005 < need) fails.push({ kind, what, got: +got.toFixed(2), need });
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

    // Targets.
    const targets = Array.from(scopeEl.querySelectorAll('button, select, [role="treeitem"] > [data-row]'));
    if (scopeEl.matches("button, select")) targets.push(scopeEl);
    for (const el of targets) {
      const r = el.getBoundingClientRect();
      if (r.height + 0.5 < 24) check("target", (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30), r.height, 24);
    }
    return {
      failures: fails,
      counts: {
        textNodes,
        glyphs: glyphEls.length,
        phases: document.querySelectorAll('ol[aria-label="Superpowers flow"] > li').length,
        rows: document.querySelectorAll("tr[data-node]").length,
        rootChildren: panel.childElementCount,
      },
    };
  }, scope);
}
