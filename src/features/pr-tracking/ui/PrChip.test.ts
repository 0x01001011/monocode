// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ariaLabel, primaryEntry } from "../model/prSetModel";
import type { PrEntry, PrSetView, TrackerStatus } from "../model/types";

const h = vi.hoisted(() => ({
  view: null as PrSetView | null,
  setPrInterest: vi.fn(async () => undefined),
  refreshPrSet: vi.fn(async () => undefined),
  dismissPr: vi.fn(async () => undefined),
  openUrl: vi.fn(async () => undefined),
  copyText: vi.fn(async () => undefined),
}));

vi.mock("../data/prTracking", () => ({
  usePrSet: () => h.view,
  setPrInterest: h.setPrInterest,
  refreshPrSet: h.refreshPrSet,
  dismissPr: h.dismissPr,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.openUrl }));
vi.mock("../../../platform/tauri/clipboard", () => ({ copyText: h.copyText }));

import { PrChip, type PrChipProps } from "./PrChip";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.now();
const REPO = "acme/web";

function entry(
  number: number,
  over: Partial<PrEntry> & { snapshot?: Partial<PrEntry["snapshot"]> } = {},
): PrEntry {
  const { snapshot, ...rest } = over;
  return {
    snapshot: {
      repo: REPO,
      number,
      url: `https://github.com/${REPO}/pull/${number}`,
      title: `PR title ${number}`,
      state: "open",
      isDraft: false,
      headRef: `mc/branch-${number}`,
      baseRef: "main",
      originalBaseRef: "main",
      headOid: "abc",
      author: "maya",
      checks: "none",
      review: "none",
      mergeable: "mergeable",
      behindBy: null,
      fetchedAt: NOW - 5_000,
      ...snapshot,
    },
    relation: "owned",
    ownerSessionId: "s1",
    onLiveBranch: false,
    parent: null,
    attention: "none",
    attentionReason: null,
    dismissed: false,
    error: null,
    ...rest,
  };
}

/** The mockup's chat: a 3-PR stack (478 merged, 480, 482 HEAD failing) plus 475. */
function stackedView(over: Partial<PrSetView> = {}): PrSetView {
  return {
    sessionId: "s1",
    entries: [
      entry(478, {
        snapshot: { state: "merged", headRef: "mc/tasks-row-model" },
      }),
      entry(480, {
        parent: 478,
        attention: "action",
        attentionReason: "Needs restack",
        snapshot: {
          headRef: "mc/tasks-panel-virtual",
          baseRef: "mc/tasks-row-model",
          checks: "passing",
          review: "approved",
        },
      }),
      entry(482, {
        parent: 480,
        onLiveBranch: true,
        attention: "block",
        attentionReason: "Checks failing",
        snapshot: {
          title: "Tasks panel: keyboard audit fixes",
          headRef: "mc/tasks-panel-keyboard",
          baseRef: "mc/tasks-panel-virtual",
          checks: "failing",
        },
      }),
      entry(475, {
        snapshot: { state: "merged", headRef: "mc/sidebar-badge" },
      }),
    ],
    stacks: [
      { repo: REPO, baseRef: "main", members: [478, 480, 482], mergedCount: 1 },
    ],
    tracking: "full",
    status: "ok",
    refreshedAt: NOW - 12_000,
    ...over,
  };
}

let mounted: { root: Root; container: HTMLElement }[] = [];

function render(over: Partial<PrChipProps> = {}) {
  const props: PrChipProps = {
    sessionId: "s1",
    sessionTitle: "Tasks panel audit",
    onOpenInbox: vi.fn(),
    ...over,
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(PrChip, props)));
  mounted.push({ root, container });
  const rerender = (next: Partial<PrChipProps> = {}) =>
    act(() => root.render(createElement(PrChip, { ...props, ...next })));
  return { container, props, rerender, root };
}

const chip = () => document.querySelector<HTMLButtonElement>("button.pr-chip");
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const rows = () => [
  ...(dialog()?.querySelectorAll<HTMLAnchorElement>("[data-pr-row]") ?? []),
];

