import { expect, test, type Page } from "@playwright/test";
import { THEMES, type Failure } from "./contrast";
import { FLOW_LIST, measureAt, openEverything, openFixture, render, scrollToEnd, SCORED_STATES, WIDTHS } from "./tasks-fixture";

// The Tasks tab score for the autoresearch loop: `TASKS_SCORE = rubric points - 5 x a11y failures`.
// Higher is better. It is a metric: a low score never fails the test, only a crash does.
//
// Rubric, 1 point each: every gap kind visible (in `problems`; "no final review" cannot coexist
// with unfinished tasks, so it is read from `done-no-final`), each ref tone visible, the NOW pill
// and its accent colour, the fork cell, the merge cell, worker lanes, the Ship ready text, Ship's
// unmet buttons, each filter, the sticky bar, the `o`, `c` and `n` keys, Copy summary, each note
// group, a commit link that opens, row heights, a commit range's two ends at 340 px, stopped stage
// clocks, visible "Copied" feedback (key `c` without moving rows, and the menu), header tab order
// at 240 px, the strip's running colour, filled versus hollow nodes, and 100 px titles at 340 px.
// `readings` in the detail says what each check measured. Failures: contrast (text 4.5, non-text 3), targets under 24 px and horizontal
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

/** Two animation frames: React has committed and container queries have settled. */
const settle = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

/** Renders `state` with the panel's clock moved `offsetMs` past the fixture's `NOW`. */
async function renderAt(page: Page, state: string, offsetMs: number) {
  await page.evaluate(([st, off]) => window.showTasks(st as string, off as number), [state, offsetMs] as const);
  await settle(page);
  await page.locator(FLOW_LIST).waitFor();
}

/** The top of every visible tree row, to tell whether something pushed the rows down. */
const rowTops = (page: Page) =>
  page
    .locator('[role="treeitem"] > [data-row]')
    .evaluateAll((els) => els.filter((el) => el.getClientRects().length > 0).map((el) => el.getBoundingClientRect().top));

/**
 * Whether a "Copied" text is on screen: a box at least 4 px each way, inside the fixture root and
 * every overflow box around it, not display none, visibility hidden, opacity 0, clipped or
 * transparent. A screen-reader-only live region (1 px, clipped) does not count. Self-contained:
 * Playwright sends it to the page as source.
 */
function copiedShown(): string | false {
  const inside = (r: DOMRect, a: DOMRect) => r.left >= a.left - 1 && r.right <= a.right + 1 && r.top >= a.top - 1 && r.bottom <= a.bottom + 1;
  const rootBox = document.getElementById("root")!.getBoundingClientRect();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!/\bCopied\b/.test(n.textContent ?? "")) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || !inside(r, rootBox)) continue;
    let shown = true;
    for (let e: Element | null = n.parentElement; e && shown; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) shown = false;
      else if ((cs.clip !== "auto" && cs.clip !== "") || cs.clipPath !== "none") shown = false;
      else if (cs.overflow !== "visible" && !inside(r, e.getBoundingClientRect())) shown = false;
      else if (e === n.parentElement && /rgba\(.*,\s*0\)$|transparent/.test(cs.color)) shown = false;
    }
    if (shown) return `${(n.textContent ?? "").trim()} ${Math.round(r.width)}x${Math.round(r.height)}`;
  }
  return false;
}

/** Waits up to `ms` (from `since`) for a visible "Copied"; the text and its size, or false. */
async function copiedWithin(page: Page, since: number, ms: number): Promise<string | false> {
  try {
    const handle = await page.waitForFunction(copiedShown, null, { timeout: Math.max(1, ms - (Date.now() - since)), polling: "raf" });
    return (await handle.jsonValue()) as string;
  } catch {
    return false;
  }
}

/**
 * How a row's graph node is painted, over the row's composited background: whether its largest
 * shape is filled (fill reaches 2:1 against the background) and whether it is outlined (stroke
 * reaches 2:1). A hollow node is outlined with a fill under 1.2:1 (none, or the background).
 */
