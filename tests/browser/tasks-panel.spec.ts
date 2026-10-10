import { expect, test, type Page } from "@playwright/test";
import { measure, overflowFailures, THEMES, type Counts, type Failure } from "./contrast";
import { FLOW_LIST, measureAt, openEverything, openFixture, render, show, WIDTHS } from "./tasks-fixture";

// Accessibility regression guard for the Tasks panel. The fixture renders the real TasksPanel
// (status card, pipeline header, filter, commit graph, Ship checklist, note groups) at sidebar
// width; every theme x palette x state is measured at 240, 340 and 480 px by compositing text,
// glyphs and the graph gutter's lines and nodes over their real backgrounds (canvas resolves
// color-mix and alpha, so the numbers are what the user sees), plus targets and overflow.

const STATES = ["running", "problems", "ready", "deferred", "workers", "done-no-final", "many problems", "no steps", "needs-you", "quiet"] as const;

/** A measurement that saw the real panel: enough text, glyphs, rows, gutter shapes and flow phases. */
function expectSubstantial(counts: Counts, scoped = false) {
  expect(counts.rootChildren, "the panel root is empty").toBeGreaterThan(0);
  expect(counts.phases, "flow phases").toBeGreaterThanOrEqual(4);
  if (scoped) {
    expect(counts.textNodes, "text nodes").toBeGreaterThanOrEqual(1);
    return;
  }
  expect(counts.textNodes, "text nodes").toBeGreaterThanOrEqual(20);
  expect(counts.glyphs, "glyphs").toBeGreaterThanOrEqual(5);
  expect(counts.rows, "graph rows").toBeGreaterThanOrEqual(6);
  expect(counts.gutterNodes, "graph nodes").toBeGreaterThanOrEqual(6);
  expect(counts.gutterLines, "graph lines").toBeGreaterThanOrEqual(5);
}

test.describe("tasks panel accessibility", () => {
  for (const [theme, palette] of THEMES) {
    for (const state of STATES) {
      test(`${theme} ${palette} ${state}`, async ({ page }, testInfo) => {
        await show(page, theme, palette, state);
        await openEverything(page);
        const failures: Failure[] = [];
        for (const width of WIDTHS) {
          const result = await measureAt(page, width);
          expectSubstantial(result.counts);
          failures.push(...result.failures);
        }
        testInfo.annotations.push({ type: "failures", description: String(failures.length) });
        expect(failures).toEqual([]);
        // The overview block is part of what was measured, not a bystander.
        await expect(page.locator("[data-counts]")).toBeVisible();
        await expect(page.locator("[data-strip]")).toBeVisible();
      });
    }
  }

  test("the board tab is gone: no Open as tab button in any state", async ({ page }) => {
    await openFixture(page);
    for (const state of STATES) {
      await render(page, state);
      await openEverything(page);
      await expect(page.getByRole("button", { name: /open as tab/i }), state).toHaveCount(0);
    }
  });

  test("an unknown state fails loudly instead of rendering a stale panel", async ({ page }) => {
    await openFixture(page);
    await expect(page.evaluate(() => window.showTasks("no such state"))).rejects.toThrow(/Unknown tasks panel state/);
  });
});

