import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_NAMES } from "./pr-tracking.fixtures";

// Chat PR tracking in a real browser engine: layout, contrast, targets, focus
// and keyboard behaviors that happy-dom cannot check. The harness renders the
// real components over Tauri's `mockIPC` (see pr-tracking.tsx).
//
//   npx playwright test tests/browser/pr-tracking.spec.ts --project=chromium
//
// PR_EVIDENCE=1 also writes screenshots and measured numbers to
// docs/superpowers/evidence/2026-10-09-pr-tracking/.

const EVIDENCE = "docs/superpowers/evidence/2026-10-09-pr-tracking";
const evidence = process.env.PR_EVIDENCE === "1";
const THEMES = ["dark", "light"] as const;
const WIDTHS = [900, 600, 420, 400, 360, 320, 300];

test.use({ viewport: { width: 1280, height: 1000 } });

/**
 * Merges measured numbers into `test-results/pr-tracking-metrics-<engine>.json`
 * and, with PR_EVIDENCE=1, into the committed evidence copy, so every number
 * in the report can be checked against a file.
 */
function recordMetrics(browserName: string, entries: Record<string, unknown>) {
  const files = [`test-results/pr-tracking-metrics-${browserName}.json`];
  if (evidence) files.push(`${EVIDENCE}/metrics-${browserName}.json`);
  for (const file of files) {
    mkdirSync(dirname(file), { recursive: true });
    const prior = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, `${JSON.stringify({ ...prior, ...entries }, null, 2)}\n`);
  }
}

type Params = Record<string, string | number | undefined>;

function harnessUrl(params: Params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) query.set(key, String(value));
  return `/tests/browser/pr-tracking.html?${query}`;
}

/** Collects console errors and page errors for the whole test. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function load(page: Page, params: Params = {}) {
  await page.goto(harnessUrl(params));
  await page.waitForSelector("html[data-ready]");
  await page.evaluate(() => document.fonts.ready);
  await frames(page);
}

const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

/**
 * Lets React commit what a fired timer scheduled. React schedules through
 * MessageChannel, which `page.clock` does not fake (rAF it does).
 */
const settle = (page: Page) =>
  page.evaluate(async () => {
    for (let i = 0; i < 3; i++)
      await new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(0);
      });
  });

const animationsDone = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );

const chip = (page: Page) => page.locator("#composer .pr-chip");
const card = (page: Page) => page.locator('[role="dialog"].pr-card');
/** The card's roving row, where pinning puts focus. */
const firstRow = (page: Page) =>
  page.locator('[role="dialog"] [data-pr-row][tabindex="0"]');

async function pin(page: Page) {
  await chip(page).click();
  await expect(card(page)).toBeVisible();
  await expect(firstRow(page)).toBeFocused();
  await animationsDone(page);
}

/** Keyboard focus on the chip: focus the branch button, then Tab once. */
async function tabToChip(page: Page) {
  await page.locator("#composer [data-branch-trigger] button").focus();
  await page.keyboard.press("Tab");
  await expect(chip(page)).toBeFocused();
}

/**
 * Lands on `selector` by keyboard: focus the tab stop before it (or the
 * harness's first stop), then press Tab, so `:focus-visible` applies.
 */
async function tabTo(page: Page, selector: string) {
  const target = page.locator(selector).first();
  await target.evaluate((el) => {
    const all = [
      ...document.querySelectorAll<HTMLElement>("a[href], button"),
    ].filter((e) => e.tabIndex >= 0);
    const i = all.indexOf(el as HTMLElement);
    (all[i - 1] ?? document.getElementById("tab-start")!).focus();
  });
  await page.keyboard.press("Tab");
  await expect(target).toBeFocused();
}

const activeLabel = (page: Page) =>
  page.evaluate(
    () =>
      document.activeElement?.getAttribute("aria-label") ??
      document.activeElement?.tagName ??
      "",
  );

// ------------------------------------------------------------ in-page audits

type Contrast = {
  failures: string[];
  minText: number;
  minIcon: number;
  /** Text node owners and icons actually measured (after the skip rules). */
  textCount: number;
  iconCount: number;
};

/**
 * WCAG contrast of every text node owner (4.5:1) and icon `svg` (3:1) under
 * `scope`, ported from /tmp/mc-audit/contrast.js: alpha-composited against
 * the stacked backgrounds of all ancestors, popover glass and absolutely
 * positioned `::before` halos included. Skips aria-hidden text (decorative),
 * near-transparent and disabled elements.
 */