const nodeLook = (page: Page, id: string) =>
  page.evaluate((rowId) => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const cx = cv.getContext("2d", { willReadFrequently: true })!;
    const rgba = (c: string): number[] => {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = "#000";
      cx.fillStyle = c;
      cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
    };
    const over = (top: number[], bot: number[]) => {
      const a = top[3]!;
      return [0, 1, 2].map((i) => top[i]! * a + bot[i]! * (1 - a)).concat(1);
    };
    const lum = (c: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
    };
    const ratio = (a: number[], b: number[]) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x! + 0.05) / (y! + 0.05);
    };
    const li = document.querySelector(`[role="treeitem"][data-row-id="${rowId}"]`);
    const node = li?.querySelector("svg[data-gutter] [data-node]") as SVGGraphicsElement | null;
    if (!li || !node) return null;
    const chain: Element[] = [];
    for (let e: Element | null = li.querySelector("[data-row]"); e; e = e.parentElement) chain.push(e);
    let bg = [0, 0, 0, 1];
    for (const e of chain.reverse()) {
      const c = rgba(getComputedStyle(e).backgroundColor);
      if (c[3]! > 0) bg = over(c, bg);
    }
    const shapes = (node.tagName === "g" ? Array.from(node.children) : [node]) as SVGGraphicsElement[];
    const area = (el: SVGGraphicsElement) => {
      const b = el.getBBox();
      return b.width * b.height;
    };
    const big = shapes.reduce((a, b) => (area(b) > area(a) ? b : a));
    const cs = getComputedStyle(big);
    const paint = (value: string, opacity: string) => {
      if (value === "none" || value.startsWith("url")) return 1;
      const c = rgba(value === "currentcolor" ? cs.color : value);
      c[3] = c[3]! * Number(opacity) * Number(cs.opacity);
      return c[3]! > 0 ? ratio(over(c, bg), bg) : 1;
    };
    const fill = paint(cs.fill, cs.fillOpacity);
    const stroke = parseFloat(cs.strokeWidth) > 0 ? paint(cs.stroke, cs.strokeOpacity) : 1;
    return { fill: +fill.toFixed(2), stroke: +stroke.toFixed(2), filled: fill >= 2, hollow: fill < 1.2 && stroke >= 2 };
  }, id);

/** The composited colour of each strip segment status, in the order asked. */
const segmentColours = (page: Page, statuses: string[]) =>
  page.evaluate((wanted) => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const cx = cv.getContext("2d", { willReadFrequently: true })!;
    const rgba = (c: string): number[] => {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = "#000";
      cx.fillStyle = c;
      cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
    };
    return wanted.map((status) => {
      const seg = document.querySelector(`[data-strip] [data-status="${status}"]`);
      if (!seg || seg.getClientRects().length === 0) return null;
      let out = [0, 0, 0];
      const chain: Element[] = [];
      for (let e: Element | null = seg; e; e = e.parentElement) chain.push(e);
      for (const e of chain.reverse()) {
        const c = rgba(getComputedStyle(e).backgroundColor);
        out = out.map((v, i) => c[i]! * c[3]! + v * (1 - c[3]!));
      }
      return out.map(Math.round);
    });
  }, statuses);

/** The title span of each visible task row, and its width. */
const taskTitleWidths = (page: Page) =>
  page.locator('[role="treeitem"]').evaluateAll((els) =>
    els
      .filter((el) => /^task-\d+$/.test(el.getAttribute("data-row-id") ?? "") && el.getClientRects().length > 0)
      .map((el) => {
        const title = el.querySelector("[data-row] span[title]:not([data-ref]):not([data-meta]):not([data-now-pill])");
        return { id: el.getAttribute("data-row-id")!, width: title ? Math.round(title.getBoundingClientRect().width) : 0 };
      }),
  );

