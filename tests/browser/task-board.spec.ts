import { expect, test, type Page } from "@playwright/test";
import { freezeTransitions, measure, THEMES, type Counts } from "./contrast";

// Accessibility regression guard for the full-tab Tasks board. The fixture renders the
// real TaskBoardView at 900 x 700 over an in-memory filesystem holding the real
// skills-index ledger, briefs and reports, so the real parser, hook and status-card
// derivation produce what is measured. Every theme x palette x status-card scene is
// measured with every row opened.

const SCENES = ["natural", "running", "needs-you", "quiet"] as const;
const WIDTHS = [600, 900, 1400];
const TOGGLE = 'button[aria-label^="Show details for"]';
const TABLE = 'table[aria-label="Plan tasks"]';
const FLOW_LIST = 'ol[aria-label="Superpowers flow"]';

async function show(page: Page, theme: "dark" | "light", palette: "default" | "colorblind" | "high-contrast", scene: string, width = 900) {
  await page.goto("/tests/browser/task-board.html");
  await freezeTransitions(page);
  await page.evaluate(
    ([t, p, s, w]) => {
      document.getElementById("root")!.style.width = `${w}px`;
      window.setTheme(t as "dark", p as "default");
      window.showBoard(s as string);
    },
    [theme, palette, scene, width],
  );
  // The real hook reads the fake filesystem asynchronously: wait for the table and the flow strip.
  await page.locator(`${TABLE} tbody tr[data-node]`).first().waitFor();
  await page.locator(FLOW_LIST).waitFor();
}

/** Opens every row detail with a real click, so each detail text node exists. */
async function openAllRows(page: Page): Promise<number> {
  const toggles = page.locator(TOGGLE);
  const count = await toggles.count();
  for (let i = 0; i < count; i++) await toggles.nth(i).click();
  return count;
}

/** A measurement that saw the real board: enough text, glyphs, rows and flow phases to mean something. */
function expectSubstantial(counts: Counts, expanded: number) {
  expect(counts.rootChildren, "the board root is empty").toBeGreaterThan(0);
  expect(counts.phases, "flow phases").toBeGreaterThanOrEqual(4);
  expect(counts.rows, "task rows").toBeGreaterThanOrEqual(8);
  expect(counts.glyphs, "glyphs").toBeGreaterThanOrEqual(10);
  expect(expanded, "expanded rows").toBeGreaterThanOrEqual(5);
  expect(counts.textNodes, "text nodes").toBeGreaterThanOrEqual(80);
}

test.describe("task board accessibility", () => {
  for (const [theme, palette] of THEMES) {
    for (const scene of SCENES) {
      test(`${theme} ${palette} ${scene}`, async ({ page }, testInfo) => {
        await show(page, theme, palette, scene);
        const expanded = await openAllRows(page);
        await expect(page.locator("tr[data-detail]")).toHaveCount(expanded);
        const { failures, counts } = await measure(page);
        testInfo.annotations.push({ type: "failures", description: String(failures.length) });
        testInfo.annotations.push({ type: "counts", description: JSON.stringify({ ...counts, expanded }) });
        expectSubstantial(counts, expanded);
        expect(failures).toEqual([]);
      });
    }
  }

  test("an unknown scene fails loudly instead of rendering a stale board", async ({ page }) => {
    await page.goto("/tests/browser/task-board.html");
    await expect(page.evaluate(() => window.showBoard("no such scene"))).rejects.toThrow(/Unknown task board scene/);
  });
});

