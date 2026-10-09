import { expect, test, type Page } from "@playwright/test";
import { freezeTransitions, measure, THEMES, type Counts } from "./contrast";

// Accessibility regression guard for the Tasks panel. The fixture renders the real
// TasksPanel at sidebar width; every theme x palette x status-card state is
// measured by compositing text and glyphs over their real backgrounds (canvas
// resolves color-mix and alpha, so the numbers are what the user sees).

const STATES = ["needs-you", "struggling", "quiet", "running", "done", "failed check", "blocked build", "finished", "many problems", "no steps"] as const;
const WIDTHS = [240, 340, 480];

const FLOW_LIST = 'ol[aria-label="Superpowers flow"]';

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
        // The overview block is part of what was measured, not a bystander.
        await expect(page.locator("[data-counts]")).toBeVisible();
        await expect(page.locator("[data-strip]")).toBeVisible();
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

const STRIP = "[data-strip]";
const PILLS = "[data-problems] button";

/** The text of each problem button, without its glyph. */
const pillTexts = (page: Page) => page.locator(PILLS).evaluateAll((els) => els.map((el) => (el.lastElementChild ?? el).textContent));

test.describe("tasks panel overview", () => {
  test("says the counts, the time and the strip in words", async ({ page }) => {
    await show(page, "dark", "default", "running");
    await expect(page.locator("[data-counts]")).toHaveText("3 of 7 tasks · 5 left · 14 of 31 steps");
    await expect(page.locator("[data-time]")).toHaveText("50m so far · about 40m left");
    const strip = page.locator(STRIP);
    await expect(strip).toHaveAttribute("role", "img");
    await expect(strip).toHaveAttribute("aria-label", "3 done, 1 running, 1 needs a look, 1 blocked, 2 not started");
  });

  test("leaves steps out when the plan file was not read", async ({ page }) => {
    await show(page, "dark", "default", "no steps");
    await expect(page.locator("[data-counts]")).toHaveText("3 of 7 tasks · 5 left");
  });

  test("a finished plan says its totals and has no problems row", async ({ page }) => {
    await show(page, "dark", "default", "finished");
    await expect(page.locator("[data-counts]")).toHaveText("6 of 6 tasks · 31 steps");
    await expect(page.locator("[data-problems]")).toHaveCount(0);
    await expect(page.locator(STRIP)).toHaveAttribute("aria-label", "7 done");
  });

  for (const theme of ["dark", "light"] as const) {
    test(`${theme}: the strip has one 6px segment per task and the final review, 2px apart, in status colours`, async ({ page }) => {
      await show(page, theme, "default", "running");
      const segs = await page.locator(`${STRIP} > span`).evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return { status: el.getAttribute("data-status"), left: r.left, right: r.right, width: r.width, height: r.height, bg: cs.backgroundColor, radius: cs.borderTopLeftRadius };
        }),
      );
      expect(segs.map((x) => x.status)).toEqual(["done", "done", "done", "running", "attention", "blocked", "pending", "pending"]);
      for (const seg of segs) {
        expect(seg.height).toBeCloseTo(6, 0);
        expect(seg.width, "segment width").toBeGreaterThan(8);
        expect(parseFloat(seg.radius)).toBeGreaterThanOrEqual(3);
      }
      for (let i = 1; i < segs.length; i++) expect(segs[i].left - segs[i - 1].right).toBeCloseTo(2, 0);
      for (const seg of segs) expect(seg.width).toBeCloseTo(segs[0].width, 0);
      const color = (status: string) => segs.find((x) => x.status === status)!.bg;
      const distinct = new Set(["done", "running", "attention", "blocked", "pending"].map(color));
      expect(distinct.size, "status colours are told apart").toBe(5);
      // Not started is a faint track: it must not look like any status colour.
      expect(color("pending")).not.toBe(color("done"));
    });
  }

  test("lists the tasks in trouble in plan order", async ({ page }) => {
    await show(page, "dark", "default", "running");
    expect(await pillTexts(page)).toEqual(["Task 5 · fix 3 of 5", "Task 6 · blocked"]);
    await expect(page.locator("[data-problems]")).toContainText("Needs a look");
  });

  test("shows three problems and folds the rest into +2 more, which expands in place", async ({ page }) => {
    await show(page, "dark", "default", "many problems");
    expect(await pillTexts(page)).toEqual(["Task 3 · failed", "Task 4 · blocked", "Task 5 · fix 4 of 5", "+2 more"]);
    const more = page.locator(PILLS).last();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    const before = await page.locator("[data-problems]").boundingBox();
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    expect(await pillTexts(page)).toEqual(["Task 3 · failed", "Task 4 · blocked", "Task 5 · fix 4 of 5", "Task 6 · blocked", "Task 7 · fix 3 of 5", "Show fewer"]);
    const after = await page.locator("[data-problems]").boundingBox();
    expect(after!.y, "the row grows downward and does not move").toBe(before!.y);
  });

  test("a problem button opens its task and moves focus to the task's row", async ({ page }) => {
    await show(page, "dark", "default", "running");
    await page.locator(PILLS, { hasText: "Task 6" }).click();
    const focused = await page.evaluate(() => {
      const item = document.activeElement?.closest('[role="treeitem"]');
      return item ? { text: item.textContent, expanded: item.getAttribute("aria-expanded") } : undefined;
    });
    expect(focused?.text).toContain("Step 6 title");
  });

  test("a problem button can be reached and pressed with the keyboard", async ({ page }) => {
    await show(page, "dark", "default", "running");
    const pill = page.locator(PILLS).first();
    // Tab to it: only keyboard focus shows the ring.
    for (let i = 0; i < 40 && !(await pill.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(pill).toBeFocused();
    const ring = await pill.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { width: cs.outlineWidth, style: cs.outlineStyle };
    });
    expect(ring.style).not.toBe("none");
    expect(parseFloat(ring.width)).toBeGreaterThanOrEqual(2);
  });
});

