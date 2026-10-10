import { expect, test, type Page } from "@playwright/test";
import { THEMES, type Failure } from "./contrast";
import { measureAt, openEverything, openFixture, render, scrollToEnd, SCORED_STATES, WIDTHS } from "./tasks-fixture";

// The Tasks tab score for the autoresearch loop: `TASKS_SCORE = rubric points - 5 x a11y failures`.
// Higher is better. It is a metric: a low score never fails the test, only a crash does.
//
// Rubric, 1 point each: every gap kind visible (in `problems`; "no final review" cannot coexist
// with unfinished tasks, so it is read from `done-no-final`), each ref tone visible, the NOW pill,
// the fork cell, the merge cell, worker lanes, the Ship ready text, Ship's unmet buttons, each
// filter, the sticky bar, the `o`, `c` and `n` keys, Copy summary, each note group, and a commit
// link that opens. Failures: contrast (text 4.5, non-text 3), targets under 24 px and horizontal
// overflow, measured at 240/340/480 px x 6 theme/palette combinations x the 5 scored states.

type Events = { type: string; id?: string; text?: string; target?: { kind: string; ref: string } }[];

const events = (page: Page) => page.evaluate(() => window.tasksEvents as Events);
const activeRowId = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest('[role="treeitem"]')?.getAttribute("data-row-id") ?? null);
const row = (page: Page, id: string) => page.locator(`[role="treeitem"][data-row-id="${id}"]`);
const visibleRowIds = (page: Page) =>
  page.locator('[role="treeitem"]').evaluateAll((els) => els.filter((el) => el.getClientRects().length > 0).map((el) => el.getAttribute("data-row-id")!));
const isVisible = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el || el.getClientRects().length === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && Number(getComputedStyle(el).opacity) > 0;
  }, selector);

async function openGroup(page: Page, id: string) {
  const button = page.locator(`button[data-notes="${id}"]`);
  if ((await button.getAttribute("aria-expanded")) === "false") await button.click();
  return page.locator(`[data-group="${id}"] li`);
}

async function chooseFilter(page: Page, name: string) {
  const radio = page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: new RegExp(`^${name} \\d+$`) });
  await radio.click();
  await expect(radio).toHaveAttribute("aria-checked", "true");
}

/** Opens a row by clicking its gutter: the row's middle may hold an action button while hovered. */
async function openRow(page: Page, id: string) {
  await row(page, id).locator("[data-row]").click({ position: { x: 10, y: 8 } });
  await page.mouse.move(0, 0);
  await expect(row(page, id)).toHaveAttribute("aria-expanded", "true");
}

const MAIN_ROW = /^(task-\d+|final-review|hidden:.+)$/;
const mainRows = async (page: Page) => (await visibleRowIds(page)).filter((id) => MAIN_ROW.test(id));