// The measurement itself: it must see the graph's lines and nodes, or a green run proves nothing.
test.describe("tasks panel graph gutter is measured", () => {
  test("the forked task draws its fork and merge curves, and both are checked at 3:1", async ({ page }) => {
    await show(page, "dark", "default", "running");
    // Click the gutter: the row's middle holds an action button while hovered.
    await page.locator('[role="treeitem"][data-row-id="task-2"] > [data-row]').click({ position: { x: 10, y: 8 } });
    await expect(page.locator('[data-row-id="task-2:merge"]')).toHaveCount(1);
    const curves = await page.locator('[role="tree"] [data-curve]').count();
    expect(curves, "a fork and a merge curve").toBeGreaterThanOrEqual(2);
    const { failures, counts } = await measure(page);
    expect(counts.gutterLines).toBeGreaterThanOrEqual(curves);
    expect(failures.filter((f) => f.kind.startsWith("gutter"))).toEqual([]);
  });

  test("a line too faint for its row is flagged", async ({ page }) => {
    await show(page, "dark", "default", "running");
    // Paint one rail line the colour of the panel background: the checker must catch it.
    await page.evaluate(() => {
      const line = document.querySelector('[role="tree"] svg[data-gutter] [data-line]') as SVGElement;
      line.style.stroke = getComputedStyle(document.getElementById("root")!).backgroundColor;
    });
    const { failures } = await measure(page);
    expect(failures.some((f) => f.kind === "gutter line" && f.got < 1.5)).toBe(true);
  });

  test("a node too faint for its row is flagged", async ({ page }) => {
    await show(page, "dark", "default", "running");
    await page.evaluate(() => {
      const node = document.querySelector('[role="tree"] svg[data-gutter] circle[data-node]') as SVGElement;
      node.style.fill = getComputedStyle(document.getElementById("root")!).backgroundColor;
      node.style.stroke = "none";
    });
    const { failures } = await measure(page);
    expect(failures.some((f) => f.kind === "gutter node")).toBe(true);
  });

  for (const [theme, palette] of THEMES) {
    test(`${theme} ${palette}: worker lanes are measured`, async ({ page }) => {
      await show(page, theme, palette, "workers");
      const lanes = page.locator('[role="treeitem"][data-row-id^="worker:"]');
      await expect(lanes).toHaveCount(2);
      const { failures, counts } = await measure(page);
      expect(counts.gutterNodes).toBeGreaterThanOrEqual(6);
      expect(failures.filter((f) => f.kind.startsWith("gutter"))).toEqual([]);
    });
  }
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

// A hovered graph row tints its background and shows its actions: measure the row in that state.
test.describe("tasks panel graph row on hover", () => {
  for (const [theme, palette] of THEMES) {
    test(`${theme} ${palette}`, async ({ page }) => {
      await show(page, theme, palette, "running");
      const row = page.locator('[role="treeitem"][data-row-id="task-2"]');
      await row.locator("[data-row]").hover();
      await expect(row.locator("[data-actions] button").first()).toBeVisible();
      await row.evaluate((el) => el.setAttribute("data-measure", "hovered"));
      const { failures, counts } = await measure(page, "[data-measure=hovered]");
      expect(counts.gutterNodes).toBeGreaterThanOrEqual(1);
      expect(failures).toEqual([]);
    });
  }
});

test.describe("tasks panel flow strip", () => {
  const phases = (page: Page) => page.getByRole("list", { name: "Superpowers flow" }).getByRole("listitem");

  test("is measured: five phases, the running one is current, spec and plan are buttons", async ({ page }) => {
    await show(page, "dark", "default", "running");
    const list = page.getByRole("list", { name: "Superpowers flow" });
    await expect(list.getByRole("listitem")).toHaveCount(5);
    await expect(list.locator('[aria-current="step"]')).toContainText("Build");
    await expect(list.getByRole("button")).toHaveText(["Spec", "Plan"]);
    await expect(phases(page).nth(4)).toContainText("Ship");
  });

  test("the problems state shows the failed check, the blocked build and Ship's failed tests", async ({ page }) => {
    await show(page, "dark", "default", "problems");
    await expect(phases(page).nth(3)).toContainText("tests failed 2m ago");
    await expect(phases(page).nth(3).getByRole("img", { name: "failed" })).toBeVisible();
    await expect(phases(page).nth(2).getByRole("img", { name: "blocked" })).toBeVisible();
    await expect(page.locator(`${FLOW_LIST} [aria-current="step"]`)).toContainText("Build");
    await expect(phases(page).nth(4).getByRole("img", { name: "tests failed" })).toBeVisible();
  });

  test("the ready state is done across the board and has no current step", async ({ page }) => {
    await show(page, "dark", "default", "ready");
    await expect(phases(page).nth(3)).toContainText("tests passed 4m ago, final review done");
    for (let i = 0; i < 4; i++) await expect(phases(page).nth(i).getByRole("img", { name: "done" })).toBeVisible();
    await expect(phases(page).nth(4).getByRole("img", { name: "ready" })).toBeVisible();
    await expect(page.locator(`${FLOW_LIST} [aria-current="step"]`)).toHaveCount(0);
  });
});

test.describe("tasks panel widths", () => {
  for (const width of WIDTHS) {
    for (const theme of ["dark", "light"] as const) {
      test(`${width}px ${theme} does not scroll sideways`, async ({ page }) => {
        await show(page, theme, "default", "needs-you", width);
        await openEverything(page);
        const over = await page.evaluate(() => {
          const scroller = document.getElementById("root")!.firstElementChild as HTMLElement;
          return { scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth };
        });
        expect(over.scrollWidth).toBeLessThanOrEqual(over.clientWidth);
        expect(over.clientWidth).toBeGreaterThan(0);
        expect(await overflowFailures(page)).toEqual([]);

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
        expect(strip.count).toBe(5);
        expect(strip.right).toBeLessThanOrEqual(strip.columnRight + 0.5);
        expect(strip.left).toBeGreaterThanOrEqual(strip.columnLeft - 0.5);
        expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth);
      });
    }
  }

  // Two-digit filter counts are the widest the header gets; the narrowest sidebar must still hold it.
  for (const theme of ["dark", "light"] as const) {
    test(`240px ${theme}: the header holds two-digit filter counts`, async ({ page }) => {
      await show(page, theme, "default", "many problems", 240);
      const radios = page.getByRole("radiogroup", { name: "Show" }).getByRole("radio");
      await expect(radios).toHaveText(["All 15", "Left 13", "Problems 10"]);
      const box = await page.evaluate(() => {
        const column = document.getElementById("root")!.getBoundingClientRect();
        const group = document.querySelector('[role="radiogroup"]')!;
        const header = group.parentElement!.parentElement!;
        const parts = [group, ...Array.from(header.querySelectorAll("button, select"))].map((el) => el.getBoundingClientRect());
        return {
          left: Math.min(...parts.map((r) => r.left)),
          right: Math.max(...parts.map((r) => r.right)),
          column: { left: column.left, right: column.right },
          scroll: header.scrollWidth,
          client: header.clientWidth,
        };
      });
      expect(box.right).toBeLessThanOrEqual(box.column.right + 0.5);
      expect(box.left).toBeGreaterThanOrEqual(box.column.left - 0.5);
      expect(box.scroll).toBeLessThanOrEqual(box.client);
      expect(await overflowFailures(page)).toEqual([]);
    });
  }
});

const STRIP = "[data-strip]";
const PILLS = "[data-problems] button";

/** The text of each problem button, without its glyph. */
const pillTexts = (page: Page) => page.locator(PILLS).evaluateAll((els) => els.map((el) => (el.lastElementChild ?? el).textContent));

test.describe("tasks panel overview", () => {
  test("says the counts, the time and the strip in words", async ({ page }) => {
    await show(page, "dark", "default", "running");
    await expect(page.locator("[data-counts]")).toHaveText("2 of 5 tasks · 4 left · 9 of 19 steps");
    await expect(page.locator("[data-time]")).toHaveText("50m so far");
    const strip = page.locator(STRIP);
    await expect(strip).toHaveAttribute("role", "img");
    await expect(strip).toHaveAttribute("aria-label", "2 done, 1 running, 3 not started");
  });

  test("leaves steps out when the plan file was not read", async ({ page }) => {
    await show(page, "dark", "default", "no steps");
    await expect(page.locator("[data-counts]")).toHaveText("2 of 5 tasks · 4 left");
  });

  test("a ready plan says its totals and has no problems row", async ({ page }) => {
    await show(page, "dark", "default", "ready");
    await expect(page.locator("[data-counts]")).toHaveText("5 of 5 tasks · 16 steps");
    await expect(page.locator("[data-problems]")).toHaveCount(0);
    await expect(page.locator(STRIP)).toHaveAttribute("aria-label", "6 done");
  });

  for (const theme of ["dark", "light"] as const) {
    test(`${theme}: the strip has one 6px segment per task and the final review, 2px apart, in status colours`, async ({ page }) => {
      await show(page, theme, "default", "problems");
      const segs = await page.locator(`${STRIP} > span`).evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return { status: el.getAttribute("data-status"), left: r.left, right: r.right, width: r.width, height: r.height, bg: cs.backgroundColor, radius: cs.borderTopLeftRadius };
        }),
      );
      expect(segs.map((x) => x.status)).toEqual(["done", "done", "done", "done", "failed", "blocked", "attention", "pending", "pending"]);
      for (const seg of segs) {
        expect(seg.height).toBeCloseTo(6, 0);
        expect(seg.width, "segment width").toBeGreaterThan(8);
        expect(parseFloat(seg.radius)).toBeGreaterThanOrEqual(3);
      }
      for (let i = 1; i < segs.length; i++) expect(segs[i].left - segs[i - 1].right).toBeCloseTo(2, 0);
      for (const seg of segs) expect(seg.width).toBeCloseTo(segs[0].width, 0);
      const color = (status: string) => segs.find((x) => x.status === status)!.bg;
      const distinct = new Set(["done", "failed", "attention", "pending"].map(color));
      expect(distinct.size, "status colours are told apart").toBe(4);
      // Failed and blocked are both stopped (danger); the glyphs and words tell them apart.
      expect(color("blocked")).toBe(color("failed"));
    });
  }

  test("lists the tasks in trouble in plan order", async ({ page }) => {
    await show(page, "dark", "default", "problems");
    expect(await pillTexts(page)).toEqual(["Task 5 · failed", "Task 6 · blocked", "Task 7 · fix 3 of 5"]);
    await expect(page.locator("[data-problems]")).toContainText("Needs a look");
  });

  test("shows three problems and folds the rest into +7 more, which expands in place", async ({ page }) => {
    await show(page, "dark", "default", "many problems");
    expect(await pillTexts(page)).toEqual(["Task 3 · failed", "Task 4 · blocked", "Task 5 · fix 3 of 5", "+7 more"]);
    const more = page.locator(PILLS).last();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    const before = await page.locator("[data-problems]").boundingBox();
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    expect(await pillTexts(page)).toHaveLength(11);
    await expect(more).toHaveText("Show fewer");
    const after = await page.locator("[data-problems]").boundingBox();
    expect(after!.y, "the row grows downward and does not move").toBe(before!.y);
  });

  test("a problem button opens its task and moves focus to the task's row", async ({ page }) => {
    await show(page, "dark", "default", "problems");
    await page.locator(PILLS, { hasText: "Task 6" }).click();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('[role="treeitem"]')?.getAttribute("data-row-id")))
      .toBe("task-6");
  });

  test("a problem button can be reached and pressed with the keyboard", async ({ page }) => {
    await show(page, "dark", "default", "problems");
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
          await openFixture(page);
          await render(page, state, theme, "default", width);
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
