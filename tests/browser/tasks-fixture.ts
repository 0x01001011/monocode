import type { Page } from "@playwright/test";
import { freezeTransitions, measure, overflowFailures, type Counts, type Failure } from "./contrast";

// Driving the Tasks panel fixture (tests/browser/tasks-panel.tsx) from the specs.

export type Theme = "dark" | "light";
export type Palette = "default" | "colorblind" | "high-contrast";

export const FIXTURE = "/tests/browser/tasks-panel.html";
export const FLOW_LIST = 'ol[aria-label="Superpowers flow"]';
export const WIDTHS = [240, 340, 480] as const;
/** The states the score measures; the fixture holds a few more variants. */
export const SCORED_STATES = ["running", "problems", "ready", "deferred", "workers"] as const;

/** Loads the fixture once, at rest (no transitions or animations). */
export async function openFixture(page: Page) {
  await page.goto(FIXTURE);
  await freezeTransitions(page);
}

/** Renders `state` fresh at `width` in `theme`, and waits for the flow strip. */
export async function render(page: Page, state: string, theme: Theme = "dark", palette: Palette = "default", width = 340) {
  await page.evaluate(
    ([t, p, st, w]) => {
      document.getElementById("root")!.style.width = `${w}px`;
      window.setTheme(t as Theme, p as Palette);
      window.showTasks(st as string);
    },
    [theme, palette, state, width] as const,
  );
  await page.locator(FLOW_LIST).waitFor();
}

export async function show(page: Page, theme: Theme, palette: Palette, state: string, width = 340) {
  await openFixture(page);
  await render(page, state, theme, palette, width);
}

export async function setWidth(page: Page, width: number) {
  await page.evaluate((w) => {
    document.getElementById("root")!.style.width = `${w}px`;
  }, width);
  // Container queries settle on the next frame.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/**
 * Opens the legend, the menu, the note groups, Ship and every collapsed tree row, and shows every
 * problem, so each text node, ref and gutter shape exists.
 */
export async function openEverything(page: Page) {
  await page.evaluate(() => {
    for (let pass = 0; pass < 3; pass++) {
      for (const el of Array.from(document.querySelectorAll('button[aria-expanded="false"]'))) (el as HTMLElement).click();
      for (const row of Array.from(document.querySelectorAll('[role="treeitem"][aria-expanded="false"] > [data-row]'))) {
        (row as HTMLElement).click();
      }
    }
  });
  await page.waitForTimeout(60);
}

/** Scrolls the panel to its end so the sticky bar shows; false when the panel does not scroll. */
export async function scrollToEnd(page: Page): Promise<boolean> {
  const scrolled = await page.evaluate(() => {
    const scroller = document.getElementById("root")!.firstElementChild as HTMLElement;
    if (scroller.scrollHeight <= scroller.clientHeight + 40) return false;
    scroller.scrollTop = scroller.scrollHeight;
    return true;
  });
  if (scrolled) await page.waitForTimeout(80);
  return scrolled;
}

export async function scrollToTop(page: Page) {
  await page.evaluate(() => {
    (document.getElementById("root")!.firstElementChild as HTMLElement).scrollTop = 0;
  });
  await page.waitForTimeout(40);
}

export type WidthResult = { width: number; failures: Failure[]; counts: Counts; sticky: boolean };

/**
 * Contrast (text 4.5, glyphs, gutter lines and nodes 3), targets (24 px) and horizontal overflow
 * of the open panel at one width, then of the sticky bar once the panel scrolls.
 */
export async function measureAt(page: Page, width: number): Promise<WidthResult> {
  await setWidth(page, width);
  const { failures, counts } = await measure(page);
  failures.push(...(await overflowFailures(page)));
  let sticky = false;
  if (await scrollToEnd(page)) {
    const bar = page.locator("[data-sticky-bar]");
    if ((await bar.count()) > 0) {
      sticky = true;
      const scoped = await measure(page, "[data-sticky-bar]");
      failures.push(...scoped.failures.map((f) => ({ ...f, what: `sticky bar: ${f.what}` })));
    }
    await scrollToTop(page);
  }
  return { width, failures: failures.map((f) => ({ ...f, what: `${width}px ${f.what}` })), counts, sticky };
}