/** Each rubric item: a name and a check that resolves true when the panel does it. */
const RUBRIC: [string, (page: Page) => Promise<boolean>][] = [
  [
    "gap: no commit",
    async (page) => {
      await render(page, "problems");
      return (await (await openGroup(page, "gaps")).allTextContents()).some((t) => /Task 2: no commit recorded/.test(t));
    },
  ],
  [
    "gap: closed with parked",
    async (page) => {
      await render(page, "problems");
      return (await (await openGroup(page, "gaps")).allTextContents()).some((t) => /Task 3: closed with 2 parked/.test(t));
    },
  ],
  [
    "gap: unticked at finish",
    async (page) => {
      await render(page, "problems");
      return (await (await openGroup(page, "gaps")).allTextContents()).some((t) => /Task 4: 2 steps not ticked/.test(t));
    },
  ],
  [
    "gap: no final review",
    async (page) => {
      await render(page, "done-no-final");
      return (await (await openGroup(page, "gaps")).allTextContents()).some((t) => /Final review: final review not run/.test(t));
    },
  ],
  ...(
    [
      ["warn", "text-warning"],
      ["danger", "text-danger"],
      ["ok", "text-success"],
      ["muted", "text-muted"],
    ] as const
  ).map(([tone, cls]): [string, (page: Page) => Promise<boolean>] => [
    `ref tone: ${tone}`,
    async (page) => {
      for (const state of SCORED_STATES) {
        await render(page, state);
        const seen = await page.locator("[data-ref]").evaluateAll(
          (els, c) => els.some((el) => el.classList.contains(c) && el.getClientRects().length > 0 && (el.textContent ?? "").trim() !== ""),
          cls,
        );
        if (seen) return true;
      }
      return false;
    },
  ]),
  [
    "ref tone: now",
    async (page) => {
      await render(page, "running");
      return isVisible(page, '[data-row-id="task-3"] [data-now-pill]');
    },
  ],
  [
    "NOW pill",
    async (page) => {
      await render(page, "running");
      const pill = row(page, "task-3").locator("[data-now-pill]");
      return (await pill.count()) === 1 && (await pill.textContent()) === "NOW" && (await row(page, "task-3").getAttribute("aria-label"))!.includes("now");
    },
  ],
  [
    "fork cell",
    async (page) => {
      await render(page, "running");
      await openRow(page, "task-2");
      return (await row(page, "task-2:stage:1").locator("svg[data-gutter] [data-curve]").count()) === 1;
    },
  ],
  [
    "merge cell",
    async (page) => {
      await render(page, "running");
      await openRow(page, "task-2");
      return (await row(page, "task-2:merge").locator("svg[data-gutter] [data-curve]").count()) === 1;
    },
  ],
  [
    "worker lanes",
    async (page) => {
      await render(page, "workers");
      const lanes = page.locator('[role="treeitem"][data-row-id^="worker:"]');
      if ((await lanes.count()) !== 2) return false;
      const titles = await lanes.allTextContents();
      const forks = await lanes.locator("svg[data-gutter] [data-curve]").count();
      return titles.some((t) => t.includes("Port the docs index")) && titles.some((t) => t.includes("Refresh the fixtures")) && forks === 2;
    },
  ],
  [
    "Ship ready text",
    async (page) => {
      await render(page, "ready");
      const verdict = (await row(page, "ship").textContent()) ?? "";
      const totals = (await page.locator("[data-ship]").textContent()) ?? "";
      return verdict.includes("Ready to ship") && /Ready to ship · 5 tasks · 16 steps · \d+ commits/.test(totals);
    },
  ],
  [
    "Ship unmet buttons",
    async (page) => {
      await render(page, "problems");
      await expect(row(page, "ship")).toContainText("things before ship");
      const toggle = page.locator("[data-ship] > button");
      if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
      const unmet = page.locator('[data-ship] ul[aria-label="Before ship"] button');
      if ((await unmet.count()) < 2) return false;
      await unmet.filter({ hasText: "tasks left" }).click();
      await expect.poll(() => activeRowId(page)).toBe("task-5");
      return true;
    },
  ],
  [
    "filter: all",
    async (page) => {
      await render(page, "problems");
      await chooseFilter(page, "Left");
      await chooseFilter(page, "All");
      const ids = await mainRows(page);
      return ids.length === 9 && ids.every((id) => !id.startsWith("hidden:"));
    },
  ],
  [
    "filter: left",
    async (page) => {
      await render(page, "problems");
      await chooseFilter(page, "Left");
      const ids = await mainRows(page);
      return JSON.stringify(ids) === JSON.stringify(["hidden:task-1", "task-5", "task-6", "task-7", "task-8", "final-review"]);
    },
  ],
  [
    "filter: problems",
    async (page) => {
      await render(page, "problems");
      await chooseFilter(page, "Problems");
      const ids = (await mainRows(page)).filter((id) => !id.startsWith("hidden:"));
      return JSON.stringify(ids) === JSON.stringify(["task-2", "task-3", "task-4", "task-5", "task-6", "task-7"]);
    },
  ],
  [
    "sticky bar",
    async (page) => {
      await render(page, "running");
      await openEverything(page);
      if (!(await scrollToEnd(page))) return false;
      const bar = page.locator("[data-sticky-bar]");
      await expect(bar).toBeVisible();
      if (!((await bar.textContent()) ?? "").includes("Task 3")) return false;
      await bar.getByRole("button", { name: "Jump to now" }).click();
      await expect.poll(() => activeRowId(page)).toBe("task-3");
      // Once the (smooth) scroll settles, the focused row is not hidden under the bar.
      await expect
        .poll(async () => {
          const barBox = (await bar.count()) > 0 ? await bar.boundingBox() : null;
          const rowBox = await row(page, "task-3").boundingBox();
          return !barBox || (rowBox !== null && rowBox.y >= barBox.y + barBox.height - 1);
        })
        .toBe(true);
      return true;
    },
  ],
  [
    "key: o",
    async (page) => {
      await render(page, "running");
      await row(page, "task-1").focus();
      await page.keyboard.press("o");
      return (await events(page)).some((e) => e.type === "open" && e.id === "task-1" && e.target?.kind === "report");
    },
  ],
  [
    "key: c",
    async (page) => {
      await render(page, "running");
      await row(page, "task-1").focus();
      await page.keyboard.press("c");
      return (await events(page)).some((e) => e.type === "copy" && e.text === "1a2b3c4");
    },
  ],
  [
    "key: n",
    async (page) => {
      await render(page, "running");
      await row(page, "task-1").focus();
      await page.keyboard.press("n");
      await expect.poll(() => activeRowId(page)).toBe("task-3");
      return true;
    },
  ],
  [
    "copy summary",
    async (page) => {
      await render(page, "ready");
      await page.getByRole("button", { name: "More plan actions" }).click();
      await page.getByRole("menuitem", { name: "Copy summary" }).click();
      const fromMenu = (await events(page)).find((e) => e.type === "copy")?.text ?? "";
      await page.locator("[data-ship]").getByRole("button", { name: "Copy summary" }).click();
      const copies = (await events(page)).filter((e) => e.type === "copy");
      return fromMenu.startsWith("# tasks-graph") && fromMenu.includes("Task 2: Board model") && copies.length === 2;
    },
  ],
  [
    "note group: deferred",
    async (page) => {
      await render(page, "deferred");
      const items = await openGroup(page, "deferred");
      return (await items.count()) === 5 && (await items.filter({ hasText: "parked" }).count()) === 2;
    },
  ],
  [
    "note group: gaps",
    async (page) => {
      await render(page, "problems");
      const items = await openGroup(page, "gaps");
      if ((await items.count()) !== 3) return false;
      await items.first().getByRole("button").click();
      await expect.poll(() => activeRowId(page)).toBe("task-2");
      return true;
    },
  ],
  [
    "note group: decisions",
    async (page) => {
      await render(page, "running");
      const items = await openGroup(page, "decisions");
      if ((await items.count()) !== 3) return false;
      await items.first().getByRole("button", { name: /^Change this/ }).click();
      return (await events(page)).some((e) => e.type === "decision");
    },
  ],
  [
    "commit link opens",
    async (page) => {
      await render(page, "running");
      await openRow(page, "task-2");
      await row(page, "task-2:stage:0").locator("button[data-sha]").click();
      return (await events(page)).some((e) => e.type === "open" && e.id === "task-2" && e.target?.kind === "commit" && e.target.ref === "44aa0b1");
    },
  ],
];

