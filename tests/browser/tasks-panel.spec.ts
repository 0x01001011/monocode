import { expect, test, type Page } from "@playwright/test";

// Accessibility regression guard for the Tasks panel. The fixture renders the real
// TasksPanel at sidebar width; every theme x palette x status-card state is
// measured by compositing text and glyphs over their real backgrounds (canvas
// resolves color-mix and alpha, so the numbers are what the user sees).

const STATES = ["needs-you", "struggling", "quiet", "running", "done", "failed check", "blocked build", "finished"] as const;
const THEMES: [theme: "dark" | "light", palette: "default" | "colorblind" | "high-contrast"][] = [
  ["dark", "default"],
  ["light", "default"],
  ["dark", "colorblind"],
  ["light", "colorblind"],
  ["dark", "high-contrast"],
  ["light", "high-contrast"],
];
const WIDTHS = [240, 340, 480];

type Failure = { kind: string; what: string; got: number; need: number };
/** What a measurement looked at, so a run that found nothing cannot pass for a clean one. */
type Counts = { textNodes: number; glyphs: number; phases: number; rootChildren: number };
type Measured = { failures: Failure[]; counts: Counts };

const FLOW_LIST = 'ol[aria-label="Superpowers flow"]';

// Colors are measured at rest: a theme switch must not be caught mid-transition.
async function freezeTransitions(page: Page) {
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
}

async function openEverything(page: Page) {
  // Open the legend, the note sections and every collapsed tree row so each text node exists.
  await page.evaluate(() => {
    for (let pass = 0; pass < 3; pass++) {
      for (const el of Array.from(document.querySelectorAll('button[aria-expanded="false"]'))) (el as HTMLElement).click();
      for (const row of Array.from(document.querySelectorAll('[role="treeitem"][aria-expanded="false"] > [data-row]'))) {
        (row as HTMLElement).click();
      }
    }
  });
  // "Show all N" reveals the notes beyond the preview.
  await page.evaluate(() => {
    for (const b of Array.from(document.querySelectorAll("button"))) if (/^Show all/.test(b.textContent ?? "")) b.click();
  });
  await page.waitForTimeout(60);
}

/** Measures the whole panel, or only the element matching `scope` (for states like hover). */
function measure(page: Page, scope?: string): Promise<Measured> {
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
        rootChildren: panel.childElementCount,
      },
    };
  }, scope);
}

/** A measurement that saw the real panel: enough text, glyphs and flow phases to mean something. */
function expectSubstantial(counts: Counts, scoped = false) {
  expect(counts.rootChildren, "the panel root is empty").toBeGreaterThan(0);
  expect(counts.phases, "flow phases").toBeGreaterThanOrEqual(4);
  if (scoped) {
    expect(counts.textNodes, "text nodes").toBeGreaterThanOrEqual(1);
    return;
  }
  expect(counts.textNodes, "text nodes").toBeGreaterThanOrEqual(20);
  expect(counts.glyphs, "glyphs").toBeGreaterThanOrEqual(5);
}

async function show(page: Page, theme: "dark" | "light", palette: "default" | "colorblind" | "high-contrast", state: string) {
  await page.goto("/tests/browser/tasks-panel.html");
  await freezeTransitions(page);
  await page.evaluate(
    ([t, p, st]) => {
      window.setTheme(t as "dark", p as "default");
      window.showTasks(st);
    },
    [theme, palette, state],
  );
  await page.locator(FLOW_LIST).waitFor();
}

test.describe("tasks panel accessibility", () => {
  for (const [theme, palette] of THEMES) {
    for (const state of STATES) {
      test(`${theme} ${palette} ${state}`, async ({ page }, testInfo) => {
        await show(page, theme, palette, state);
        await openEverything(page);
        const { failures, counts } = await measure(page);
        testInfo.annotations.push({ type: "failures", description: String(failures.length) });
        expectSubstantial(counts);
        expect(failures).toEqual([]);
      });
    }
  }

  test("an unknown state fails loudly instead of rendering a stale panel", async ({ page }) => {
    await page.goto("/tests/browser/tasks-panel.html");
    await expect(page.evaluate(() => window.showTasks("no such state"))).rejects.toThrow(/Unknown tasks panel state/);
  });
});

