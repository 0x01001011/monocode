// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrEntry, PrSetView, TrackerStatus } from "../model/types";

const h = vi.hoisted(() => ({
  view: null as PrSetView | null,
  refreshPrSet: vi.fn(async () => undefined),
  dismissPr: vi.fn(async () => undefined),
  openUrl: vi.fn(async () => undefined),
  copyText: vi.fn(async () => undefined),
}));

vi.mock("../data/prTracking", () => ({
  usePrSet: () => h.view,
  refreshPrSet: h.refreshPrSet,
  dismissPr: h.dismissPr,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.openUrl }));
vi.mock("../../../platform/tauri/clipboard", () => ({ copyText: h.copyText }));

import { PrSection, type PrSectionProps } from "./PrSection";

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

/** The mockup's panel: 478 merged, 480, 482 on the live branch, plus 475. */
function panelView(over: Partial<PrSetView> = {}): PrSetView {
  return {
    sessionId: "s1",
    entries: [
      entry(478, {
        snapshot: { state: "merged", headRef: "mc/tasks-row-model" },
      }),
      entry(480, {
        parent: 478,
        snapshot: { headRef: "mc/tasks-panel-virtual" },
      }),
      entry(482, {
        parent: 480,
        onLiveBranch: true,
        snapshot: {
          title: "Tasks panel: keyboard audit fixes",
          headRef: "mc/tasks-panel-keyboard",
          baseRef: "mc/tasks-panel-virtual",
        },
      }),
      entry(475, { snapshot: { headRef: "mc/sidebar-badge" } }),
    ],
    stacks: [
      { repo: REPO, baseRef: "main", members: [478, 480, 482], mergedCount: 1 },
    ],
    tracking: "full",
    status: "ok",
    refreshedAt: NOW - 40_000,
    ...over,
  };
}

let mounted: { root: Root; container: HTMLElement }[] = [];

function render(over: Partial<PrSectionProps> = {}) {
  const props: PrSectionProps = {
    sessionId: "s1",
    onOpenInbox: vi.fn(),
    ...over,
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(PrSection, props)));
  mounted.push({ root, container });
  const rerender = () =>
    act(() => root.render(createElement(PrSection, { ...props })));
  return { container, props, rerender };
}

const rows = (root: ParentNode = document) => [
  ...root.querySelectorAll<HTMLAnchorElement>("[data-pr-row]"),
];
const buttonByText = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === text,
  );

function key(target: Element, init: KeyboardEventInit) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}

beforeEach(() => {
  h.view = panelView();
  h.refreshPrSet.mockClear();
  h.dismissPr.mockClear();
  h.openUrl.mockClear();
  h.copyText.mockClear();
});

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted = [];
  document.body.innerHTML = "";
});

