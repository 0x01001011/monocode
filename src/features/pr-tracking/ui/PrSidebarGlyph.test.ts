// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkedWorkItem } from "../../sessions/model/session";
import type { PrEntry, PrSetView, PrSummary } from "../model/types";

const h = vi.hoisted(() => ({
  summary: undefined as PrSummary | undefined,
  view: null as PrSetView | null,
  linkedInSet: false,
  usePrSet: vi.fn(),
  usePrSummary: vi.fn(),
  useLinkedPrInSet: vi.fn(),
  getPrSet: vi.fn(),
  setPrInterest: vi.fn(async () => undefined),
  refreshPrSet: vi.fn(async () => undefined),
  dismissPr: vi.fn(async () => undefined),
  openUrl: vi.fn(async () => undefined),
  copyText: vi.fn(async () => undefined),
}));

vi.mock("../data/prTracking", () => ({
  usePrSummary: h.usePrSummary,
  usePrSet: h.usePrSet,
  useLinkedPrInSet: h.useLinkedPrInSet,
  getPrSet: h.getPrSet,
  setPrInterest: h.setPrInterest,
  refreshPrSet: h.refreshPrSet,
  dismissPr: h.dismissPr,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.openUrl }));
vi.mock("../../../platform/tauri/clipboard", () => ({ copyText: h.copyText }));

import {
  PR_SIDEBAR_OPEN_DELAY,
  PrSidebarGlyph,
  PrSidebarSlot,
  sidebarGlyphLabel,
} from "./PrSidebarGlyph";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.now();
const REPO = "acme/web";

function summary(over: Partial<PrSummary> = {}): PrSummary {
  return {
    count: 1,
    primaryNumber: 482,
    primaryState: "open",
    primaryIsDraft: false,
    attention: "none",
    stale: false,
    ...over,
  };
}

function entry(number: number): PrEntry {
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
    },
    relation: "owned",
    ownerSessionId: "s1",
    onLiveBranch: true,
    parent: null,
    attention: "none",
    attentionReason: null,
    dismissed: false,
    error: null,
  };
}

const view = (): PrSetView => ({
  sessionId: "s1",
  entries: [entry(482)],
  stacks: [],
  tracking: "full",
  status: "ok",
  refreshedAt: NOW - 5_000,
});

const linkedPr: LinkedWorkItem = {
  kind: "pr",
  repo: REPO,
  number: 482,
  url: `https://github.com/${REPO}/pull/482`,
};

let mounted: { root: Root; container: HTMLElement }[] = [];