const MAIN_ROW = /^(task-\d+|final-review|hidden:.+)$/;
const mainRows = async (page: Page) => (await visibleRowIds(page)).filter((id) => MAIN_ROW.test(id));

/** Each rubric item: a name and a check that resolves true when the panel does it. */
type Check = (page: Page, note: (measured: string) => void) => Promise<boolean>;
const RUBRIC: [string, Check][] = [
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
  ).map(([tone, cls]): [string, Check] => [
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
  [
    "row heights",
    async (page, note) => {
      await render(page, "running");
      await openRow(page, "task-2");
      const heights = await page.locator('[role="treeitem"]').evaluateAll((els) =>
        els
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => ({ id: el.getAttribute("data-row-id")!, h: +el.querySelector("[data-row]")!.getBoundingClientRect().height.toFixed(1) })),
      );
      const tasks = heights.filter((r) => /^task-\d+$/.test(r.id));
      const stages = heights.filter((r) => /:(stage:\d+|merge)$/.test(r.id));
      const bad = [...tasks.filter((r) => r.h < 26 || r.h > 30), ...stages.filter((r) => r.h < 22 || r.h > 26)];
      note(`tasks ${[...new Set(tasks.map((r) => r.h))].join("/")}px, stages ${[...new Set(stages.map((r) => r.h))].join("/")}px; off: ${bad.map((r) => `${r.id}=${r.h}`).join(" ") || "none"}`);
      return tasks.length >= 5 && stages.length >= 4 && bad.length === 0;
    },
  ],
  [
    "NOW tone: accent",
    async (page, note) => {
      await render(page, "running");
      if (!(await isVisible(page, '[data-row-id="task-3"] [data-now-pill]'))) return false;
      const colours = await page.evaluate(() => {
        const pill = document.querySelector('[data-row-id="task-3"] [data-now-pill]')!;
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--color-accent)";
        pill.parentElement!.append(probe);
        const accent = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const token = getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim();
        return { pill: getComputedStyle(pill).backgroundColor, accent, token };
      });
      note(`pill ${colours.pill}, accent ${colours.accent}`);
      const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
      const [p, a] = [rgb(colours.pill), rgb(colours.accent)];
      return colours.token !== "" && p.length >= 3 && a.length >= 3 && (p[3] ?? 1) === 1 && [0, 1, 2].every((i) => Math.abs(p[i]! - a[i]!) <= 1);
    },
  ],
  [
    "commit range at 340 px",
    async (page, note) => {
      await render(page, "running");
      await openRow(page, "task-2");
      // Shown: rendered, not hidden or transparent, and inside every box that clips it (up to the row).
      const shas = await row(page, "task-2:merge").evaluate((li) =>
        Array.from(li.querySelectorAll("button[data-sha]")).map((b) => {
          const r = b.getBoundingClientRect();
          const cs = getComputedStyle(b);
          let shown = b.getClientRects().length > 0 && cs.visibility !== "hidden" && r.width > 0;
          for (let e: Element | null = b; shown && e && e !== li.parentElement; e = e.parentElement) {
            const es = getComputedStyle(e);
            if (Number(es.opacity) === 0) shown = false;
            else if (e !== b && es.overflow !== "visible") {
              const a = e.getBoundingClientRect();
              shown = r.left >= a.left - 0.5 && r.right <= a.right + 0.5;
            }
          }
          return { sha: b.getAttribute("data-sha"), text: (b.textContent ?? "").trim(), shown, width: Math.round(r.width) };
        }),
      );
      note(shas.map((s) => `${s.sha} ${s.shown ? `shown ${s.width}px` : "hidden"}`).join(", ") || "no sha buttons");
      return ["44aa0b1", "9f8e7d6"].every((sha) => shas.some((s) => s.sha === sha && s.text === sha && s.shown));
    },
  ],
  [
    "stage clocks stop",
    async (page, note) => {
      const read = async (offset: number) => {
        await renderAt(page, "running", offset);
        await openRow(page, "task-2");
        const meta = (id: string) =>
          row(page, id)
            .locator(":scope > [data-row] [data-meta]")
            .evaluateAll((els) => els.map((el) => (el.textContent ?? "").trim()).join("|"));
        return { review: await meta("task-2:stage:1"), running: await meta("task-3") };
      };
      const before = await read(0);
      const later = await read(30 * 60_000);
      note(`review "${before.review}" -> "${later.review}"; task 3 "${before.running}" -> "${later.running}"`);
      return before.review !== "" && before.review === later.review && before.running !== "" && before.running !== later.running;
    },
  ],
  [
    "copy feedback: key c",
    async (page, note) => {
      await render(page, "running");
      await row(page, "task-1").focus();
      const before = await rowTops(page);
      const since = Date.now();
      await page.keyboard.press("c");
      const shown = await copiedWithin(page, since, 600);
      const after = await rowTops(page);
      const moved = before.length !== after.length ? Infinity : Math.max(0, ...before.map((t, i) => Math.abs(t - after[i]!)));
      const copied = (await events(page)).some((e) => e.type === "copy" && e.text === "1a2b3c4");
      note(`${shown ? `"${shown}"` : "no visible Copied"} in 600 ms; rows moved ${Number.isFinite(moved) ? moved.toFixed(1) : "(count changed)"} px`);
      return copied && shown !== false && moved <= 1;
    },
  ],
  [
    "copy feedback: menu",
    async (page, note) => {
      await render(page, "running");
      await page.getByRole("button", { name: "More plan actions" }).click();
      const since = Date.now();
      await page.getByRole("menuitem", { name: "Copy summary" }).click();
      const shown = await copiedWithin(page, since, 600);
      const copied = (await events(page)).some((e) => e.type === "copy" && (e.text ?? "").startsWith("# tasks-graph"));
      note(shown ? `"${shown}"` : "no visible Copied in 600 ms");
      return copied && shown !== false;
    },
  ],
  [
    "header order at 240 px",
    async (page, note) => {
      await render(page, "running", "dark", "default", 240);
      await settle(page);
      const order = await page.evaluate(() => {
        const header = document.querySelector('select[aria-label="Plan"]')!.parentElement!;
        const controls = Array.from(header.querySelectorAll<HTMLElement>('button, select, input, a[href], [tabindex]'))
          .filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0)
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { name: el.getAttribute("aria-label") ?? (el.textContent ?? "").trim(), y: r.top + r.height / 2, x: r.left };
          });
        // Lines: a control more than 8 px below the line's first centre starts a new line.
        const byY = [...controls].sort((a, b) => a.y - b.y);
        const lines: (typeof controls)[] = [];
        for (const c of byY) {
          const line = lines[lines.length - 1];
          if (line && c.y - line[0]!.y <= 8) line.push(c);
          else lines.push([c]);
        }
        const visual = lines.flatMap((line) => line.sort((a, b) => a.x - b.x));
        return { dom: controls.map((c) => c.name), visual: visual.map((c) => c.name) };
      });
      note(`tab: ${order.dom.join(" > ")}; seen: ${order.visual.join(" > ")}`);
      return order.dom.length >= 3 && JSON.stringify(order.dom) === JSON.stringify(order.visual);
    },
  ],
  [
    "strip: running colour",
    async (page, note) => {
      await render(page, "running");
      const [running, done, pending] = await segmentColours(page, ["running", "done", "pending"]);
      if (!running || !done || !pending) return false;
      // Apart by at least 32 in RGB distance: a one-unit nudge is not a different colour.
      const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
      note(`running rgb(${running}) vs done rgb(${done}) ${dist(running, done).toFixed(0)}, vs pending rgb(${pending}) ${dist(running, pending).toFixed(0)}`);
      return dist(running, done) >= 32 && dist(running, pending) >= 32;
    },
  ],
  [
    "node shapes",
    async (page, note) => {
      await render(page, "problems");
      const attention = await nodeLook(page, "task-7");
      const review7 = await nodeLook(page, "task-7:stage:1");
      await render(page, "running");
      await openRow(page, "task-2");
      const review2 = await nodeLook(page, "task-2:stage:1");
      const say = (l: Awaited<ReturnType<typeof nodeLook>>) => (l ? `fill ${l.fill} stroke ${l.stroke}` : "missing");
      note(`task-7 (attention) ${say(attention)}; reviews: task-7 ${say(review7)}, task-2 ${say(review2)}`);
      return !!attention?.filled && !!review7?.hollow && !!review2?.hollow;
    },
  ],
  [
    "title room at 340 px",
    async (page, note) => {
      const narrow: string[] = [];
      let seen = 0;
      for (const state of ["running", "problems"]) {
        await render(page, state);
        const widths = await taskTitleWidths(page);
        seen += widths.length;
        for (const w of widths) if (w.width < 100) narrow.push(`${state} ${w.id}=${w.width}`);
      }
      note(narrow.length > 0 ? `under 100 px: ${narrow.join(", ")}` : `all ${seen} titles >= 100 px`);
      return seen >= 10 && narrow.length === 0;
    },
  ],
  [
    "refs readable",
    async (page, note) => {
      const bad: string[] = [];
      let pills = 0;
      let hidden = 0;
      for (const state of ["running", "problems"]) {
        for (const width of [240, 340]) {
          await render(page, state, "dark", "default", width);
          await page.mouse.move(0, 0);
          await settle(page);
          const found = await page.locator('[role="treeitem"]').evaluateAll((els) =>
            els
              .filter((el) => /^task-\d+$/.test(el.getAttribute("data-row-id") ?? "") && el.getClientRects().length > 0)
              .flatMap((el) => {
                const id = el.getAttribute("data-row-id")!;
                const all = Array.from(el.querySelectorAll<HTMLElement>("[data-row] [data-ref], [data-row] [data-now-pill]"));
                const shown = all.filter((p) => getComputedStyle(p).display !== "none" && p.getClientRects().length > 0);
                const firstRef = el.querySelector<HTMLElement>("[data-row] [data-ref]");
                const out = shown.map((p) => ({ id, text: p.textContent ?? "", scroll: p.scrollWidth, client: p.clientWidth, hiddenFirst: false }));
                if (firstRef && !shown.includes(firstRef)) out.push({ id, text: firstRef.textContent ?? "", scroll: 0, client: 0, hiddenFirst: true });
                return out;
              }),
          );
          for (const p of found) {
            if (p.hiddenFirst) {
              hidden++;
              bad.push(`${state}@${width} ${p.id} first ref "${p.text}" hidden`);
              continue;
            }
            pills++;
            if (p.scroll > p.client + 1) bad.push(`${state}@${width} ${p.id} "${p.text}" ${p.scroll}/${p.client}`);
          }
        }
      }
      await render(page, "running");
      note(bad.length > 0 ? `cut: ${bad.join("; ")}` : `all ${pills} pills fit`);
      return pills >= 8 && hidden === 0 && bad.length === 0;
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
  // What each check measured, so the loop can see how far a missed point is.
  const readings: Record<string, string> = {};
  for (const [name, check] of RUBRIC) {
    try {
      // The pointer rests outside the panel: a hovered row swaps its refs for its actions.
      await page.mouse.move(0, 0);
      await render(page, "running", "dark", "default");
      rubric[name] = await check(page, (text) => {
        readings[name] = text;
      });
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
    readings,
    sample: [...unique.values()].slice(0, process.env.TASKS_SCORE_SAMPLE ? 400 : 25).map((f) => `${f.state} · ${f.theme} · ${f.kind} · ${f.what} · ${f.got}/${f.need}`),
    seconds: Math.round((Date.now() - started) / 1000),
  };
  console.log(`TASKS_SCORE ${score}`);
  console.log(`TASKS_SCORE_DETAIL ${JSON.stringify(detail)}`);
});