test.describe("task board content", () => {
  test("the real code derives the plan, the flow strip and the status card from the fixture", async ({ page }) => {
    await show(page, "dark", "default", "natural");
    await expect(page.locator(FLOW_LIST).getByRole("listitem")).toHaveCount(4);
    await expect(page.locator(FLOW_LIST).getByRole("button")).toContainText(["Spec", "Plan"]);
    await expect(page.getByRole("button", { name: "Open plan" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Plan" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3 }).first()).toContainText("Decisions made for you");
  });

  test("the needs-you scene derives an alert headline from a busy session with a question", async ({ page }) => {
    await show(page, "dark", "default", "needs-you");
    await expect(page.getByRole("alert")).toContainText("skills-index");
  });

  test("the scenes derive different status cards", async ({ page }) => {
    const headlines = new Set<string>();
    for (const scene of SCENES) {
      await show(page, "dark", "default", scene);
      headlines.add((await page.getByRole("heading", { level: 2 }).textContent()) ?? "");
    }
    expect(headlines.size, `headlines: ${[...headlines].join(" | ")}`).toBeGreaterThanOrEqual(3);
  });

  test("each row expansion button opens its detail and the detail text is measured", async ({ page }) => {
    await show(page, "light", "default", "natural");
    const toggles = page.locator(TOGGLE);
    const count = await toggles.count();
    expect(count, "expandable rows").toBeGreaterThanOrEqual(5);
    for (let i = 0; i < count; i++) {
      const toggle = toggles.nth(i);
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      const detail = page.locator(`#${await toggle.getAttribute("aria-controls")}`);
      await expect(detail).toBeVisible();
      await detail.evaluate((el) => el.setAttribute("data-measure", "detail"));
      const { failures, counts } = await measure(page, "[data-measure=detail]");
      expect(counts.textNodes, "detail text nodes").toBeGreaterThanOrEqual(1);
      expect(failures).toEqual([]);
      await detail.evaluate((el) => el.removeAttribute("data-measure"));
    }
  });
});

// The Spec and Plan buttons change background on hover: measure their text on that background.
test.describe("task board flow buttons on hover", () => {
  for (const [theme, palette] of THEMES) {
    for (const name of ["Spec", "Plan"]) {
      test(`${theme} ${palette} ${name}`, async ({ page }) => {
        await show(page, theme, palette, "natural");
        const button = page.locator(`${FLOW_LIST} button`, { hasText: name });
        await expect(button).toHaveCount(1);
        const background = () => button.evaluate((el) => getComputedStyle(el).backgroundColor);
        const resting = await background();
        await button.hover();
        expect(await background(), "the hover background applies").not.toBe(resting);
        await button.evaluate((el) => el.setAttribute("data-measure", "hovered"));
        expect(await button.evaluate((el) => el.matches(":hover")), "the pointer is over the button").toBe(true);
        const { failures, counts } = await measure(page, "[data-measure=hovered]");
        expect(counts.textNodes, "text nodes").toBeGreaterThanOrEqual(1);
        expect(failures).toEqual([]);
      });
    }
  }
});

test.describe("task board widths", () => {
  for (const width of WIDTHS) {
    for (const theme of ["dark", "light"] as const) {
      test(`${width}px ${theme} does not scroll sideways`, async ({ page }) => {
        await show(page, theme, "default", "needs-you", width);
        await openAllRows(page);
        const over = await page.evaluate(() => {
          const root = document.getElementById("root")!;
          const scroller = root.firstElementChild as HTMLElement;
          const table = scroller.querySelector("table")!;
          return {
            rootWidth: root.getBoundingClientRect().width,
            scrollWidth: scroller.scrollWidth,
            clientWidth: scroller.clientWidth,
            tableRight: table.getBoundingClientRect().right,
            scrollerRight: scroller.getBoundingClientRect().right,
            pageScrollWidth: document.documentElement.scrollWidth,
            viewportWidth: document.documentElement.clientWidth,
          };
        });
        expect(over.rootWidth).toBe(width);
        expect(over.clientWidth).toBeGreaterThan(0);
        expect(over.scrollWidth).toBeLessThanOrEqual(over.clientWidth);
        expect(over.tableRight).toBeLessThanOrEqual(over.scrollerRight + 0.5);
        // The page itself only grows past the viewport when the fixture column is wider than it.
        if (width <= over.viewportWidth) expect(over.pageScrollWidth).toBeLessThanOrEqual(over.viewportWidth);
      });
    }
  }
});