test.describe("tasks panel overview widths", () => {
  for (const width of WIDTHS) {
    for (const theme of ["dark", "light"] as const) {
      for (const state of ["running", "many problems", "no steps"]) {
        test(`${width}px ${theme} ${state}: the overview stays inside the column`, async ({ page }) => {
          await page.goto("/tests/browser/tasks-panel.html");
          await freezeTransitions(page);
          await page.evaluate(([w, t, st]) => {
            document.getElementById("root")!.style.width = `${w}px`;
            window.setTheme(t as "dark");
            window.showTasks(st);
          }, [width, theme, state]);
          await page.locator(STRIP).waitFor();
          await openEverything(page);
          const box = await page.evaluate(() => {
            const column = document.getElementById("root")!.getBoundingClientRect();
            const parts = ["[data-counts]", "[data-time]", "[data-strip]", "[data-problems]"].map((sel) => document.querySelector(sel));
            const rects = [...parts.filter(Boolean), ...Array.from(document.querySelectorAll("[data-problems] button"))].map((el) => el!.getBoundingClientRect());
            const text = ["[data-counts]", "[data-time]"].map((sel) => {
              const el = document.querySelector(sel) as HTMLElement | null;
              if (!el) return { lines: 0, scroll: 0, client: 0 };
              return { lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)), scroll: el.scrollWidth, client: el.clientWidth };
            });
            const scroller = document.getElementById("root")!.firstElementChild as HTMLElement;
            return { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)), column: { left: column.left, right: column.right }, text, scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth };
          });
          expect(box.left).toBeGreaterThanOrEqual(box.column.left - 0.5);
          expect(box.right).toBeLessThanOrEqual(box.column.right + 0.5);
          expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
          for (const t of box.text) expect(t.scroll).toBeLessThanOrEqual(t.client);
          // The counts line may wrap at 240px but never into more than two lines.
          expect(box.text[0].lines).toBeLessThanOrEqual(2);
        });
      }
    }
  }
});
