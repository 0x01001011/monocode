import { expect, test, type Page } from "@playwright/test";
import { focusStop, freezeTransitions, type FocusStop } from "./contrast";

// Keyboard focus regression guard for the Tasks panel. It tabs
// through each page (and arrows through the tree) and, for every element that takes focus,
// asserts the ring is really drawn: a visible outline style, at least 2px wide, at least 3:1
// against what it sits on, and not cut off by an `overflow` ancestor. A Tailwind `outline-none`
// next to `focus-visible:outline-*` computes `outline-style: none`, which this catches.

type Kind = FocusStop["kind"];
const MAX_TABS = 90;

async function press(page: Page, key: string) {
  await page.keyboard.press(key);
  await page.waitForTimeout(15);
}

/** Moves focus through the whole tree with the arrow keys, opening every branch on the way. */
async function walkTree(page: Page, record: (stop: FocusStop | null) => void) {
  for (let i = 0; i < 80; i++) {
    const expanded = await page.evaluate(() => document.activeElement?.getAttribute("aria-expanded"));
    if (expanded === "false") {
      await press(page, "ArrowRight");
      record(await focusStop(page));
    }
    const id = await page.evaluate(() => document.activeElement?.textContent?.slice(0, 60));
    await press(page, "ArrowDown");
    record(await focusStop(page));
    const next = await page.evaluate(() => document.activeElement?.textContent?.slice(0, 60));
    if (next === id) break;
  }
  await press(page, "Home");
}

async function tabThrough(page: Page) {
  const stops: FocusStop[] = [];
  const record = (stop: FocusStop | null) => {
    if (stop?.fresh) stops.push(stop);
  };
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  let walked = false;
  for (let i = 0; i < MAX_TABS; i++) {
    await press(page, "Tab");
    const stop = await focusStop(page);
    if (!stop) break;
    if (!stop.fresh && i > 0 && stop.kind !== "treeitem") break;
    record(stop);
    if (stop.kind === "treeitem" && !walked) {
      walked = true;
      await walkTree(page, record);
    }
  }
  return stops;
}

function summarize(name: string, stops: FocusStop[]) {
  const bad = stops.filter((s) => s.problem);
  // One greppable line per page, so a run before and after a fix can be compared.
  console.log(`FOCUS-SUMMARY ${name} stops=${stops.length} without-visible-ring=${bad.length}`);
  return bad;
}

function expectKinds(stops: FocusStop[], kinds: Kind[]) {
  const seen = new Set(stops.map((s) => s.kind));
  for (const kind of kinds) expect(seen, `no ${kind} took focus; got ${[...seen].join(", ")}`).toContain(kind);
}

const THEMES_UNDER_TEST = ["dark", "light"] as const;

test.describe("tasks panel keyboard focus ring", () => {
  const SCENES = ["running", "problems", "many problems", "needs-you", "no steps", "ready", "workers"] as const;
  for (const theme of THEMES_UNDER_TEST) {
    for (const scene of SCENES) {
      test(`${theme} ${scene}`, async ({ page }, testInfo) => {
        await page.goto("/tests/browser/tasks-panel.html");
        await freezeTransitions(page);
        await page.evaluate(([t, s]) => {
          window.setTheme(t as "dark");
          window.showTasks(s);
        }, [theme, scene]);
        await page.locator('ol[aria-label="Superpowers flow"]').waitFor();
        const stops = await tabThrough(page);
        const bad = summarize(`panel ${testInfo.project.name} ${theme} ${scene}`, stops);
        // Non-vacuity: the run reached the plan picker, the flow strip, the tree and its rows.
        expect(stops.length, "distinct focus stops").toBeGreaterThanOrEqual(scene === "many problems" ? 14 : 8);
        expectKinds(stops, ["button", "select", "treeitem", "flow-strip"]);
        if (scene === "many problems") expectKinds(stops, ["overview-pill"]);
        expect(stops.filter((s) => s.kind === "treeitem").length, "tree rows reached with the arrow keys").toBeGreaterThanOrEqual(7);
        expect(bad.map((s) => `${s.label}: ${s.problem}`)).toEqual([]);
      });
    }
  }
});

// The sticky bar shows only once the header scrolls away, so the tab walk above never meets it.
test.describe("tasks panel sticky bar focus ring", () => {
  for (const theme of THEMES_UNDER_TEST) {
    test(`${theme}: Jump to now draws a visible ring`, async ({ page }) => {
      await page.goto("/tests/browser/tasks-panel.html");
      await freezeTransitions(page);
      await page.evaluate((t) => {
        window.setTheme(t as "dark");
        window.showTasks("running");
      }, theme);
      await page.locator('ol[aria-label="Superpowers flow"]').waitFor();
      // A short column, so the header scrolls away.
      await page.evaluate(() => {
        document.getElementById("root")!.style.height = "360px";
      });
      await page.evaluate(() => {
        const scroller = document.getElementById("root")!.firstElementChild as HTMLElement;
        scroller.scrollTop = scroller.scrollHeight;
      });
      const jump = page.locator("[data-sticky-bar]").getByRole("button", { name: "Jump to now" });
      await expect(jump).toBeVisible();
      // Keyboard modality first, so the browser treats the focus as keyboard focus.
      await press(page, "Shift");
      await jump.focus();
      const stop = await focusStop(page);
      expect(stop?.label).toContain("Jump to now");
      expect(stop?.problem ?? null).toBeNull();
    });
  }
});

// The checker itself: it must flag the failures it exists for, or a green run proves nothing.
test.describe("focus ring checker", () => {
  const frame = (ring: string) => `
    <style>
      body { background: #111; margin: 20px }
      .frame { overflow: hidden; width: 100px }
      button { display: block; width: 100px; height: 24px; background: #333; border: 0; ${ring} }
    </style>
    <div class="frame"><button>one</button></div>`;

  /** Tabs to the lone button with `focusRule` as its :focus-visible declarations and returns the verdict. */
  async function problemWith(page: Page, focusRule: string) {
    await page.setContent(frame(`}\nbutton:focus-visible { ${focusRule}`));
    await page.keyboard.press("Tab");
    const stop = await focusStop(page);
    expect(stop?.kind).toBe("button");
    return stop!.problem;
  }

  test("flags outline-style none", async ({ page }) => {
    expect(await problemWith(page, "outline: none")).toMatch(/outline-style is none/);
  });

  test("flags an outset ring cut by an overflow-hidden frame", async ({ page }) => {
    expect(await problemWith(page, "outline: 2px solid #5af; outline-offset: 2px")).toMatch(/clipped/);
  });

  test("flags a ring that is too faint against its background", async ({ page }) => {
    expect(await problemWith(page, "outline: 2px solid #383838; outline-offset: -2px")).toMatch(/contrast/);
  });

  test("accepts an inset ring in the same frame", async ({ page }) => {
    expect(await problemWith(page, "outline: 2px solid #5af; outline-offset: -2px")).toBeNull();
  });
});
