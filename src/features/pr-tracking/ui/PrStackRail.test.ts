// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrEntryLite, PrStackView } from "../model/types";
import { PrStackRail } from "./PrStackRail";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function entry(number: number, extra: Partial<PrEntryLite> = {}): PrEntryLite {
  return {
    number,
    title: `Title of ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    state: "open",
    isDraft: false,
    headRef: `mc/${number}`,
    baseRef: "main",
    checks: "passing",
    attention: "none",
    attentionReason: null,
    ownerSessionIds: [],
    isNeighbor: false,
    ...extra,
  };
}

const VIEW: PrStackView = {
  group: {
    repo: "acme/app",
    baseRef: "main",
    members: [478, 480, 482],
    mergedCount: 1,
  },
  entries: [
    entry(478, { isNeighbor: true }),
    entry(480, { state: "merged" }),
    entry(482, { title: "A very long title 🚀 日本語 that will be truncated" }),
  ],
};

// Layout stand-ins: happy-dom has no layout, so widths come from markers.
const NODE = 100;
const TITLE = 60;
const TERMINUS = 40;
const OVERHEAD = TERMINUS + 4 * 3 + 2 * 2;

let observers: { cb: ResizeObserverCallback; targets: Element[] }[];
let container: HTMLDivElement;
let root: Root;
const onOpenPr = vi.fn();

class FakeResizeObserver {
  record: { cb: ResizeObserverCallback; targets: Element[] };
  constructor(cb: ResizeObserverCallback) {
    this.record = { cb, targets: [] };
    observers.push(this.record);
  }
  observe(target: Element) {
    this.record.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    this.record.targets = [];
  }
}

beforeEach(() => {
  observers = [];
  onOpenPr.mockReset();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const width = this.matches("[data-rail-title]")
        ? TITLE
        : this.matches("[data-rail-node]")
          ? NODE
          : this.matches("[data-rail-terminus]")
            ? TERMINUS
            : 0;
      return {
        width,
        height: 28,
        top: 0,
        left: 0,
        right: width,
        bottom: 28,
        x: 0,
        y: 0,
        toJSON() {},
      } as DOMRect;
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render(view: PrStackView = VIEW, current = 482) {
  act(() =>
    root.render(createElement(PrStackRail, { view, current, onOpenPr })),
  );
}

function ol() {
  return container.querySelector("ol")!;
}

/** Gives the rail a width and lets the ResizeObserver report it. */
function resize(width: number) {
  Object.defineProperty(ol(), "clientWidth", {
    configurable: true,
    get: () => width,
  });
  act(() => {
    for (const o of observers)
      if (o.targets.includes(ol())) o.cb([], {} as ResizeObserver);
  });
}

const nodes = () => [
  ...container.querySelectorAll<HTMLAnchorElement>("a[data-pr]"),
];

describe("PrStackRail", () => {
  it("renders an ordered list base to tip with a leading base terminus and the viewed PR marked", () => {
    render();
    const nav = container.querySelector("nav")!;
    expect(nav.getAttribute("aria-label")).toBe("Stack, base to tip");
    const items = [...nav.querySelectorAll("ol > li")];
    expect(items[0]!.textContent).toBe("main");
    expect(items[0]!.querySelector("a")).toBeNull();
    expect(nodes().map((a) => a.dataset.pr)).toEqual(["478", "480", "482"]);
    expect(nodes().map((a) => a.getAttribute("aria-current"))).toEqual([
      null,
      null,
      "step",
    ]);
    const tip = nodes()[2]!;
    expect(tip.getAttribute("href")).toBe(
      "https://github.com/acme/app/pull/482",
    );
    expect(tip.getAttribute("title")).toBe(
      "#482 A very long title 🚀 日本語 that will be truncated",
    );
    expect(tip.textContent).toContain("#482");
    expect(tip.querySelector("[data-rail-title]")?.textContent).toBe(
      "A very long title 🚀 日本語 that will be truncated",
    );
    expect(tip.getAttribute("aria-label")).toBe(
      "PR 482, A very long title 🚀 日本語 that will be truncated, Open",
    );
  });

  it("draws merged parents with the merged shape and other chats' PRs with the other treatment", () => {
    render();
    const [base, merged] = nodes();
    expect(merged!.dataset.state).toBe("merged");
    expect(
      merged!.querySelector(".pr-status")?.getAttribute("data-status"),
    ).toBe("merged");
    expect(base!.dataset.other).toBe("true");
    expect(base!.getAttribute("aria-label")).toBe(
      "PR 478, Title of 478, Open, other chat",
    );
    expect(merged!.dataset.other).toBeUndefined();
  });

  it("opens another PR through the callback without navigating, and ignores the viewed one", () => {
    render();
    const click = (a: HTMLAnchorElement) => {
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      act(() => void a.dispatchEvent(event));
      return event;
    };
    const event = click(nodes()[0]!);
    expect(event.defaultPrevented).toBe(true);
    expect(onOpenPr).toHaveBeenCalledWith(VIEW.entries[0]);
    click(nodes()[2]!);
    expect(onOpenPr).toHaveBeenCalledTimes(1);
  });

  it("keeps every title when the rail fits", () => {
    render();
    resize(OVERHEAD + 3 * NODE);
    expect(ol().dataset.mode).toBe("full");
    expect(container.querySelectorAll("[data-rail-title]")).toHaveLength(3);
  });

  it("drops the title of the node farthest from the viewed PR first", () => {
    render();
    resize(OVERHEAD + 3 * NODE - 1);
    expect(ol().dataset.mode).toBe("compact");
    const titled = nodes().map(
      (a) => a.querySelector("[data-rail-title]") != null,
    );
    expect(titled).toEqual([false, true, true]);
    // Growing back restores the title.
    resize(OVERHEAD + 3 * NODE);
    expect(container.querySelectorAll("[data-rail-title]")).toHaveLength(3);
  });

  it("scrolls with faded edges and centers the viewed PR when numbers alone overflow", () => {
    render(VIEW, 480);
    const width = OVERHEAD + NODE + 2 * (NODE - TITLE - 6) - 1;
    const current = nodes()[1]!.closest("li")!;
    Object.defineProperty(current, "offsetLeft", {
      configurable: true,
      get: () => 150,
    });
    Object.defineProperty(current, "offsetWidth", {
      configurable: true,
      get: () => 100,
    });
    let scrollLeft = 0;
    Object.defineProperty(ol(), "scrollLeft", {
      configurable: true,
      get: () => scrollLeft,
      set: (v: number) => {
        scrollLeft = v;
      },
    });
    resize(width);
    expect(ol().dataset.mode).toBe("scroll");
    expect(
      nodes().map((a) => a.querySelector("[data-rail-title]") != null),
    ).toEqual([false, true, false]);
    expect(scrollLeft).toBe(150 - (width - 100) / 2);
  });
});