function contrastAudit(scope: string): Contrast {
  const cv = document
    .createElement("canvas")
    .getContext("2d", { willReadFrequently: true })!;
  const viaCanvas = (c: string) => {
    cv.clearRect(0, 0, 1, 1);
    cv.fillStyle = "#000";
    cv.fillStyle = c;
    cv.fillRect(0, 0, 1, 1);
    const d = cv.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const parse = (c: string): number[] => {
    const m = c.match(/^rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p[3] ?? 1];
    }
    const s = c.match(/^color\(srgb ([^)]+)\)/);
    if (s) {
      const p = s[1].split(/[ /]+/).filter(Boolean).map(Number);
      return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1];
    }
    return viaCanvas(c);
  };
  const over = (top: number[], bottom: number[]) => {
    const a = top[3];
    return [
      top[0] * a + bottom[0] * (1 - a),
      top[1] * a + bottom[1] * (1 - a),
      top[2] * a + bottom[2] * (1 - a),
      1,
    ];
  };
  const layer = (style: CSSStyleDeclaration, stack: number[][]) => {
    const b = parse(style.backgroundColor);
    if (b[3] > 0) stack.push(b);
  };
  const px = (v: string) => parseFloat(v) || 0;
  /** An absolutely positioned `::before` whose box covers `point`. */
  const coveringBefore = (e: Element, point: { x: number; y: number }) => {
    const before = getComputedStyle(e, "::before");
    if (before.content === "none" || before.position !== "absolute") return null;
    const box = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    const left = box.left + px(cs.borderLeftWidth) + px(before.left);
    const top = box.top + px(cs.borderTopWidth) + px(before.top);
    const inside =
      point.x >= left &&
      point.x <= left + px(before.width) &&
      point.y >= top &&
      point.y <= top + px(before.height);
    return inside ? before : null;
  };
  const bgOf = (el: Element) => {
    const stack: number[][] = [];
    const r = el.getBoundingClientRect();
    const center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    let child: Element | null = null;
    let e: Element | null = el;
    while (e) {
      // Popover glass is a sibling layer under the content.
      for (const sibling of e.children) {
        if (sibling !== child && sibling.classList.contains("popover-backdrop"))
          layer(getComputedStyle(sibling), stack);
      }
      // Halos such as `.pr-ico::before` sit between the content and `e`.
      if (e !== el) {
        const before = coveringBefore(e, center);
        if (before) layer(before, stack);
      }
      layer(getComputedStyle(e), stack);
      child = e;
      e = e.parentElement;
    }
    let c = [255, 255, 255, 1];
    for (let i = stack.length - 1; i >= 0; i--) c = over(stack[i], c);
    return c;
  };
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const opacityOf = (el: Element) => {
    let o = 1;
    for (let e: Element | null = el; e; e = e.parentElement)
      o *= Number(getComputedStyle(e).opacity);
    return o;
  };
  const failures: string[] = [];
  let minText = Infinity;
  let minIcon = Infinity;
  let textCount = 0;
  let iconCount = 0;
  for (const el of document.querySelectorAll(scope)) {
    const own = [...el.childNodes].some(
      (n) => n.nodeType === 3 && n.textContent!.trim(),
    );
    const isSvg = el.tagName.toLowerCase() === "svg";
    if (!own && !isSvg) continue;
    if (!isSvg && el.closest('[aria-hidden="true"]')) continue;
    // App chrome outside this feature, measured separately in the report.
    if (el.closest("[data-audit-skip], #composer-head > :first-child")) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (opacityOf(el) < 0.05 || el.closest(":disabled")) continue;
    const bg = bgOf(el);
    let fg = parse(cs.color);
    fg = [fg[0], fg[1], fg[2], fg[3] * opacityOf(el)];
    const r = ratio(over(fg, bg), bg);
    if (isSvg) iconCount += 1;
    else textCount += 1;
    const need = isSvg ? 3 : 4.5;
    if (isSvg) minIcon = Math.min(minIcon, r);
    else minText = Math.min(minText, r);
    if (r < need) {
      const text = isSvg
        ? `[icon in .${(el.parentElement?.className || "").toString().trim().replace(/\s+/g, ".")}]`
        : [...el.childNodes]
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent!.trim())
            .join(" ")
            .slice(0, 40);
      const cls = (el.getAttribute("class") || el.tagName.toLowerCase())
        .trim()
        .replace(/\s+/g, ".");
      failures.push(`${r.toFixed(2)} < ${need} | .${cls} | ${text}`);
    }
  }
  return {
    failures: [...new Set(failures)],
    minText,
    minIcon,
    textCount,
    iconCount,
  };
}

type Target = { w: number; h: number; label: string };

/**
 * Interactive elements under `scope` smaller than 24×24, counting an
 * absolutely positioned `::before`/`::after` hit area (ported from
 * /tmp/mc-audit/checks.js). Returns every measured size too.
 */
function targetAudit(scope: string): {
  small: Target[];
  min: Target | null;
  count: number;
} {
  const small: Target[] = [];
  let min: Target | null = null;
  let count = 0;
  const px = (v: string) => (v === "auto" ? 0 : parseFloat(v) || 0);
  for (const el of document.querySelectorAll<HTMLElement>(scope)) {
    // App chrome outside this feature (project picker, context meter).
    if (el.closest("[data-audit-skip], #composer-head > :first-child")) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    let w = r.width;
    let h = r.height;
    for (const pseudo of ["::before", "::after"]) {
      const p = getComputedStyle(el, pseudo);
      if (p.content === "none" || p.position !== "absolute") continue;
      w = Math.max(w, r.width - px(p.left) - px(p.right));
      h = Math.max(h, r.height - px(p.top) - px(p.bottom));
    }
    const label = (el.getAttribute("aria-label") || el.textContent || "")
      .trim()
      .slice(0, 40);
    const t = { w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10, label };
    count += 1;
    if (!min || Math.min(t.w, t.h) < Math.min(min.w, min.h)) min = t;
    if (w < 23.99 || h < 23.99) small.push(t);
  }
  return { small, min, count };
}

/**
 * Regions audited one by one, so a drifted selector that matches nothing
 * fails instead of passing vacuously. `root` is the region's own element.
 */
const REGIONS = {
  chip: { root: "#composer .pr-chip", scope: "#composer .pr-chip *" },
  glyph: { root: "#sb-row .sb-glyph", scope: "#sb-row .sb-glyph *" },
  panel: { root: "#panel .pr-section", scope: "#panel .pr-section *" },
  inbox: { root: "#inbox .pr-inbox-stack", scope: "#inbox *" },
  card: { root: '[role="dialog"].pr-card', scope: '[role="dialog"].pr-card *' },
} as const;
type Region = keyof typeof REGIONS;

/** Regions a fixture renders nothing in; every other region shows text and icons. */
const ABSENT: Partial<Record<string, Region[]>> = {
  empty: ["chip", "glyph", "panel", "card"],
  hidden: ["glyph", "panel"],
};

const PR_SCOPE =
  "#composer *, #sidebar *, #panel *, #inbox *, [role=dialog] *, [role=menu] *";
const INTERACTIVE =
  "button, a[href], select, input, [role=menuitem], [tabindex]:not([tabindex='-1'])";
const PR_INTERACTIVE = [
  "#composer",
  "#sidebar",
  "#panel",
  "#inbox",
  "[role=dialog]",
  "[role=menu]",
]
  .flatMap((root) => INTERACTIVE.split(", ").map((s) => `${root} ${s}`))
  .join(", ");

// ------------------------------------------------------------------- tests

