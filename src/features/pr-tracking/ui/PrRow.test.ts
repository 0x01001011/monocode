// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrEntry } from "../model/types";
import { PR_LIST_CONTAINER, PrRow, type PrRowProps } from "./PrRow";
import { PrStatusIcon } from "./PrStatusIcon";
import { PrStrip } from "./PrStrip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const NOW = 1_700_000_000_000;
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
      title: "Tasks panel: keyboard audit fixes",
      state: "open",
      isDraft: false,
      headRef: "mc/tasks-panel-keyboard",
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
    onLiveBranch: true,
    parent: null,
    attention: "none",
    attentionReason: null,
    dismissed: false,
    error: null,
    ...rest,
  };
}

let mounted: { root: Root; container: HTMLElement }[] = [];

function render(node: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  container.className = PR_LIST_CONTAINER;
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

function renderRow(e: PrEntry, over: Partial<PrRowProps> = {}) {
  const props: PrRowProps = {
    entry: e,
    now: NOW,
    onOpenInbox: vi.fn(),
    onOpenGithub: vi.fn(),
    onCopyLink: vi.fn(),
    onDismiss: vi.fn(),
    ...over,
  };
  const container = render(createElement("ul", null, createElement(PrRow, props)));
  return { container, props };
}

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted = [];
  document.body.innerHTML = "";
});

describe("PrRow", () => {
  it("renders number, title and the HEAD tag for the live branch", () => {
    const { container } = renderRow(entry(482));
    expect(container.querySelector(".pr-n")?.textContent).toBe("#482");
    expect(container.querySelector(".pr-ttl")?.textContent).toBe(
      "Tasks panel: keyboard audit fixes",
    );
    expect(container.querySelector(".pr-ref")?.textContent).toBe(
      "mc/tasks-panel-keyboard → main",
    );
    const tags = container.querySelectorAll(".pr-tag");
    expect(tags).toHaveLength(1);
    expect(tags[0].textContent).toBe("HEAD");
  });

  it("shows exactly one tag chosen by relation and branch", () => {
    const cases: [PrEntry, string | null][] = [
      [entry(1, { onLiveBranch: false }), "Not checked out"],
      [entry(2, { onLiveBranch: false, relation: "existing" }), "Existing"],
      [
        entry(3, { onLiveBranch: false, relation: "other", ownerSessionId: null }),
        "by @maya",
      ],
      [
        entry(4, { onLiveBranch: false, relation: "other", ownerSessionId: "s2" }),
        "Other chat",
      ],
      [
        entry(5, { onLiveBranch: false, snapshot: { state: "merged" } }),
        null,
      ],
    ];
    for (const [e, tag] of cases) {
      const { container } = renderRow(e);
      const tags = [...container.querySelectorAll(".pr-l2 .pr-tag")].map(
        (t) => t.textContent,
      );
      expect(tags, `#${e.snapshot.number}`).toEqual(tag ? [tag] : []);
    }
  });

  it("links to the PR URL and routes clicks by modifier without navigating", () => {
    const { container, props } = renderRow(entry(482));
    const link = container.querySelector<HTMLAnchorElement>("a.pr-main")!;
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/web/pull/482",
    );
    expect(link.getAttribute("aria-label")).toBe(
      "PR 482, Tasks panel: keyboard audit fixes, Open",
    );

    const click = (init: MouseEventInit) => {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
      act(() => {
        link.dispatchEvent(event);
      });
      return event;
    };
    expect(click({}).defaultPrevented).toBe(true);
    expect(props.onOpenInbox).toHaveBeenCalledWith(props.entry);
    click({ metaKey: true });
    expect(props.onOpenGithub).toHaveBeenCalledWith(props.entry);
    click({ altKey: true });
    expect(props.onCopyLink).toHaveBeenCalledWith(props.entry);
  });

  it("labels the attention mark with the reason: dot for block, ring for action", () => {
    const blocked = renderRow(
      entry(482, { attention: "block", attentionReason: "Checks failing" }),
    ).container;
    const dot = blocked.querySelector('[aria-label="Checks failing"]');
    expect(dot).not.toBeNull();
    expect(dot!.getAttribute("role")).toBe("img");
    expect(dot!.getAttribute("data-kind")).toBe("block");

    const action = renderRow(
      entry(483, { attention: "action", attentionReason: "Needs restack" }),
    ).container;
    expect(
      action.querySelector('[aria-label="Needs restack"]')?.getAttribute("data-kind"),
    ).toBe("action");

    const quiet = renderRow(entry(484, { attention: "pending" })).container;
    expect(quiet.querySelector(".pr-att")).toBeNull();
  });

  it("marks a stale snapshot with a clock and never lowers opacity", () => {
    const stale = renderRow(
      entry(482, { snapshot: { fetchedAt: NOW - 11 * 60_000 } }),
    ).container;
    expect(stale.querySelector('[data-pr-stale="true"]')).not.toBeNull();
    for (const el of stale.querySelectorAll<HTMLElement>("*")) {
      expect(el.style.opacity, el.className).toBe("");
      expect(String(el.getAttribute("class") ?? "")).not.toMatch(/opacity/);
    }
    expect(
      stale.querySelector("a.pr-main")!.getAttribute("aria-label"),
    ).toContain("status may be out of date");

    const fresh = renderRow(
      entry(483, { snapshot: { fetchedAt: NOW - 9 * 60_000 } }),
    ).container;
    expect(fresh.querySelector("[data-pr-stale]")).toBeNull();
  });

  it("keeps a 200-character CJK and emoji title whole in the title attribute", () => {
    const title = "修复侧边栏🚀徽章溢出".repeat(20);
    expect([...title].length).toBe(200);
    const { container } = renderRow(entry(482, { snapshot: { title } }));
    const ttl = container.querySelector(".pr-ttl")!;
    expect(ttl.getAttribute("title")).toBe(title);
    expect(ttl.textContent).toBe(title);
  });

  it("shows signal glyphs only when they carry signal", () => {
    const none = renderRow(entry(1)).container;
    expect(none.querySelector(".pr-sig")).toBeNull();

    const busy = renderRow(
      entry(2, {
        snapshot: {
          checks: "failing",
          review: "changesRequested",
          mergeable: "conflicting",
          behindBy: 3,
        },
      }),
    ).container;
    const titles = [...busy.querySelectorAll(".pr-sig [title]")].map((s) =>
      s.getAttribute("title"),
    );
    expect(titles).toEqual([
      "Checks failing",
      "Changes requested",
      "Merge conflict",
      "3 commits behind base",
    ]);

    const merged = renderRow(
      entry(3, { snapshot: { state: "merged", checks: "failing" } }),
    ).container;
    expect(merged.querySelector(".pr-sig")).toBeNull();
  });

  it("opens a ⋯ menu whose items call back with the entry", () => {
    const e = entry(482, { onLiveBranch: false });
    const { container, props } = renderRow(e);
    const more = container.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions for PR 482"]',
    )!;
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    act(() => more.click());
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const menu = document.querySelector('[role="menu"]')!;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual([
      "Open in Inbox",
      "Open on GitHub",
      "Copy link",
      "Hide",
    ]);
    expect(document.activeElement).toBe(items[0]);
    act(() => items[3].click());
    expect(props.onDismiss).toHaveBeenCalledWith(e, true);
    expect(document.querySelector('[role="menu"]')).toBeNull();

    const hidden = renderRow(entry(9, { dismissed: true }));
    act(() =>
      hidden.container
        .querySelector<HTMLButtonElement>('button[aria-label="More actions for PR 9"]')!
        .click(),
    );
    const show = [...document.querySelectorAll('[role="menuitem"]')].find(
      (i) => i.textContent === "Show",
    ) as HTMLButtonElement;
    act(() => show.click());
    expect(hidden.props.onDismiss).toHaveBeenCalledWith(hidden.props.entry, false);
  });

  it("closes the menu on Escape and returns focus to the ⋯ button", () => {
    const { container } = renderRow(entry(482));
    const more = container.querySelector<HTMLButtonElement>(".pr-row-more")!;
    act(() => more.click());
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(more);
  });
});