function pointer(element: Element, type: "pointerover" | "pointerout") {
  act(() => {
    element.dispatchEvent(
      new PointerEvent(type, { bubbles: true, pointerType: "mouse" }),
    );
  });
}

function key(target: Element, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function pin() {
  act(() => chip()!.click());
  expect(dialog()).not.toBeNull();
}

beforeEach(() => {
  h.view = stackedView();
  h.setPrInterest.mockClear();
  h.refreshPrSet.mockClear();
  h.dismissPr.mockClear();
  h.openUrl.mockClear();
  h.copyText.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted = [];
  document.body.innerHTML = "";
});

describe("PrChip trigger", () => {
  it("renders nothing without entries, whatever the tracker says", () => {
    const statuses: TrackerStatus[] = [
      "ok",
      "idle",
      "signedOut",
      "offline",
      { rateLimited: { until: NOW + 60_000 } },
    ];
    for (const status of statuses) {
      h.view = { ...stackedView(), entries: [], stacks: [], status };
      const { container } = render();
      expect(container.innerHTML, JSON.stringify(status)).toBe("");
    }
    h.view = null;
    expect(render().container.innerHTML).toBe("");
  });

  it("renders nothing when every PR is hidden", () => {
    h.view = stackedView({
      entries: stackedView().entries.map((e) => ({ ...e, dismissed: true })),
    });
    expect(render().container.innerHTML).toBe("");
  });

  it("shows the primary PR, its stack strip, +N and the attention mark", () => {
    render();
    const button = chip()!;
    const view = h.view!;
    expect(button.getAttribute("aria-label")).toBe(
      ariaLabel(view, primaryEntry(view)!),
    );
    expect(button.getAttribute("aria-label")).toBe(
      "PR 482 open, checks failing, stack 3 of 3, 4 pull requests",
    );
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBeNull();
    expect(
      button.querySelector(".pr-status")?.getAttribute("data-status"),
    ).toBe("open");
    expect(button.querySelector(".pr-chip-num")?.textContent).toBe("#482");
    const bars = [...button.querySelectorAll(".pr-strip > i")];
    expect(bars.map((b) => b.getAttribute("data-kind"))).toEqual([
      "merged",
      "normal",
      "current",
    ]);
    expect(button.querySelector(".pr-chip-more")?.textContent).toBe("+1");
    const mark = button.querySelector(".pr-att")!;
    expect(mark.getAttribute("data-kind")).toBe("block");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
  });

  it("drops the strip for a PR outside any stack and counts the rest as +N", () => {
    h.view = stackedView({ stacks: [] });
    render();
    expect(chip()!.querySelector(".pr-strip")).toBeNull();
    expect(chip()!.querySelector(".pr-chip-more")?.textContent).toBe("+3");
  });

  it("adds a clock and says so when the primary snapshot is stale", () => {
    const view = stackedView();
    view.entries[2].snapshot.fetchedAt = NOW - 11 * 60_000;
    h.view = view;
    render();
    expect(chip()!.querySelector('[data-pr-stale="true"]')).not.toBeNull();
    expect(chip()!.getAttribute("aria-label")).toMatch(
      /^PR 482 open, checks failing, stack 3 of 3, 4 pull requests, status may be out of date, updated 1[01]m ago$/,
    );
  });
});

describe("PrChip narrow composers", () => {
  it("sheds the strip and +N under 400px and the Worktree label under 320px of the row, not the window", () => {
    // vitest runs from the repo root.
    const css = readFileSync("src/styles/index.css", "utf8").replace(
      /\s+/g,
      " ",
    );
    expect(css).toContain(
      ".composer-head { container: composer-head / inline-size; }",
    );
    expect(css).toContain(
      ".composer-head > [data-branch-trigger] { min-width: min(14ch, 45%); }",
    );
    expect(css).toContain(
      "@container composer-head (max-width: 400px) { .pr-chip .pr-strip, .pr-chip .pr-chip-more { display: none; } }",
    );
    expect(css).toContain(
      "@container composer-head (max-width: 320px) { .composer-head .workspace-label { display: none; } }",
    );
  });
});

describe("PrChip interest", () => {
  it("is hot while mounted and active, fleet on unmount, blur or inactive", () => {
    const { rerender, root } = render();
    expect(h.setPrInterest).toHaveBeenLastCalledWith("s1", "hot");
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(h.setPrInterest).toHaveBeenLastCalledWith("s1", "fleet");
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(h.setPrInterest).toHaveBeenLastCalledWith("s1", "hot");
    rerender({ active: false });
    expect(h.setPrInterest).toHaveBeenLastCalledWith("s1", "fleet");
    rerender({ active: true });
    expect(h.setPrInterest).toHaveBeenLastCalledWith("s1", "hot");
    act(() => root.unmount());
    expect(h.setPrInterest).toHaveBeenLastCalledWith("s1", "fleet");
    mounted = [];
  });

  it("stays hot even before the first PR shows up", () => {
    h.view = null;
    render();
    expect(h.setPrInterest).toHaveBeenCalledWith("s1", "hot");
  });
});

describe("PrChip hover and pinned card", () => {
  it("opens the hover card after 220ms without taking focus, and closes 100ms after leaving", () => {
    vi.useFakeTimers();
    render();
    const button = chip()!;
    pointer(button, "pointerover");
    act(() => vi.advanceTimersByTime(219));
    expect(dialog()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    const card = dialog()!;
    expect(card).not.toBeNull();
    expect(card.getAttribute("aria-modal")).toBe("false");
    const title = document.getElementById(
      card.getAttribute("aria-labelledby")!,
    );
    expect(title?.textContent).toBe("4 pull requests from this chat");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe(card.id);
    expect(card.contains(document.activeElement)).toBe(false);

    pointer(button, "pointerout");
    act(() => vi.advanceTimersByTime(60));
    // Crossing the gap into the card keeps it open.
    pointer(dialog()!, "pointerover");
    act(() => vi.advanceTimersByTime(500));
    expect(dialog()).not.toBeNull();
    pointer(dialog()!, "pointerout");
    act(() => vi.advanceTimersByTime(99));
    expect(dialog()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(dialog()).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes a hover card on Escape from anywhere without moving focus", () => {
    vi.useFakeTimers();
    render();
    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    pointer(chip()!, "pointerover");
    act(() => vi.advanceTimersByTime(220));
    expect(dialog()).not.toBeNull();
    const event = key(elsewhere, { key: "Escape" });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    // Someone else's Escape still reaches them.
    expect(event.defaultPrevented).toBe(false);
  });

  it("pins on click, focuses the first row, and Escape returns focus to the chip", () => {
    render();
    pin();
    expect(document.activeElement).toBe(rows()[0]);
    expect(rows()[0].textContent).toContain("#482");
    // Pinned cards ignore the pointer leaving.
    vi.useFakeTimers();
    pointer(chip()!, "pointerout");
    act(() => vi.advanceTimersByTime(500));
    expect(dialog()).not.toBeNull();
    key(document.activeElement!, { key: "Escape" });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it("toggles closed on a second click", () => {
    render();
    pin();
    act(() => chip()!.click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it("closes and returns focus to the chip when tabbing past either end", () => {
    render();
    pin();
    const last = [
      ...dialog()!.querySelectorAll<HTMLButtonElement>(".pr-row-more"),
    ].at(-1)!;
    last.focus();
    const forward = key(last, { key: "Tab" });
    expect(forward.defaultPrevented).toBe(true);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(chip());

    pin();
    const refresh = dialog()!.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh pull request status"]',
    )!;
    refresh.focus();
    key(refresh, { key: "Tab", shiftKey: true });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it("lets Tab move between stops inside the card", () => {
    render();
    pin();
    const event = key(rows()[0], { key: "Tab" });
    expect(event.defaultPrevented).toBe(false);
    expect(dialog()).not.toBeNull();
  });

  it("roves the rows with ↑/↓/Home/End as one tab stop", () => {
    render();
    pin();
    const all = rows();
    expect(all.map((r) => r.querySelector(".pr-n")?.textContent)).toEqual([
      "#482",
      "#480",
      "#478",
      "#475",
    ]);
    expect(all.map((r) => r.tabIndex)).toEqual([0, -1, -1, -1]);
    key(all[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows()[1]);
    expect(rows().map((r) => r.tabIndex)).toEqual([-1, 0, -1, -1]);
    key(rows()[1], { key: "End" });
    expect(document.activeElement).toBe(rows()[3]);
    key(rows()[3], { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows()[0]);
    key(rows()[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows()[3]);
    key(rows()[3], { key: "Home" });
    expect(document.activeElement).toBe(rows()[0]);
    expect(rows().map((r) => r.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it("closes only the row menu on Escape inside it", () => {
    render();
    pin();
    const more = dialog()!.querySelector<HTMLButtonElement>(".pr-row-more")!;
    act(() => more.click());
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu).not.toBeNull();
    const item = menu.querySelector<HTMLElement>('[role="menuitem"]')!;
    expect(document.activeElement).toBe(item);
    key(item, { key: "Escape" });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(more);
    // The next Escape belongs to the card.
    key(more, { key: "Escape" });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it("keeps the card open while a row menu item is clicked", () => {
    render();
    pin();
    act(() =>
      dialog()!.querySelector<HTMLButtonElement>(".pr-row-more")!.click(),
    );
    const hide = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((i) => i.textContent === "Hide")!;
    act(() => {
      hide.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      hide.click();
    });
    expect(h.dismissPr).toHaveBeenCalledWith("s1", REPO, 482, true);
    expect(dialog()).not.toBeNull();
  });
});

describe("PrSetCard content", () => {
  it("lays out the stack tip-first in an ordered list, then Other, with the footer hints", () => {
    render();
    pin();
    const card = dialog()!;
    expect(card.querySelector(".pr-card-updated")?.textContent).toBe(
      "Updated 12s ago",
    );
    const stack = card.querySelector("ol")!;
    expect(stack).not.toBeNull();
    const label = document.getElementById(
      stack.getAttribute("aria-labelledby")!,
    )!;
    expect(label.textContent).toBe("Stack · 3 into main · 1 merged");
    expect(
      [...stack.querySelectorAll(".pr-n")].map((n) => n.textContent),
    ).toEqual(["#482", "#480", "#478"]);
    expect(
      stack.querySelector('[data-selected="true"] .pr-n')?.textContent,
    ).toBe("#482");
    expect(card.textContent).toContain("Other");
    expect(card.querySelector(".pr-card-foot")?.textContent).toBe(
      "↵Open in Inbox⌘↵Open on GitHub⌥↵Copy link",
    );
  });

  it("uses the singular title and no Other label without stacks", () => {
    h.view = stackedView({
      entries: [entry(471, { onLiveBranch: true })],
      stacks: [],
    });
    render();
    pin();
    const card = dialog()!;
    expect(card.querySelector(".pr-card-title")?.textContent).toBe(
      "1 pull request from this chat",
    );
    expect(card.querySelector("ol")).toBeNull();
    expect(card.querySelector(".pr-group-label")).toBeNull();
  });

  it("refreshes from the header button and disables it while rate limited", () => {
    render();
    pin();
    const refresh = () =>
      dialog()!.querySelector<HTMLButtonElement>(
        'button[aria-label="Refresh pull request status"]',
      )!;
    expect(refresh().disabled).toBe(false);
    act(() => refresh().click());
    expect(h.refreshPrSet).toHaveBeenCalledWith("s1");
  });

  it("disables refresh and says when status resumes while rate limited", () => {
    const until = NOW + 30 * 60_000;
    h.view = stackedView({ status: { rateLimited: { until } } });
    render();
    pin();
    const refresh = dialog()!.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh pull request status"]',
    )!;
    expect(refresh.disabled).toBe(true);
    expect(dialog()!.textContent).toContain(
      "GitHub rate limit reached. Status refreshes again at",
    );
    expect(dialog()!.querySelector(".pr-card-updated")?.textContent).toBe(
      "Last known · 12s ago",
    );
  });

  it("offers Retry for a signed-out tracker", () => {
    h.view = stackedView({ status: "signedOut" });
    render();
    pin();
    const notice = dialog()!.querySelector(".pr-notice")!;
    expect(notice.textContent).toContain(
      "GitHub CLI is signed out. Run gh auth login, then refresh.",
    );
    act(() => notice.querySelector<HTMLButtonElement>("button")!.click());
    expect(h.refreshPrSet).toHaveBeenCalledWith("s1");
  });

  it("tags limited tracking", () => {
    h.view = stackedView({ tracking: "limited" });
    render();
    pin();
    const tag = [...dialog()!.querySelectorAll(".pr-tag")].find(
      (t) => t.textContent === "Limited tracking",
    );
    expect(tag).toBeDefined();
  });

  it("counts hidden PRs and reveals them on demand", () => {
    const view = stackedView();
    view.entries[3] = { ...view.entries[3], dismissed: true };
    h.view = view;
    render();
    pin();
    const toggle = [
      ...dialog()!.querySelectorAll<HTMLButtonElement>("button"),
    ].find((b) => b.textContent === "Hidden · 1")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(rows()).toHaveLength(3);
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(rows()).toHaveLength(4);
    expect(rows()[3].querySelector(".pr-n")?.textContent).toBe("#475");
  });

  it("scrolls 8 long-title rows inside a 440px card", () => {
    const title =
      "Handle 😀 emoji, CJK 日本語のタイトル, and a very long title that keeps going well past the card edge";
    h.view = stackedView({
      entries: Array.from({ length: 8 }, (_, i) =>
        entry(440 + i, {
          onLiveBranch: i === 0,
          snapshot: {
            title:
              i === 0 ? title : `Follow-up ${i}: tidy session store migrations`,
            state: (["open", "merged", "open", "closed"] as const)[i % 4],
            isDraft: i % 4 === 2,
            headRef: `mc/very-long-branch-name-for-hardening-${i}`,
          },
        }),
      ),
      stacks: [],
    });
    render();
    pin();
    const card = dialog()!;
    expect(card.style.maxHeight).not.toBe("");
    expect(parseFloat(card.style.maxHeight)).toBeLessThanOrEqual(440);
    const body = card.querySelector(".pr-card-body")!;
    expect(body.classList).toContain("overflow-y-auto");
    expect(body.classList).toContain("min-h-0");
    expect(body.querySelectorAll("[data-pr-row]")).toHaveLength(8);
    expect(card.querySelector(".pr-ttl")?.getAttribute("title")).toBe(title);
    // Header and footer stay outside the scroller.
    expect(body.contains(card.querySelector(".pr-card-head"))).toBe(false);
    expect(body.contains(card.querySelector(".pr-card-foot"))).toBe(false);
  });
});

describe("PrChip row actions", () => {
  it("opens the PR in the Inbox and closes the card", () => {
    const { props } = render();
    pin();
    act(() => rows()[0].click());
    expect(props.onOpenInbox).toHaveBeenCalledWith({
      kind: "pr",
      repo: REPO,
      number: 482,
      url: `https://github.com/${REPO}/pull/482`,
    });
    expect(dialog()).toBeNull();
  });

  it("falls back to GitHub without an Inbox handler", () => {
    render({ onOpenInbox: undefined });
    pin();
    act(() => rows()[0].click());
    expect(h.openUrl).toHaveBeenCalledWith(
      `https://github.com/${REPO}/pull/482`,
    );
  });

  it("opens GitHub on ⌘-click and copies the link on ⌥-click with a status message", async () => {
    render();
    pin();
    act(() => {
      rows()[1].dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          metaKey: true,
        }),
      );
    });
    expect(h.openUrl).toHaveBeenCalledWith(
      `https://github.com/${REPO}/pull/480`,
    );
    pin();
    await act(async () => {
      rows()[1].dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          altKey: true,
        }),
      );
    });
    expect(h.copyText).toHaveBeenCalledWith(
      `https://github.com/${REPO}/pull/480`,
    );
    expect(dialog()!.querySelector('[role="status"]')?.textContent).toBe(
      "Copied link to #480",
    );
  });
});