test.describe("layout", () => {
  for (const w of WIDTHS) {
    test(`composer row, card and panel do not overflow at ${w}px`, async ({
      page,
    }) => {
      for (const fixture of ["stack", "i18n"]) {
        await load(page, { w, fixture });
        const row = await page.evaluate(() => {
          const head = document.getElementById("composer-head")!;
          const box = head.getBoundingClientRect();
          const right = box.right - parseFloat(getComputedStyle(head).paddingRight);
          const over = [...head.children]
            .filter((c) => getComputedStyle(c).display !== "none")
            .map((c) => ({
              cls: c.className.toString().slice(0, 40),
              over: c.getBoundingClientRect().right - right,
            }))
            .filter((c) => c.over > 0.5);
          return { width: box.width, over };
        });
        expect(row.width).toBe(w);
        expect(row.over, `${fixture}: children past the row edge`).toEqual([]);

        const panel = await page.evaluate(() => {
          const section = document.querySelector<HTMLElement>(".pr-section");
          if (!section) return null;
          const box = section.getBoundingClientRect();
          const list = section.querySelector<HTMLElement>(".pr-list")!;
          const past = [...section.querySelectorAll("*")]
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.right > box.right + 0.5;
            })
            .map((el) => el.className.toString().slice(0, 40));
          return {
            sectionOverflow: section.scrollWidth - section.clientWidth,
            listOverflow: list.scrollWidth - list.clientWidth,
            past,
          };
        });
        expect(panel).not.toBeNull();
        expect(panel!.sectionOverflow, `${fixture} panel`).toBeLessThanOrEqual(0);
        expect(panel!.listOverflow, `${fixture} panel list`).toBeLessThanOrEqual(0);
        expect(panel!.past, `${fixture} panel`).toEqual([]);

        await pin(page);
        const cardBox = await page.evaluate(() => {
          const surface = document.querySelector<HTMLElement>(
            '[role="dialog"].pr-card',
          )!;
          const frame = surface.parentElement!;
          const box = frame.getBoundingClientRect();
          const body = surface.querySelector<HTMLElement>(".pr-card-body")!;
          const past = [...surface.querySelectorAll("*")]
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.right > box.right + 0.5;
            })
            .map((el) => el.className.toString().slice(0, 40));
          return {
            width: box.width,
            bodyOverflow: body.scrollWidth - body.clientWidth,
            inViewport:
              box.left >= 0 &&
              box.top >= 0 &&
              box.right <= innerWidth &&
              box.bottom <= innerHeight,
            past,
          };
        });
        expect(cardBox.width).toBe(360);
        expect(cardBox.bodyOverflow, `${fixture} card`).toBeLessThanOrEqual(0);
        expect(cardBox.past, `${fixture} card`).toEqual([]);
        expect(cardBox.inViewport).toBe(true);
      }
    });
  }

  test("at least 8 branch characters show at every width; the chip stays inside the row", async ({
    page,
  }) => {
    const visibleChars = () =>
      page.evaluate(() => {
        const span = document.querySelector<HTMLElement>(
          "#composer [data-branch-trigger] button span.truncate",
        )!;
        const text = span.textContent ?? "";
        if (span.scrollWidth <= span.clientWidth) return text.length;
        const cs = getComputedStyle(span);
        const ctx = document.createElement("canvas").getContext("2d")!;
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const room = span.clientWidth - ctx.measureText("…").width;
        let n = 0;
        while (n < text.length && ctx.measureText(text.slice(0, n + 1)).width <= room)
          n += 1;
        return n;
      });
    const chipInside = () =>
      page.evaluate(() => {
        const head = document.getElementById("composer-head")!;
        const box = head.getBoundingClientRect();
        const right = box.right - parseFloat(getComputedStyle(head).paddingRight);
        const c = document.querySelector("#composer .pr-chip")!.getBoundingClientRect();
        return c.left >= box.left && c.right <= right + 0.5 && c.width > 0;
      });
    const seen: Record<number, number> = {};
    for (const w of WIDTHS) {
      await load(page, { w });
      seen[w] = await visibleChars();
      if ([300, 420, 600, 900].includes(w)) expect(await chipInside(), `${w}px`).toBe(true);
    }
    for (const w of WIDTHS) expect(seen[w], `${w}px`).toBeGreaterThanOrEqual(8);
    test.info().annotations.push({
      type: "branch characters visible",
      description: JSON.stringify(seen),
    });
    recordMetrics(test.info().project.name, { branchCharactersByRowWidth: seen });
  });

  test("400px drops the strip and +N; 320px drops the Worktree label", async ({
    page,
  }) => {
    const shown = (selector: string) =>
      page.evaluate(
        (s) => {
          const el = document.querySelector(s);
          return !!el && getComputedStyle(el).display !== "none";
        },
        selector,
      );
    await load(page, { w: 600 });
    expect(await shown("#composer .pr-chip .pr-strip")).toBe(true);
    expect(await shown("#composer .pr-chip .pr-chip-more")).toBe(true);
    await load(page, { w: 400 });
    expect(await shown("#composer .pr-chip .pr-strip")).toBe(false);
    expect(await shown("#composer .pr-chip .pr-chip-more")).toBe(false);
    expect(await shown("#composer .workspace-label")).toBe(true);
    await load(page, { w: 360 });
    expect(await shown("#composer .workspace-label")).toBe(true);
    await load(page, { w: 320 });
    expect(await shown("#composer .workspace-label")).toBe(false);
  });

  test("a 40-PR card scrolls inside its 440px frame", async ({ page }) => {
    await load(page, { fixture: "many" });
    await pin(page);
    const before = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[role="dialog"].pr-card')!;
      const body = surface.querySelector<HTMLElement>(".pr-card-body")!;
      return {
        frame: surface.parentElement!.getBoundingClientRect().height,
        rows: surface.querySelectorAll(".pr-row").length,
        scrollable: body.scrollHeight > body.clientHeight,
        overflowY: getComputedStyle(body).overflowY,
      };
    });
    expect(before.rows).toBe(40);
    expect(before.frame).toBeLessThanOrEqual(440);
    expect(before.scrollable).toBe(true);
    expect(before.overflowY).toBe("auto");
    await page.locator(".pr-card-body").hover();
    await page.mouse.wheel(0, 4000);
    await expect
      .poll(() =>
        page.locator(".pr-card-body").evaluate((el) => el.scrollTop),
      )
      .toBeGreaterThan(0);
    const after = await page.evaluate(
      () =>
        document
          .querySelector<HTMLElement>('[role="dialog"].pr-card')!
          .parentElement!.getBoundingClientRect().height,
    );
    expect(after).toBe(before.frame);
  });

  test("row height in a real engine", async ({ page }) => {
    await load(page);
    await pin(page);
    const heights = await page.evaluate(() =>
      [...document.querySelectorAll('[role="dialog"] .pr-row')].map(
        (r) => Math.round(r.getBoundingClientRect().height * 10) / 10,
      ),
    );
    test.info().annotations.push({
      type: "card row heights (brief says 40px)",
      description: heights.join(", "),
    });
    recordMetrics(test.info().project.name, { cardRowHeightsPx: heights });
    for (const h of heights) {
      expect(h).toBeGreaterThanOrEqual(38);
      expect(h).toBeLessThanOrEqual(48);
    }
  });

  test("rail: 12 nodes compact first, then scroll with the viewed PR centered", async ({
    page,
  }) => {
    await load(page);
    const modes: { width: number; mode: string; compact: number }[] = [];
    for (let width = 3200; width >= 320; width -= 40) {
      await page.evaluate(
        (px) =>
          (
            window as unknown as { harness: { setInboxWidth(n: number): void } }
          ).harness.setInboxWidth(px),
        width,
      );
      await frames(page);
      const state = await page.evaluate(() => {
        const ol = document.querySelector<HTMLOListElement>("#rail-12 .pr-rail")!;
        const nav = ol.parentElement!;
        const current = ol.querySelector<HTMLElement>('[aria-current="step"]')!;
        const li = current.closest("li")!;
        const olBox = ol.getBoundingClientRect();
        const liBox = li.getBoundingClientRect();
        return {
          mode: ol.dataset.mode!,
          compact: [...ol.querySelectorAll("li[data-rail-node]")].filter(
            (n) => !n.querySelector("[data-rail-title]"),
          ).length,
          currentTitled: !!current.querySelector("[data-rail-title]"),
          // Centered unless the scroll range clamps it at either end.
          offCenter: (() => {
            const ideal = li.offsetLeft - (ol.clientWidth - li.offsetWidth) / 2;
            const max = ol.scrollWidth - ol.clientWidth;
            return Math.abs(ol.scrollLeft - Math.min(max, Math.max(0, ideal)));
          })(),
          centerGap: Math.abs(
            liBox.left + liBox.width / 2 - (olBox.left + olBox.width / 2),
          ),
          scrolls: ol.scrollWidth > ol.clientWidth,
          navOverflow: nav.scrollWidth - nav.clientWidth,
          fits: ol.scrollWidth <= ol.clientWidth,
        };
      });
      modes.push({ width, mode: state.mode, compact: state.compact });
      expect(state.currentTitled, `${width}px`).toBe(true);
      expect(state.navOverflow, `${width}px`).toBeLessThanOrEqual(0);
      if (state.mode !== "scroll") expect(state.fits, `${width}px fits`).toBe(true);
      else {
        expect(state.scrolls).toBe(true);
        expect(state.offCenter, `${width}px centered`).toBeLessThanOrEqual(1);
        if (width <= 640)
          expect(state.centerGap, `${width}px visually centered`).toBeLessThanOrEqual(2);
      }
    }
    const order = { full: 0, compact: 1, scroll: 2 } as Record<string, number>;
    for (let i = 1; i < modes.length; i++)
      expect(order[modes[i].mode]).toBeGreaterThanOrEqual(order[modes[i - 1].mode]);
    const seenModes = new Set(modes.map((m) => m.mode));
    expect([...seenModes]).toEqual(["full", "compact", "scroll"]);
    recordMetrics(test.info().project.name, {
      rail12ModeByInboxWidth: Object.fromEntries(
        modes.map((m) => [m.width, { mode: m.mode, compactNodes: m.compact }]),
      ),
    });
    test.info().annotations.push({
      type: "rail-12 mode by inbox width",
      description: modes
        .filter((m, i) => i === 0 || m.mode !== modes[i - 1].mode)
        .map((m) => `${m.width}px:${m.mode}`)
        .join(" "),
    });
  });

  test("3-, 6- and 12-node rails at 640px fit or scroll", async ({ page }) => {
    await load(page);
    const modes = await page.evaluate(() =>
      ["rail-3", "rail-6", "rail-12"].map((id) => {
        const ol = document.querySelector<HTMLOListElement>(`#${id} .pr-rail`)!;
        return { id, mode: ol.dataset.mode, fits: ol.scrollWidth <= ol.clientWidth };
      }),
    );
    expect(modes[0].mode).not.toBe("scroll");
    for (const m of modes) if (m.mode !== "scroll") expect(m.fits).toBe(true);
    test.info().annotations.push({ type: "rail modes at 640px", description: JSON.stringify(modes) });
    recordMetrics(test.info().project.name, { railModesAt640: modes });
  });

  test("200% zoom equivalent: the card fits a 640x500 CSS px window", async ({ page }) => {
    // A 1280x1000 window at 200% zoom lays out in 640x500 CSS px.
    await page.setViewportSize({ width: 640, height: 500 });
    for (const fixture of ["stack", "many", "i18n"]) {
      await load(page, { fixture, w: 600 });
      await pin(page);
      const box = await page.evaluate(() => {
        const surface = document.querySelector<HTMLElement>('[role="dialog"].pr-card')!;
        const r = surface.parentElement!.getBoundingClientRect();
        const body = surface.querySelector<HTMLElement>(".pr-card-body")!;
        return {
          inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
          bodyVisible: body.clientHeight,
          bodyOverflowX: body.scrollWidth - body.clientWidth,
          headAndFoot:
            surface.querySelector(".pr-card-head")!.getBoundingClientRect().height +
            surface.querySelector(".pr-card-foot")!.getBoundingClientRect().height,
        };
      });
      expect(box.inside, fixture).toBe(true);
      expect(box.bodyOverflowX, fixture).toBeLessThanOrEqual(0);
      // At least one full row stays visible between header and footer.
      expect(box.bodyVisible, fixture).toBeGreaterThanOrEqual(46);
    }
  });

  test("zero entries render no chip, glyph or panel section", async ({ page }) => {
    await load(page, { fixture: "empty" });
    await expect(chip(page)).toHaveCount(0);
    await expect(page.locator("#sb-row .sb-glyph")).toHaveCount(0);
    await expect(page.locator("#panel .pr-section")).toHaveCount(0);
    // The neighbor chat still shows its own glyph.
    await expect(page.locator("#sb-row-neighbor .sb-glyph")).toHaveCount(1);
    // Without a chip the branch button keeps its own sizing: no floor.
    const floor = () =>
      page
        .locator("#composer [data-branch-trigger]")
        .evaluate((el) => getComputedStyle(el).minWidth);
    expect(await floor()).toBe("0px");
    await load(page, { fixture: "stack" });
    expect(await floor()).not.toBe("0px");
  });

  test("all hidden shows the hidden chip and only the Hidden section", async ({
    page,
  }) => {
    await load(page, { fixture: "hidden" });
    await expect(chip(page)).toContainText("6 hidden");
    await pin(page);
    await expect(card(page).locator(".pr-card-title")).toHaveText(
      "6 hidden pull requests",
    );
    await expect(card(page).locator(".pr-hidden-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});

test.describe("contrast", () => {
  for (const theme of THEMES) {
    test(`text >= 4.5:1 and icons >= 3:1 over every fixture, ${theme}`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const failures: string[] = [];
      let minText = Infinity;
      let minIcon = Infinity;
      const perFixture: Record<string, Record<string, unknown>> = {};
      for (const fixture of FIXTURE_NAMES) {
        await load(page, { fixture, theme });
        if (fixture !== "empty") await pin(page);
        const absent = ABSENT[fixture] ?? [];
        const regions: Record<string, unknown> = {};
        for (const [name, region] of Object.entries(REGIONS) as [Region, (typeof REGIONS)[Region]][]) {
          const where = `${fixture}/${name}`;
          if (absent.includes(name)) {
            expect(await page.locator(region.root).count(), `${where} renders nothing`).toBe(0);
            continue;
          }
          expect(await page.locator(region.root).count(), `${where} renders`).toBeGreaterThan(0);
          const result = await page.evaluate(contrastAudit, region.scope);
          expect(result.textCount, `${where} text measured`).toBeGreaterThan(0);
          expect(result.iconCount, `${where} icons measured`).toBeGreaterThan(0);
          expect(Number.isFinite(result.minText), `${where} text minimum`).toBe(true);
          expect(Number.isFinite(result.minIcon), `${where} icon minimum`).toBe(true);
          minText = Math.min(minText, result.minText);
          minIcon = Math.min(minIcon, result.minIcon);
          for (const f of result.failures) failures.push(`${where}: ${f}`);
          regions[name] = {
            minText: Number(result.minText.toFixed(2)),
            minIcon: Number(result.minIcon.toFixed(2)),
            text: result.textCount,
            icons: result.iconCount,
          };
        }
        // Whatever else the PR surfaces render (composer chrome included).
        const rest = await page.evaluate(contrastAudit, PR_SCOPE);
        expect(rest.textCount, `${fixture} text measured`).toBeGreaterThan(0);
        for (const f of rest.failures) failures.push(`${fixture}: ${f}`);
        if (fixture === "stack") {
          // A row's menu.
          await page.keyboard.press("Tab");
          await page.keyboard.press("Enter");
          await expect(page.locator("[data-pr-row-menu]")).toBeVisible();
          await animationsDone(page);
          const menu = await page.evaluate(contrastAudit, "[role=menu] *");
          expect(menu.textCount, "row menu text measured").toBeGreaterThan(0);
          expect(menu.iconCount, "row menu icons measured").toBeGreaterThan(0);
          for (const f of menu.failures) failures.push(`${fixture} row menu: ${f}`);
          minText = Math.min(minText, menu.minText);
          minIcon = Math.min(minIcon, menu.minIcon);
          regions.rowMenu = {
            minText: Number(menu.minText.toFixed(2)),
            minIcon: Number(menu.minIcon.toFixed(2)),
            text: menu.textCount,
            icons: menu.iconCount,
          };
        }
        perFixture[fixture] = regions;
      }
      expect(Number.isFinite(minText) && Number.isFinite(minIcon)).toBe(true);
      test.info().annotations.push({
        type: `contrast minimum ${theme}`,
        description: `text ${minText.toFixed(2)}, icons ${minIcon.toFixed(2)}`,
      });
      recordMetrics(test.info().project.name, {
        [`contrast-${theme}`]: {
          minText: Number(minText.toFixed(2)),
          minIcon: Number(minIcon.toFixed(2)),
          byFixture: perFixture,
        },
      });
      expect([...new Set(failures)]).toEqual([]);
    });
  }
});

test.describe("targets", () => {
  test("every interactive element is at least 24x24", async ({ page }) => {
    const small: string[] = [];
    let min: Target | null = null;
    const counts: Record<string, number> = {};
    for (const fixture of FIXTURE_NAMES) {
      await load(page, { fixture });
      if (fixture !== "empty") await pin(page);
      if (fixture === "stack") {
        await page.keyboard.press("Tab");
        await page.keyboard.press("Enter");
        await expect(page.locator("[data-pr-row-menu]")).toBeVisible();
      }
      const result = await page.evaluate(targetAudit, PR_INTERACTIVE);
      expect(result.count, `${fixture} targets measured`).toBeGreaterThan(0);
      expect(result.min, `${fixture} smallest target`).not.toBeNull();
      counts[fixture] = result.count;
      for (const t of result.small) small.push(`${fixture}: ${t.w}x${t.h} ${t.label}`);
      if (result.min && (!min || Math.min(result.min.w, result.min.h) < Math.min(min.w, min.h)))
        min = result.min;
    }
    test.info().annotations.push({
      type: "smallest target",
      description: JSON.stringify(min),
    });
    recordMetrics(test.info().project.name, {
      smallestTarget: min,
      targetsMeasuredByFixture: counts,
    });
    expect([...new Set(small)]).toEqual([]);
  });
});

test.describe("audit self-test", () => {
  test("the contrast and target audits report a deliberately bad DOM", async ({ page }) => {
    await load(page);
    await page.evaluate(() => {
      const bad = document.createElement("div");
      bad.id = "audit-bad";
      bad.style.cssText =
        "position:fixed;top:0;left:0;z-index:9999;padding:8px;background:#808080";
      bad.innerHTML = `
        <span style="color:#8c8c8c">low contrast text</span>
        <span style="color:#000">good text</span>
        <span aria-hidden="true" style="color:#8c8c8c">decorative</span>
        <span style="color:#8c8c8c;opacity:0.01">invisible</span>
        <svg width="14" height="14" viewBox="0 0 14 14" style="color:#888">
          <circle cx="7" cy="7" r="6" stroke="currentColor" fill="none" />
        </svg>
        <button style="display:inline-block;width:10px;height:10px;padding:0;border:0;color:#000">x</button>
        <button style="display:inline-block;width:24px;height:24px;padding:0;border:0;color:#000">ok</button>`;
      document.body.appendChild(bad);
    });
    const contrast = await page.evaluate(contrastAudit, "#audit-bad *");
    // The aria-hidden and near-transparent spans are skipped by design.
    expect(contrast.textCount).toBe(4);
    expect(contrast.iconCount).toBe(1);
    expect(contrast.failures.some((f) => f.includes("low contrast text"))).toBe(true);
    expect(contrast.failures.some((f) => f.includes("[icon"))).toBe(true);
    expect(contrast.failures.some((f) => f.includes("good text"))).toBe(false);
    expect(contrast.minText).toBeLessThan(1.2);
    expect(contrast.minIcon).toBeLessThan(1.2);
    const targets = await page.evaluate(targetAudit, "#audit-bad button");
    expect(targets.count).toBe(2);
    expect(targets.small).toEqual([{ w: 10, h: 10, label: "x" }]);
    expect(targets.min).toEqual({ w: 10, h: 10, label: "x" });
  });
});

test.describe("keyboard and focus", () => {
  test("tab focus draws the 2px ring on the chip, rows, glyph and rail", async ({
    page,
  }) => {
    await load(page);
    await tabToChip(page);
    const ring = (selector: string) =>
      page.evaluate((s) => {
        const el = document.activeElement as HTMLElement;
        const cs = getComputedStyle(el);
        return {
          matches: el.matches(s),
          focusVisible: el.matches(":focus-visible"),
          width: cs.outlineWidth,
          style: cs.outlineStyle,
          offset: cs.outlineOffset,
        };
      }, selector);
    const expected = {
      matches: true,
      focusVisible: true,
      width: "2px",
      style: "solid",
      offset: "2px",
    };
    expect(await ring(".pr-chip")).toEqual(expected);
    await page.keyboard.press("Enter");
    await expect(firstRow(page)).toBeFocused();
    expect(await ring("[data-pr-row]")).toEqual(expected);
    await page.keyboard.press("Escape");
    await expect(chip(page)).toBeFocused();

    for (const selector of [
      "#sb-row .sb-glyph",
      "#panel [data-pr-row]",
      "#rail-3 .pr-rail-node",
    ]) {
      await tabTo(page, selector);
      expect(await ring(selector), selector).toEqual(expected);
    }
  });

  test("Esc closes a hover preview without taking focus", async ({ page }) => {
    await load(page);
    await chip(page).hover();
    await expect(card(page)).toBeVisible();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(
      true,
    );
    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(
      true,
    );
  });

  test("hover opens after the delay and closes after leaving", async ({ page }) => {
    await load(page);
    // Fake, paused timers: the delays are stepped exactly, independent of
    // load (an installed clock still flows until paused).
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 5_000);
    await chip(page).hover();
    await page.clock.runFor(219);
    await settle(page);
    expect(await card(page).count(), "chip card at 219ms").toBe(0);
    await page.clock.runFor(1);
    await expect(card(page)).toBeVisible();
    await page.mouse.move(1200, 20);
    await page.clock.runFor(99);
    await settle(page);
    expect(await card(page).count(), "card 99ms after leaving").toBe(1);
    await page.clock.runFor(1);
    await expect(card(page)).toHaveCount(0);
    // The sidebar waits 400ms.
    await page.locator("#sb-row .sb-glyph").hover();
    await page.clock.runFor(399);
    await settle(page);
    expect(await card(page).count(), "sidebar card at 399ms").toBe(0);
    await page.clock.runFor(1);
    await expect(card(page)).toBeVisible();
    const side = await page.evaluate(
      () =>
        document.querySelector('[role="dialog"].pr-card')!.getAttribute("data-popover-side"),
    );
    expect(side).toBe("right");
  });

  test("Esc closes a pinned card and returns focus to the chip", async ({ page }) => {
    await load(page);
    await pin(page);
    await expect(page.locator('[role="dialog"] [data-pr-row][tabindex="0"]')).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
    await expect(chip(page)).toBeFocused();
  });

  test("Tab past the last stop returns focus to the chip", async ({ page }) => {
    await load(page);
    await tabToChip(page);
    await page.keyboard.press("Enter");
    await expect(firstRow(page)).toBeFocused();
    let presses = 0;
    while ((await card(page).count()) > 0 && presses < 40) {
      await page.keyboard.press("Tab");
      presses += 1;
    }
    await expect(card(page)).toHaveCount(0);
    await expect(chip(page)).toBeFocused();
    // Shift+Tab from the first row closes it the other way.
    await page.keyboard.press("Enter");
    await expect(firstRow(page)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(card(page)).toHaveCount(0);
    await expect(chip(page)).toBeFocused();
  });

  test("Esc in a row menu closes only the menu", async ({ page }) => {
    await load(page);
    await tabToChip(page);
    await page.keyboard.press("Enter");
    await expect(firstRow(page)).toBeFocused();
    await page.keyboard.press("Tab");
    expect(await activeLabel(page)).toBe("More actions for PR 482");
    await page.keyboard.press("Enter");
    const menu = page.locator("[data-pr-row-menu]");
    await expect(menu).toBeVisible();
    await expect(menu.locator('[role="menuitem"]').first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(card(page)).toBeVisible();
    expect(await activeLabel(page)).toBe("More actions for PR 482");
    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
    await expect(chip(page)).toBeFocused();
  });

  test("the panel's split menu takes focus; Esc returns it to the caret", async ({
    page,
  }) => {
    await load(page);
    await tabTo(page, '#panel button[aria-label="More pull requests"]');
    await page.keyboard.press("Enter");
    const menu = page.locator("[data-pr-split-menu]");
    await expect(menu.locator('[role="menuitem"]').first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.locator('[role="menuitem"]').nth(1)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(page.locator('#panel button[aria-label="More pull requests"]')).toBeFocused();
  });

  test("rows rove with arrows, Home and End as one tab stop", async ({ page }) => {
    await load(page);
    await pin(page);
    const focusedNumber = () =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        return {
          n: el.querySelector(".pr-n")?.textContent,
          stops: [...document.querySelectorAll('[role="dialog"] [data-pr-row]')].filter(
            (r) => (r as HTMLElement).tabIndex === 0,
          ).length,
        };
      });
    expect(await focusedNumber()).toEqual({ n: "#482", stops: 1 });
    await page.keyboard.press("ArrowDown");
    expect(await focusedNumber()).toEqual({ n: "#480", stops: 1 });
    await page.keyboard.press("End");
    expect(await focusedNumber()).toEqual({ n: "#486", stops: 1 });
    await page.keyboard.press("Home");
    expect(await focusedNumber()).toEqual({ n: "#482", stops: 1 });
    await page.keyboard.press("ArrowUp");
    expect(await focusedNumber()).toEqual({ n: "#486", stops: 1 });

    // The Changes panel list too.
    await page.keyboard.press("Escape");
    const panelRow = page.locator("#panel [data-pr-row]").first();
    await panelRow.focus();
    await page.keyboard.press("ArrowDown");
    const second = await page.evaluate(
      () => (document.activeElement as HTMLElement).querySelector(".pr-n")?.textContent,
    );
    expect(second).toBe("#480");
    await page.keyboard.press("End");
    expect(
      await page.evaluate(
        () => [...document.querySelectorAll("#panel [data-pr-row]")].pop() === document.activeElement,
      ),
    ).toBe(true);
  });
});

test.describe("modes and states", () => {
  test("forced colors keep a visible Highlight focus ring", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "forced-colors emulation is Chromium only");
    await page.emulateMedia({ forcedColors: "active" });
    await load(page, { fixture: "stale" });
    const highlight = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.color = "Highlight";
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    const ring = () =>
      page.evaluate(() => {
        const cs = getComputedStyle(document.activeElement!);
        return { width: cs.outlineWidth, style: cs.outlineStyle, color: cs.outlineColor };
      });
    await tabToChip(page);
    expect(await ring()).toEqual({ width: "2px", style: "solid", color: highlight });
    await page.keyboard.press("Enter");
    await expect(firstRow(page)).toBeFocused();
    expect(await ring()).toEqual({ width: "2px", style: "solid", color: highlight });
    await page.keyboard.press("Escape");
    // The stale sidebar glyph swaps its dashed outline for the ring.
    await tabTo(page, "#sb-row .sb-glyph");
    expect(await ring()).toEqual({ width: "2px", style: "solid", color: highlight });
  });

  test("reduced motion drops the card's open animation", async ({ page }) => {
    await load(page);
    await chip(page).click();
    await expect(card(page)).toBeVisible();
    expect(await card(page).evaluate((el) => getComputedStyle(el).animationName)).toBe(
      "popover-open",
    );
    await page.keyboard.press("Escape");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await chip(page).click();
    await expect(card(page)).toBeVisible();
    expect(await card(page).evaluate((el) => getComputedStyle(el).animationName)).toBe(
      "none",
    );
  });

  for (const theme of THEMES) {
    test(`icon halos match their row's fill, ${theme}`, async ({ page }) => {
      await load(page, { theme });
      await pin(page);
      await page.locator("#panel .pr-row").nth(2).hover();
      const gaps = await page.evaluate(() => {
        // Paint the row fill and the halo over the page ground; compare.
        const cv = document.createElement("canvas").getContext("2d")!;
        const paint = (...layers: string[]) => {
          cv.clearRect(0, 0, 1, 1);
          for (const fill of layers) {
            cv.fillStyle = fill;
            cv.fillRect(0, 0, 1, 1);
          }
          return [...cv.getImageData(0, 0, 1, 1).data.slice(0, 3)];
        };
        const ground = getComputedStyle(document.body).backgroundColor;
        const out: { where: string; gap: number }[] = [];
        const rows = [
          ['#panel .pr-row[data-selected="true"]', "selected"],
          ["#panel .pr-row:hover", "hover"],
        ];
        for (const [selector, where] of rows) {
          const row = document.querySelector(selector)!;
          const halo = getComputedStyle(row.querySelector(".pr-ico")!, "::before");
          const a = paint(ground, getComputedStyle(row).backgroundColor);
          const b = paint(ground, halo.backgroundColor);
          out.push({ where, gap: Math.max(...a.map((v, i) => Math.abs(v - b[i]))) });
        }
        return out;
      });
      for (const { where, gap } of gaps) expect(gap, where).toBeLessThanOrEqual(2);
    });
  }

  test("stale status keeps full opacity", async ({ page }) => {
    await load(page, { fixture: "stale" });
    await pin(page);
    const dimmed = await page.evaluate(() => {
      const out: string[] = [];
      const els = document.querySelectorAll(
        "[data-pr-stale], .pr-stale, .sb-glyph[data-stale], .pr-card-updated[data-stale], .pr-chip",
      );
      for (const el of els) {
        let o = 1;
        for (let e: Element | null = el; e; e = e.parentElement)
          o *= Number(getComputedStyle(e).opacity);
        if (o < 1) out.push(`${el.className} ${o}`);
      }
      return { count: els.length, out };
    });
    expect(dimmed.count).toBeGreaterThan(5);
    expect(dimmed.out).toEqual([]);
  });

  test("no console errors across fixtures, themes and interactions", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    for (const theme of THEMES) {
      for (const fixture of FIXTURE_NAMES) {
        await load(page, { fixture, theme });
        if (fixture === "empty") continue;
        await pin(page);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Escape");
        await page.locator("#sb-row-neighbor .sb-glyph").hover();
        await expect(card(page)).toBeVisible();
        await page.keyboard.press("Escape");
      }
    }
    // Hide and undo through the real store and event path.
    await load(page);
    await pin(page);
    await page.keyboard.press("Backspace");
    await expect(card(page).locator(".pr-undo")).toBeVisible();
    await expect(card(page).locator(".pr-card-title")).toHaveText(
      "5 pull requests from this chat",
    );
    await card(page).locator(".pr-undo").click();
    await expect(card(page).locator(".pr-card-title")).toHaveText(
      "6 pull requests from this chat",
    );
    expect(errors).toEqual([]);
  });
});