// The Spec and Plan buttons change background on hover: measure their text on that background.
test.describe("tasks panel flow buttons on hover", () => {
  for (const [theme, palette] of THEMES) {
    for (const name of ["Spec", "Plan"]) {
      test(`${theme} ${palette} ${name}`, async ({ page }) => {
        await show(page, theme, palette, "running");
        const button = page.locator(`${FLOW_LIST} button`, { hasText: name });
        await expect(button).toHaveCount(1);
        const background = () => button.evaluate((el) => getComputedStyle(el).backgroundColor);
        const resting = await background();
        await button.hover();
        const hovered = await background();
        expect(hovered, "the hover background applies").not.toBe(resting);
        const tag = await button.evaluate((el) => {
          el.setAttribute("data-measure", "hovered");
          return el.matches(":hover");
        });
        expect(tag, "the pointer is over the button").toBe(true);
        const { failures, counts } = await measure(page, "[data-measure=hovered]");
        expectSubstantial(counts, true);
        expect(failures).toEqual([]);
      });
    }
  }
});

test.describe("tasks panel flow strip", () => {
  const phases = (page: Page) => page.getByRole("list", { name: "Superpowers flow" }).getByRole("listitem");

  test("is measured: four phases, the running one is current, spec and plan are buttons", async ({ page }) => {
    await show(page, "dark", "default", "running");
    const list = page.getByRole("list", { name: "Superpowers flow" });
    await expect(list.getByRole("listitem")).toHaveCount(4);
    await expect(list.locator('[aria-current="step"]')).toContainText("Build");
    await expect(list.getByRole("button")).toHaveText(["Spec", "Plan"]);
  });

  test("the failed check variant shows the failed glyph and its detail", async ({ page }) => {
    await show(page, "dark", "default", "failed check");
    await expect(phases(page).nth(3)).toContainText("tests failed 2m ago");
    await expect(phases(page).nth(3).getByRole("img", { name: "failed" })).toBeVisible();
    await expect(phases(page).nth(2).getByRole("img", { name: "struggling" })).toBeVisible();
  });

  test("the blocked build variant shows the blocked glyph and keeps Build current", async ({ page }) => {
    await show(page, "dark", "default", "blocked build");
    await expect(phases(page).nth(2).getByRole("img", { name: "blocked" })).toBeVisible();
    await expect(page.locator(`${FLOW_LIST} [aria-current="step"]`)).toContainText("Build");
  });

  test("the finished variant is done across the board and has no current step", async ({ page }) => {
    await show(page, "dark", "default", "finished");
    await expect(phases(page).nth(3)).toContainText("tests passed 4m ago, final review done");
    for (let i = 0; i < 4; i++) await expect(phases(page).nth(i).getByRole("img", { name: "done" })).toBeVisible();
    await expect(page.locator(`${FLOW_LIST} [aria-current="step"]`)).toHaveCount(0);
  });
});

test.describe("tasks panel widths", () => {
  for (const width of WIDTHS) {
    for (const theme of ["dark", "light"] as const) {
      test(`${width}px ${theme} does not scroll sideways`, async ({ page }) => {
        await page.goto("/tests/browser/tasks-panel.html");
        await freezeTransitions(page);
        await page.evaluate(([w, t]) => {
          // setViewportSize does not resize #root; the fixture column is fixed-width.
          document.getElementById("root")!.style.width = `${w}px`;
          window.setTheme(t as "dark");
          window.showTasks("needs-you");
        }, [width, theme]);
        await page.locator(FLOW_LIST).waitFor();
        await openEverything(page);
        const over = await page.evaluate(() => {
          const scroller = document.getElementById("root")!.firstElementChild as HTMLElement;
          return { scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth };
        });
        expect(over.scrollWidth).toBeLessThanOrEqual(over.clientWidth);
        expect(over.clientWidth).toBeGreaterThan(0);

        // The flow strip wraps onto more lines instead of running past the column.
        const strip = await page.evaluate(() => {
          const list = document.querySelector('ol[aria-label="Superpowers flow"]');
          const column = document.getElementById("root")!.getBoundingClientRect();
          const items = Array.from(list?.querySelectorAll("li") ?? []).map((li) => li.getBoundingClientRect());
          return {
            count: items.length,
            right: Math.max(...items.map((r) => r.right)),
            left: Math.min(...items.map((r) => r.left)),
            columnLeft: column.left,
            columnRight: column.right,
            scrollWidth: list?.scrollWidth ?? 0,
            clientWidth: list?.clientWidth ?? 0,
          };
        });
        expect(strip.count).toBe(4);
        expect(strip.right).toBeLessThanOrEqual(strip.columnRight + 0.5);
        expect(strip.left).toBeGreaterThanOrEqual(strip.columnLeft - 0.5);
        expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth);
      });
    }
  }
});