describe("PrSection", () => {
  it("renders no DOM with zero PRs, while loading, or with every PR hidden", () => {
    const statuses: TrackerStatus[] = ["ok", "signedOut", "offline"];
    for (const status of statuses) {
      h.view = { ...panelView(), entries: [], stacks: [], status };
      expect(render().container.innerHTML).toBe("");
    }
    h.view = null;
    expect(render().container.innerHTML).toBe("");
    h.view = panelView({
      entries: panelView().entries.map((e) => ({ ...e, dismissed: true })),
    });
    expect(render().container.innerHTML).toBe("");
  });

  it("lists N rows under 'Pull requests · N' with exactly one tab stop", () => {
    const { container } = render();
    const heading = container.querySelector("[data-pr-section-title]");
    expect(heading?.textContent).toBe("Pull requests");
    expect(
      container.querySelector("[data-pr-section-count]")?.textContent,
    ).toBe("4");
    const list = rows(container);
    expect(list).toHaveLength(4);
    expect(list.filter((r) => r.tabIndex === 0)).toHaveLength(1);
    expect(list.filter((r) => r.tabIndex === -1)).toHaveLength(3);
  });

  it("puts the live-branch row first with the selected fill and HEAD tag", () => {
    const { container } = render();
    const first = container.querySelector<HTMLElement>(".pr-row");
    expect(first?.dataset.selected).toBe("true");
    expect(first?.querySelector(".pr-n")?.textContent).toBe("#482");
    expect(first?.querySelector('.pr-tag[data-tone="head"]')?.textContent).toBe(
      "HEAD",
    );
    expect(
      container.querySelectorAll('.pr-row[data-selected="true"]'),
    ).toHaveLength(1);
  });

  it("names the prlist container so rows go narrow under 340px", () => {
    const { container } = render();
    const section = container.querySelector(".pr-section");
    expect(section?.classList.contains("pr-list-container")).toBe(true);
    for (const row of container.querySelectorAll(".pr-row"))
      expect(row.classList.contains("pr-row-cq")).toBe(true);
  });

  it("moves the single tab stop with the arrow keys", () => {
    const { container } = render();
    const list = rows(container);
    act(() => list[0].focus());
    key(list[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(list[1]);
    expect(rows(container).filter((r) => r.tabIndex === 0)).toEqual([list[1]]);
    key(list[1], { key: "End" });
    expect(document.activeElement).toBe(list[3]);
    key(list[3], { key: "Home" });
    expect(document.activeElement).toBe(list[0]);
  });

  it("opens the live PR in Inbox from the split button's primary action", () => {
    const { props } = render();
    const view = buttonByText("View #482");
    expect(view).toBeDefined();
    act(() => view!.click());
    expect(props.onOpenInbox).toHaveBeenCalledWith({
      kind: "pr",
      repo: REPO,
      number: 482,
      url: `https://github.com/${REPO}/pull/482`,
    });
  });

  it("opens GitHub from the primary action without an Inbox callback", () => {
    render({ onOpenInbox: undefined });
    act(() => buttonByText("View #482")!.click());
    expect(h.openUrl).toHaveBeenCalledWith(
      `https://github.com/${REPO}/pull/482`,
    );
  });

  it("lists the other PRs in the caret menu", () => {
    const { props } = render();
    const caret = document.querySelector<HTMLButtonElement>(
      'button[aria-label="More pull requests"]',
    );
    expect(caret?.getAttribute("aria-haspopup")).toBe("menu");
    act(() => caret!.click());
    const menu = document.querySelector('[role="menu"][data-pr-split-menu]');
    expect(menu).not.toBeNull();
    const items = [...menu!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((i) => i.dataset.prNumber)).toEqual(["480", "478", "475"]);
    expect(items[0].textContent).toContain("#480");
    act(() => items[2].click());
    expect(props.onOpenInbox).toHaveBeenCalledWith(
      expect.objectContaining({ number: 475 }),
    );
    expect(document.querySelector("[data-pr-split-menu]")).toBeNull();
  });

  it("falls back to the checkout's open PR when no row is on the live branch", () => {
    h.view = panelView({
      entries: panelView().entries.map((e) => ({ ...e, onLiveBranch: false })),
    });
    render({
      onOpenInbox: undefined,
      pr: {
        number: 501,
        title: "x",
        url: "https://github.com/acme/web/pull/501",
        state: "open",
      },
    });
    act(() => buttonByText("View #501")!.click());
    expect(h.openUrl).toHaveBeenCalledWith(
      "https://github.com/acme/web/pull/501",
    );
  });

  it("shows no split button with neither a live PR nor an open checkout PR", () => {
    h.view = panelView({
      entries: panelView().entries.map((e) => ({ ...e, onLiveBranch: false })),
    });
    render();
    expect(
      [...document.querySelectorAll("button")].some((b) =>
        b.textContent?.startsWith("View #"),
      ),
    ).toBe(false);
  });

  it("shows the tracker notice for an error state, with Retry", () => {
    h.view = panelView({ status: "signedOut" });
    const { container } = render();
    expect(container.querySelector(".pr-notice")?.textContent).toContain(
      "GitHub CLI is signed out. Run gh auth login, then refresh.",
    );
    act(() => buttonByText("Retry")!.click());
    expect(h.refreshPrSet).toHaveBeenCalledWith("s1");
  });

  it("shows no notice while the tracker is fine", () => {
    const { container } = render();
    expect(container.querySelector(".pr-notice")).toBeNull();
  });

  it("keeps Hidden #N with Undo after hiding the last visible row", () => {
    h.view = panelView({
      entries: [entry(482, { onLiveBranch: true })],
      stacks: [],
    });
    const { container, rerender } = render();
    const row = rows(container)[0];
    act(() => row.focus());
    key(row, { key: "Backspace" });
    expect(h.dismissPr).toHaveBeenCalledWith("s1", REPO, 482, true);

    h.view = panelView({
      entries: [entry(482, { onLiveBranch: true, dismissed: true })],
      stacks: [],
    });
    rerender();
    expect(rows(container)).toHaveLength(0);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Hidden #482",
    );
    const undo = buttonByText("Undo");
    expect(undo).toBeDefined();
    expect(document.activeElement).toBe(undo);
    act(() => undo!.click());
    expect(h.dismissPr).toHaveBeenLastCalledWith("s1", REPO, 482, false);
  });

  it("marks a stale freshness label like the card does", () => {
    h.view = panelView({ refreshedAt: NOW - 11 * 60_000 });
    const { container } = render();
    expect(
      container.querySelector<HTMLElement>(".pr-card-updated")?.dataset.stale,
    ).toBe("true");
  });

  it("leaves a fresh label unmarked", () => {
    const { container } = render();
    expect(
      container.querySelector<HTMLElement>(".pr-card-updated")?.dataset.stale,
    ).toBeUndefined();
  });
});
