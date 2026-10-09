import { expect, test, type Page } from "@playwright/test";
import { freezeTransitions, measure, THEMES, type Counts } from "./contrast";

// Accessibility regression guard for the Tasks panel. The fixture renders the real
// TasksPanel at sidebar width; every theme x palette x status-card state is
// measured by compositing text and glyphs over their real backgrounds (canvas
// resolves color-mix and alpha, so the numbers are what the user sees).

const STATES = ["needs-you", "struggling", "quiet", "running", "done", "failed check", "blocked build", "finished"] as const;
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
