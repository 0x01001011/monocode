// @vitest-environment happy-dom
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearComposerPrefill,
  markComposerMounted,
  peekComposerPrefill,
} from "../../sessions/model/composerPrefill";
import {
  clearComposerDraft,
  getComposerDraft,
  setComposerDraft,
} from "../../sessions/model/draftCache";
import type { PrEntryLite, PrStackView } from "../model/types";
import { PrInboxStack, restackPromptText } from "./PrInboxStack";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../../sessions/model/draftCache", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../sessions/model/draftCache")>();
  return { ...actual, setComposerDraft: vi.fn(actual.setComposerDraft) };
});

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
    headRef: `mc/pr-${number}`,
    baseRef: "main",
    checks: "passing",
    attention: "none",
    attentionReason: null,
    ownerSessionIds: [],
    isNeighbor: false,
    ...extra,
  };
}

/**
 * main <- #478 (merged) <- #480 (retargeted to main, then merged) <- #482
 * (still on #480's branch).
 */
function stack(): PrStackView {
  return {
    group: {
      repo: "acme/app",
      baseRef: "main",
      members: [478, 480, 482],
      mergedCount: 2,
    },
    entries: [
      entry(478, { state: "merged", isNeighbor: true }),
      entry(480, { state: "merged", baseRef: "main", isNeighbor: true }),
      entry(482, {
        baseRef: "mc/pr-480",
        attention: "action",
        attentionReason: "Needs restack",
        ownerSessionIds: ["s2"],
      }),
    ],
  };
}

let answer: PrStackView | null;
let handlers: (() => void)[];
let container: HTMLDivElement;
let root: Root;
const onOpenPr = vi.fn();

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  answer = stack();
  titles = {};
  handlers = [];
  onOpenPr.mockReset();
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  vi.mocked(setComposerDraft).mockClear();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((async (command: string) => {
    if (command === "pr_stack_for") return answer;
    throw new Error(`unexpected command ${command}`);
  }) as never);
  vi.mocked(listen).mockReset();
  vi.mocked(listen).mockImplementation((async (
    _name: string,
    cb: () => void,
  ) => {
    handlers.push(cb);
    return () => {
      handlers = handlers.filter((h) => h !== cb);
    };
  }) as never);
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  for (const id of ["s1", "s2"]) {
    clearComposerDraft(id);
    const pending = peekComposerPrefill(id);
    if (pending) clearComposerPrefill(id, pending.token);
  }
});

const SESSIONS = [
  { id: "s1", title: "Linked chat" },
  { id: "s2", title: "Tasks panel audit" },
];

let titles: Record<string, string>;