// ------------------------------------------------------------ measurements

type Metrics = Record<string, unknown>;

async function measure(page: Page): Promise<Metrics> {
  const metrics: Metrics = {};
  const loads: number[] = [];
  for (let i = 0; i < 5; i++) {
    await load(page);
    loads.push(
      await page.evaluate(
        () => performance.getEntriesByName("harness-ready")[0]?.startTime ?? -1,
      ),
    );
  }
  loads.sort((a, b) => a - b);
  metrics.harnessReadyMsMedian = Math.round(loads[2]);
  metrics.harnessReadyMs = loads.map(Math.round);
  metrics.domNodesPage = await page.evaluate(
    () => document.getElementsByTagName("*").length,
  );

  // Card open-to-paint: click, two frames, Esc; 20 runs (ported hover.js).
  metrics.cardOpenToPaint = await page.evaluate(async () => {
    const trigger = document.querySelector<HTMLElement>("#composer .pr-chip")!;
    const t: number[] = [];
    for (let i = 0; i < 20; i++) {
      const s = performance.now();
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      t.push(performance.now() - s);
      if (!document.querySelector('[role="dialog"].pr-card')) throw new Error("no card");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((r) => requestAnimationFrame(r));
    }
    t.sort((a, b) => a - b);
    return {
      medianMs: Math.round(t[10] * 10) / 10,
      p95Ms: Math.round(t[18] * 10) / 10,
      note: "includes two rAF waits (~33ms floor at 60Hz)",
    };
  });

  await load(page);
  await pin(page);
  metrics.domNodesStackCard = await page.evaluate(
    () => document.querySelector('[role="dialog"].pr-card')!.getElementsByTagName("*").length,
  );

  await load(page, { fixture: "many" });
  await pin(page);
  metrics.domNodes40PrCard = await page.evaluate(
    () => document.querySelector('[role="dialog"].pr-card')!.getElementsByTagName("*").length,
  );
  // Scroll the 40-PR card body every frame (ported scroll.js).
  metrics.scroll40PrCard = await page.evaluate(async () => {
    const body = document.querySelector<HTMLElement>('[role="dialog"] .pr-card-body')!;
    const deltas: number[] = [];
    let last = performance.now();
    let run = true;
    const tick = (t: number) => {
      deltas.push(t - last);
      last = t;
      if (run) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const max = body.scrollHeight - body.clientHeight;
    for (let i = 0; i <= 60; i++) {
      body.scrollTop = (i % 2 ? max : 0) * ((i % 10) / 10);
      await new Promise((r) => requestAnimationFrame(r));
    }
    run = false;
    deltas.shift();
    deltas.sort((a, b) => a - b);
    const p = (q: number) => Math.round(deltas[Math.floor(deltas.length * q)] * 10) / 10;
    return { frames: deltas.length, p50Ms: p(0.5), p95Ms: p(0.95), maxMs: p(0.999) };
  });
  return metrics;
}

test.describe("measurements", () => {
  test("load, open-to-paint, scroll and DOM size", async ({ page, browserName }) => {
    test.setTimeout(90_000);
    const metrics = await measure(page);
    const scroll = metrics.scroll40PrCard as { p95Ms: number };
    const open = metrics.cardOpenToPaint as { medianMs: number };
    // Timing bounds only on a deliberate evidence run (PR_EVIDENCE=1), so a
    // loaded CI host cannot fail the suite; loose, to catch pathologies.
    if (evidence) {
      expect(open.medianMs).toBeLessThan(100);
      expect(scroll.p95Ms).toBeLessThan(50);
    }
    expect(metrics.domNodes40PrCard as number).toBeLessThan(2000);
    recordMetrics(browserName, metrics);
    test.info().annotations.push({ type: "metrics", description: JSON.stringify(metrics) });
  });
});

// --------------------------------------------------------------- evidence

test.describe("evidence screenshots", () => {
  test.skip(!evidence, "PR_EVIDENCE=1 writes screenshots");
  test.use({ deviceScaleFactor: 2 });

  const shot = async (page: Page, name: string, selectors: string[], pad = 8) => {
    const box = await page.evaluate(
      ({ selectors, pad }) => {
        const rects = selectors
          .map((s) => document.querySelector(s))
          .filter((el): el is Element => !!el)
          .map((el) => el.getBoundingClientRect());
        const left = Math.max(0, Math.min(...rects.map((r) => r.left)) - pad);
        const top = Math.max(0, Math.min(...rects.map((r) => r.top)) - pad);
        const right = Math.min(innerWidth, Math.max(...rects.map((r) => r.right)) + pad);
        const bottom = Math.min(innerHeight, Math.max(...rects.map((r) => r.bottom)) + pad);
        return { x: left, y: top, width: right - left, height: bottom - top };
      },
      { selectors, pad },
    );
    mkdirSync(EVIDENCE, { recursive: true });
    await page.screenshot({ path: `${EVIDENCE}/${name}.png`, clip: box });
  };
  const frameOf = async (page: Page) => {
    await page.evaluate(() =>
      document.querySelector('[role="dialog"].pr-card')!.parentElement!.setAttribute(
        "data-shot",
        "card",
      ),
    );
    return '[data-shot="card"]';
  };

  for (const theme of THEMES) {
    test(`screenshots, ${theme}`, async ({ page, browserName }) => {
      test.setTimeout(120_000);
      await page.emulateMedia({ reducedMotion: "reduce" });
      if (browserName !== "chromium") {
        // A WebKit cross-check of the main surfaces, prefixed by engine.
        await load(page, { theme });
        await pin(page);
        await shot(page, `${browserName}-${theme}-composer-chip-pinned`, [
          "#composer",
          await frameOf(page),
        ]);
        await page.keyboard.press("Escape");
        await shot(page, `${browserName}-${theme}-changes-panel-section`, ["#panel"]);
        await shot(page, `${browserName}-${theme}-inbox-rails-3-6-12-health`, ["#inbox"]);
        await load(page, { theme, w: 360 });
        await shot(page, `${browserName}-${theme}-composer-narrow-360`, ["#composer"]);
        return;
      }
      await load(page, { theme });
      await shot(page, `${theme}-composer-chip-closed`, ["#composer"]);
      await chip(page).hover();
      await expect(card(page)).toBeVisible();
      await shot(page, `${theme}-composer-chip-hover`, ["#composer", await frameOf(page)]);
      await page.mouse.move(1270, 10);
      await expect(card(page)).toHaveCount(0);
      await pin(page);
      await shot(page, `${theme}-composer-chip-pinned`, ["#composer", await frameOf(page)]);
      await page.keyboard.press("Escape");

      await shot(page, `${theme}-sidebar-glyph-rows`, ["#sidebar"]);
      await page.locator("#sb-row .sb-glyph").hover();
      await expect(card(page)).toBeVisible();
      await shot(page, `${theme}-sidebar-glyph-hover`, ["#sidebar", await frameOf(page)]);
      await page.keyboard.press("Escape");
      await shot(page, `${theme}-changes-panel-section`, ["#panel"]);
      await shot(page, `${theme}-inbox-rails-3-6-12-health`, ["#inbox"]);
      await page.evaluate(() =>
        (
          window as unknown as { harness: { setInboxWidth(n: number): void } }
        ).harness.setInboxWidth(420),
      );
      await frames(page);
      await shot(page, `${theme}-inbox-rails-narrow-420`, ["#inbox"]);

      await load(page, { theme, w: 360 });
      await shot(page, `${theme}-composer-narrow-360`, ["#composer"]);
      await load(page, { theme, w: 300 });
      await shot(page, `${theme}-composer-narrow-300`, ["#composer"]);

      for (const fixture of ["ok", "ghMissing", "signedOut", "offline", "idle", "rateLimited"]) {
        await load(page, { theme, fixture });
        await pin(page);
        await shot(page, `${theme}-card-status-${fixture}`, [await frameOf(page)], 2);
      }
      for (const fixture of ["many", "i18n", "stale", "limited", "neighbor"]) {
        await load(page, { theme, fixture });
        await pin(page);
        await shot(page, `${theme}-card-${fixture}`, [await frameOf(page)], 2);
      }
      await load(page, { theme, fixture: "hidden" });
      await shot(page, `${theme}-composer-all-hidden-chip`, ["#composer"]);
    });
  }
});