function mount(node: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

const badge = () =>
  createElement("button", { type: "button", "data-badge": "" }, "#482");

function slot(linkedWorkItem?: LinkedWorkItem) {
  return mount(
    createElement(PrSidebarSlot, {
      sessionId: "s1",
      linkedWorkItem,
      badge: linkedWorkItem ? badge() : null,
    }),
  );
}

const glyph = () => document.querySelector<HTMLButtonElement>("button.sb-glyph");
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

function pointer(element: Element, type: "pointerover" | "pointerout") {
  act(() => {
    element.dispatchEvent(
      new PointerEvent(type, { bubbles: true, pointerType: "mouse" }),
    );
  });
}

beforeEach(() => {
  h.summary = undefined;
  h.view = view();
  h.linkedInSet = false;
  h.usePrSummary.mockReset().mockImplementation(() => h.summary);
  h.usePrSet
    .mockReset()
    .mockImplementation((id?: string) => (id ? h.view : null));
  h.useLinkedPrInSet
    .mockReset()
    .mockImplementation((id?: string) => (id ? h.linkedInSet : false));
  h.getPrSet.mockReset().mockImplementation(() => h.view);
  h.setPrInterest.mockClear();
  h.refreshPrSet.mockClear();
  h.dismissPr.mockClear();
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

describe("PrSidebarSlot", () => {
  it("leaves the linked badge exactly as before and shows no glyph for a chat with zero PRs", () => {
    const container = slot(linkedPr);
    expect(container.innerHTML).toBe(
      '<button type="button" data-badge="">#482</button>',
    );
    expect(glyph()).toBeNull();
    // Without PRs there is nothing to compare against, so no set fetch.
    expect(h.useLinkedPrInSet).toHaveBeenLastCalledWith(undefined, linkedPr);
  });

  it("renders nothing for a chat with neither PRs nor a linked item", () => {
    expect(slot().innerHTML).toBe("");
  });

  it("replaces the badge with the glyph when the linked PR is in the chat's set", () => {
    h.summary = summary();
    h.linkedInSet = true;
    slot(linkedPr);
    expect(document.querySelector("[data-badge]")).toBeNull();
    expect(glyph()).not.toBeNull();
    expect(h.useLinkedPrInSet).toHaveBeenLastCalledWith("s1", linkedPr);
  });

  it("keeps the badge and adds the glyph when the linked PR is not in the set", () => {
    h.summary = summary({ count: 2 });
    h.linkedInSet = false;
    slot(linkedPr);
    expect(document.querySelector("[data-badge]")).not.toBeNull();
    expect(glyph()).not.toBeNull();
  });

  it("keeps an issue badge and adds the glyph, without looking up the set", () => {
    h.summary = summary();
    h.linkedInSet = true;
    const issue: LinkedWorkItem = { ...linkedPr, kind: "issue" };
    slot(issue);
    expect(document.querySelector("[data-badge]")).not.toBeNull();
    expect(glyph()).not.toBeNull();
    expect(h.useLinkedPrInSet).toHaveBeenLastCalledWith(undefined, undefined);
  });

  it("shows only the glyph for a chat with PRs and no linked item", () => {
    h.summary = summary();
    const container = slot();
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(glyph()).not.toBeNull();
  });
});

describe("PrSidebarGlyph resting icon", () => {
  const render = () =>
    mount(createElement(PrSidebarGlyph, { sessionId: "s1" }));

  it("renders nothing without a summary", () => {
    expect(render().innerHTML).toBe("");
  });

  it("shows the primary PR's status icon for one PR", () => {
    h.summary = summary({ primaryState: "merged" });
    render();
    expect(glyph()!.querySelector('[data-status="merged"]')).not.toBeNull();
    expect(glyph()!.textContent).toBe("");
  });

  it("shows a PR icon and the count for several PRs", () => {
    h.summary = summary({ count: 4 });
    render();
    expect(glyph()!.querySelector("[data-status]")).toBeNull();
    expect(glyph()!.querySelector("svg")).not.toBeNull();
    expect(glyph()!.textContent).toBe("4");
  });

  it("marks attention with a filled dot (block) or a ring (action)", () => {
    h.summary = summary({ attention: "block" });
    render();
    expect(glyph()!.querySelector(".pr-att")?.getAttribute("data-kind")).toBe(
      "block",
    );
    act(() => mounted[0].root.unmount());
    mounted = [];
    h.summary = summary({ attention: "action", count: 3 });
    render();
    expect(glyph()!.querySelector(".pr-att")?.getAttribute("data-kind")).toBe(
      "action",
    );
    act(() => mounted[0].root.unmount());
    mounted = [];
    h.summary = summary({ attention: "pending" });
    render();
    expect(glyph()!.querySelector(".pr-att")).toBeNull();
  });

  it("names the status in its aria-label, as the chip does", () => {
    expect(sidebarGlyphLabel(summary())).toBe("PR 482 open, 1 pull request");
    expect(
      sidebarGlyphLabel(summary({ primaryIsDraft: true, attention: "action" })),
    ).toBe("PR 482 draft, needs action, 1 pull request");
    expect(
      sidebarGlyphLabel(summary({ count: 4, attention: "block", stale: true })),
    ).toBe(
      "4 pull requests, PR 482 open, blocked, status may be out of date",
    );
    h.summary = summary({ count: 4 });
    render();
    expect(glyph()!.getAttribute("aria-label")).toBe(
      "4 pull requests, PR 482 open",
    );
    expect(glyph()!.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("shows stale data as a dashed outline at full contrast, never reduced opacity", () => {
    h.summary = summary({ stale: true });
    render();
    const button = glyph()!;
    expect(button.getAttribute("data-stale")).toBe("true");
    expect(button.className).not.toMatch(/opacity/);
    expect(button.getAttribute("style") ?? "").not.toMatch(/opacity/);
    // No clock: the sidebar marks staleness with the outline alone.
    expect(button.querySelector("[data-pr-stale]")).toBeNull();

    const css = readFileSync("src/styles/index.css", "utf8").replace(
      /\s+/g,
      " ",
    );
    const rule = /\.sb-glyph\[data-stale="true"\] \{([^}]*)\}/.exec(css)?.[1];
    expect(rule).toContain("outline: 1px dashed var(--color-ink-muted)");
    expect(rule).not.toContain("opacity");
    expect(css).not.toMatch(/\.sb-glyph[^{]*\{[^}]*opacity/);
    // Keyboard focus still wins over the dashed outline.
    expect(css).toContain(
      '.sb-glyph[data-stale="true"]:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }',
    );
  });

  it("has a 24x24 hit area through a pseudo-element", () => {
    const css = readFileSync("src/styles/index.css", "utf8").replace(
      /\s+/g,
      " ",
    );
    expect(css).toContain(
      '.sb-glyph::after { content: ""; position: absolute; inset: -4px -3px; }',
    );
  });

  it("does not fetch the full set at rest", () => {
    h.summary = summary();
    render();
    expect(h.usePrSet).toHaveBeenCalled();
    expect(h.usePrSet.mock.calls.every(([id]) => id === undefined)).toBe(true);
    expect(h.getPrSet).not.toHaveBeenCalled();
  });
});

describe("PrSidebarGlyph card", () => {
  const render = (props: Record<string, unknown> = {}) =>
    mount(
      createElement(
        "div",
        { "data-row": "", onClick: props.onRowClick, onPointerDown: props.onRowPointerDown },
        createElement(PrSidebarGlyph, { sessionId: "s1", ...props }),
      ),
    );

  it("opens the same PR card on the right after 400ms of hover, fetching the set only then", () => {
    vi.useFakeTimers();
    h.summary = summary();
    render();
    expect(PR_SIDEBAR_OPEN_DELAY).toBe(400);
    pointer(glyph()!, "pointerover");
    // Hovering warms the cache for the card.
    expect(h.getPrSet).toHaveBeenCalledWith("s1");
    act(() => vi.advanceTimersByTime(399));
    expect(dialog()).toBeNull();
    expect(h.usePrSet.mock.calls.every(([id]) => id === undefined)).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    const card = dialog()!;
    expect(card).not.toBeNull();
    expect(card.getAttribute("aria-modal")).toBe("false");
    expect(card.closest("[data-popover-side]")?.getAttribute("data-popover-side") ??
      card.getAttribute("data-popover-side")).toBe("right");
    expect(card.textContent).toContain("PR title 482");
    expect(h.usePrSet).toHaveBeenLastCalledWith("s1");
    // The hover card never takes focus.
    expect(card.contains(document.activeElement)).toBe(false);
    expect(glyph()!.getAttribute("aria-expanded")).toBe("true");

    pointer(glyph()!, "pointerout");
    act(() => vi.advanceTimersByTime(100));
    expect(dialog()).toBeNull();
  });

  it("pins on click without selecting the row or writing interest", () => {
    h.summary = summary();
    const onRowClick = vi.fn();
    const onRowPointerDown = vi.fn();
    render({ onRowClick, onRowPointerDown });
    act(() => {
      glyph()!.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }),
      );
      glyph()!.click();
    });
    expect(dialog()).not.toBeNull();
    expect(onRowClick).not.toHaveBeenCalled();
    expect(onRowPointerDown).not.toHaveBeenCalled();
    expect(h.setPrInterest).not.toHaveBeenCalled();
    // Clicks inside the portalled card do not reach the row either.
    act(() => dialog()!.click());
    expect(onRowClick).not.toHaveBeenCalled();
    act(() => glyph()!.click());
    expect(dialog()).toBeNull();
  });

  it("closes the card when the chat loses its PRs", () => {
    h.summary = summary();
    render();
    act(() => glyph()!.click());
    expect(dialog()).not.toBeNull();
    h.summary = undefined;
    act(() =>
      mounted[0].root.render(
        createElement("div", null, createElement(PrSidebarGlyph, { sessionId: "s1" })),
      ),
    );
    expect(dialog()).toBeNull();
    expect(glyph()).toBeNull();
  });
});