async function render(sessions = SESSIONS, number = 482, repo = "Acme/App") {
  await act(async () => {
    root.render(
      createElement(PrInboxStack, {
        repo,
        number,
        relatedSessions: sessions,
        sessionTitleById: (id: string) => titles[id],
        onOpenPr,
      }),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const PROMPT =
  "Restack #482 onto main: its parent #480 was merged. Rebase mc/pr-482 onto main, resolve conflicts, and force-push with lease. Then retarget the pull request with gh pr edit 482 --base main.";

describe("restackPromptText", () => {
  it("rebases onto the merged parent's base and retargets a PR still on the parent branch", () => {
    expect(restackPromptText(stack(), 482)).toBe(PROMPT);
  });

  it("rebases onto the grandparent branch when the merged parent targeted it", () => {
    const view = stack();
    view.entries[0] = { ...view.entries[0]!, state: "open" };
    view.entries[1] = { ...view.entries[1]!, baseRef: "mc/pr-478" };
    expect(restackPromptText(view, 482)).toBe(
      "Restack #482 onto mc/pr-478: its parent #480 was merged. Rebase mc/pr-482 onto mc/pr-478, resolve conflicts, and force-push with lease. Then retarget the pull request with gh pr edit 482 --base mc/pr-478.",
    );
  });

  it("skips the retarget once GitHub already moved the base", () => {
    const view = stack();
    view.entries[2] = { ...view.entries[2]!, baseRef: "main" };
    expect(restackPromptText(view, 482)).toBe(
      "Restack #482 onto main: its parent #480 was merged. Rebase mc/pr-482 onto main, resolve conflicts, and force-push with lease.",
    );
  });

  it("follows an open parent that gained commits", () => {
    const view = stack();
    view.entries[1] = { ...view.entries[1]!, state: "open" };
    expect(restackPromptText(view, 482)).toBe(
      "Restack #482 onto #480: mc/pr-480 has new commits. Rebase mc/pr-482 onto mc/pr-480, resolve conflicts, and force-push with lease.",
    );
  });

  it("updates a PR that is behind its base", () => {
    const view = stack();
    view.entries[0] = {
      ...view.entries[0]!,
      state: "open",
      attention: "action",
      attentionReason: "Behind main by 3",
    };
    expect(restackPromptText(view, 478)).toBe(
      "Update #478 with main: it is 3 commits behind. Rebase mc/pr-478 onto main, resolve conflicts, and force-push with lease.",
    );
  });

  it("walks past merged ancestors to the first open base", () => {
    // #480 merged into #478's branch without a retarget, and #478 merged too.
    const view = stack();
    view.entries[1] = { ...view.entries[1]!, baseRef: "mc/pr-478" };
    expect(restackPromptText(view, 482)).toBe(PROMPT);
    // An open #478 is where #482 lands instead.
    view.entries[0] = { ...view.entries[0]!, state: "open" };
    expect(restackPromptText(view, 482)).toContain(
      "Rebase mc/pr-482 onto mc/pr-478,",
    );
  });

  it("has nothing to say about other reasons", () => {
    const view = stack();
    view.entries[2] = {
      ...view.entries[2]!,
      attention: "block",
      attentionReason: "Checks failing",
    };
    expect(restackPromptText(view, 482)).toBeNull();
  });
});

describe("PrInboxStack", () => {
  it("renders the rail then the health line for a PR in a stack, accepting any repo case", async () => {
    await render();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("pr_stack_for", {
      repo: "Acme/App",
      number: 482,
    });
    const nav = container.querySelector(
      "nav[aria-label='Stack, base to tip']",
    )!;
    const note = container.querySelector("[role='note']")!;
    expect(nav).not.toBeNull();
    expect(note.textContent).toContain("Needs restack");
    expect(
      nav.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      container
        .querySelector("a[aria-current='step']")
        ?.getAttribute("data-pr"),
    ).toBe("482");
  });

  it("renders nothing for a PR without a snapshot", async () => {
    answer = null;
    await render();
    expect(container.innerHTML).toBe("");
  });

  function standalone(extra: Partial<PrEntryLite>): PrStackView {
    return {
      group: {
        repo: "acme/app",
        baseRef: "main",
        members: [490],
        mergedCount: 0,
      },
      entries: [entry(490, extra)],
    };
  }

  it("shows the health line without a rail for a PR that stacks with nothing", async () => {
    answer = standalone({
      attention: "block",
      attentionReason: "Checks failing",
    });
    await render(SESSIONS, 490);
    expect(container.querySelector("nav")).toBeNull();
    expect(container.querySelector("[role='note']")?.textContent).toBe(
      "Checks failing",
    );
  });

  it("renders nothing for a standalone PR that needs no attention", async () => {
    answer = standalone({});
    await render(SESSIONS, 490);
    expect(container.innerHTML).toBe("");
  });

  it("drafts into the PR's owner chat even when it is not linked to the PR", async () => {
    titles = { s2: "Tasks panel audit" };
    await render([{ id: "s1", title: "Linked chat" }]);
    const button = container.querySelector<HTMLButtonElement>(
      "[role='note'] button",
    )!;
    expect(button.textContent).toBe(
      "Draft restack prompt in \u201CTasks panel audit\u201D",
    );
    act(() => button.click());
    expect(getComposerDraft("s2")).toBe(PROMPT);
    expect(getComposerDraft("s1")).toBeUndefined();
  });

  it("drafts into an owner chat with no linked chats at all", async () => {
    titles = { s2: "Tasks panel audit" };
    await render([]);
    expect(container.querySelector("[role='note'] button")?.textContent).toBe(
      "Draft restack prompt in \u201CTasks panel audit\u201D",
    );
  });

  it("renders the rail without a health line when the viewed PR needs nothing", async () => {
    answer = stack();
    answer.entries[2] = {
      ...answer.entries[2]!,
      attention: "none",
      attentionReason: null,
    };
    await render();
    expect(container.querySelector("nav")).not.toBeNull();
    expect(container.querySelector("[role='note']")).toBeNull();
  });

  it("drafts the restack prompt into the owning chat's composer, appended, and never sends", async () => {
    setComposerDraft("s2", "my notes");
    vi.mocked(setComposerDraft).mockClear();
    await render();
    const button = container.querySelector<HTMLButtonElement>(
      "[role='note'] button",
    )!;
    // The owner beats the first related chat.
    expect(button.textContent).toBe(
      "Draft restack prompt in “Tasks panel audit”",
    );
    act(() => button.click());
    expect(setComposerDraft).toHaveBeenCalledTimes(1);
    expect(setComposerDraft).toHaveBeenCalledWith(
      "s2",
      `my notes\n\n${PROMPT}`,
    );
    expect(getComposerDraft("s2")).toBe(`my notes\n\n${PROMPT}`);
    expect(getComposerDraft("s1")).toBeUndefined();
    // Nothing but the stack lookup went to the backend: no send, no submit.
    expect(vi.mocked(invoke).mock.calls.map((c) => c[0])).toEqual([
      "pr_stack_for",
    ]);
    expect(container.querySelector("[role='status']")?.textContent).toBe(
      "Draft added to “Tasks panel audit”",
    );
  });

  it("hands the prompt to a mounted composer instead of the cache", async () => {
    const unmount = markComposerMounted("s2");
    await render();
    act(() =>
      container
        .querySelector<HTMLButtonElement>("[role='note'] button")!
        .click(),
    );
    expect(setComposerDraft).not.toHaveBeenCalled();
    expect(peekComposerPrefill("s2")?.text).toBe(PROMPT);
    unmount();
  });

  it("falls back to the first related chat, and offers nothing without one", async () => {
    await render([{ id: "s1", title: "Linked chat" }]);
    expect(container.querySelector("[role='note'] button")?.textContent).toBe(
      "Draft restack prompt in “Linked chat”",
    );
    await render([]);
    expect(container.querySelector("[role='note']")?.textContent).toBe(
      "Needs restack",
    );
    expect(container.querySelector("[role='note'] button")).toBeNull();
  });

  it("refetches on any pr-set-changed event", async () => {
    await render();
    answer = null;
    await act(async () => {
      for (const h of handlers) h();
      await Promise.resolve();
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
    expect(container.innerHTML).toBe("");
  });

  it("keeps quiet when the lookup fails", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("no backend"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await render();
    expect(container.innerHTML).toBe("");
  });

  it("opens another PR of the stack through the callback", async () => {
    await render();
    act(() =>
      container.querySelector<HTMLAnchorElement>("a[data-pr='478']")!.click(),
    );
    expect(onOpenPr).toHaveBeenCalledWith(stack().entries[0]);
  });
});