describe("PrStatusIcon", () => {
  it("draws a distinct shape per state and labels it", () => {
    const shapes = new Set<string>();
    const cases = [
      { state: "open", isDraft: false, label: "Open" },
      { state: "open", isDraft: true, label: "Draft" },
      { state: "merged", isDraft: false, label: "Merged" },
      { state: "closed", isDraft: true, label: "Closed" },
    ] as const;
    for (const c of cases) {
      const container = render(
        createElement(PrStatusIcon, { state: c.state, isDraft: c.isDraft }),
      );
      const svg = container.querySelector("svg")!;
      shapes.add(svg.innerHTML);
      expect(container.firstElementChild!.getAttribute("data-status")).toBe(
        c.label.toLowerCase(),
      );
      expect(container.firstElementChild!.getAttribute("title")).toBe(c.label);
    }
    expect(shapes.size).toBe(4);
  });

  it("adds a clock when stale", () => {
    const container = render(
      createElement(PrStatusIcon, { state: "open", isDraft: false, stale: true }),
    );
    expect(container.querySelector('[data-pr-stale="true"]')).not.toBeNull();
  });
});

describe("PrStrip", () => {
  it("renders one hidden bar per PR with its kind and status", () => {
    const container = render(
      createElement(PrStrip, {
        bars: [
          { number: 10, kind: "merged", status: "merged" },
          { number: 11, kind: "draft", status: "draft" },
          { number: 12, kind: "current", status: "open" },
          { number: 13, kind: "other", status: "closed" },
        ],
      }),
    );
    const strip = container.querySelector(".pr-strip")!;
    expect(strip.getAttribute("aria-hidden")).toBe("true");
    const bars = [...strip.children];
    expect(bars.map((b) => b.getAttribute("data-kind"))).toEqual([
      "merged",
      "draft",
      "current",
      "other",
    ]);
    expect(bars.map((b) => b.getAttribute("data-status"))).toEqual([
      "merged",
      "draft",
      "open",
      "closed",
    ]);
  });

  it("renders nothing for an empty strip", () => {
    const container = render(createElement(PrStrip, { bars: [] }));
    expect(container.innerHTML).toBe("");
  });
});