test("tasks score", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "the score is measured in Chromium only");
  test.setTimeout(5 * 60_000);
  const started = Date.now();
  await openFixture(page);

  // Accessibility failures across every scored state, theme and width.
  const failures: (Failure & { state: string; theme: string })[] = [];
  let measured = 0;
  for (const state of SCORED_STATES) {
    for (const [theme, palette] of THEMES) {
      await render(page, state, theme, palette);
      await openEverything(page);
      for (const width of WIDTHS) {
        const result = await measureAt(page, width);
        // A measurement that saw nothing is a broken fixture, not a clean panel.
        expect(result.counts.textNodes, `${state} ${theme} ${palette} text nodes`).toBeGreaterThanOrEqual(20);
        expect(result.counts.gutterNodes, `${state} ${theme} ${palette} graph nodes`).toBeGreaterThanOrEqual(6);
        measured++;
        for (const f of result.failures) failures.push({ ...f, state, theme: `${theme} ${palette}` });
      }
    }
  }

  // The rubric, in the default theme at 340 px. A check that throws scores no point.
  page.setDefaultTimeout(5_000);
  const rubric: Record<string, boolean> = {};
  const notes: Record<string, string> = {};
  for (const [name, check] of RUBRIC) {
    try {
      // The pointer rests outside the panel: a hovered row swaps its refs for its actions.
      await page.mouse.move(0, 0);
      await render(page, "running", "dark", "default");
      rubric[name] = await check(page);
    } catch (error) {
      rubric[name] = false;
      notes[name] = String(error instanceof Error ? error.message : error).split("\n")[0]!.slice(0, 160);
    }
  }

  const points = Object.values(rubric).filter(Boolean).length;
  const score = points - 5 * failures.length;
  const byKind: Record<string, number> = {};
  for (const f of failures) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  const unique = new Map<string, Failure & { state: string; theme: string }>();
  for (const f of failures) unique.set(`${f.state}|${f.theme}|${f.kind}|${f.what.replace(/^\d+px /, "")}`, f);
  const detail = {
    score,
    points,
    max: RUBRIC.length,
    failures: failures.length,
    uniqueFailures: unique.size,
    measurements: measured,
    byKind,
    missed: Object.keys(rubric).filter((k) => !rubric[k]),
    notes,
    sample: [...unique.values()].slice(0, process.env.TASKS_SCORE_SAMPLE ? 400 : 25).map((f) => `${f.state} · ${f.theme} · ${f.kind} · ${f.what} · ${f.got}/${f.need}`),
    seconds: Math.round((Date.now() - started) / 1000),
  };
  console.log(`TASKS_SCORE ${score}`);
  console.log(`TASKS_SCORE_DETAIL ${JSON.stringify(detail)}`);
});
