// @vitest-environment happy-dom
import { invoke } from "@tauri-apps/api/core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PrStackView } from "../../pr-tracking/model/types";
import type { SessionSummary } from "../../sessions/data/sessionStore";
import {
  clearComposerDraft,
  getComposerDraft,
} from "../../sessions/model/draftCache";
import { clearInboxCache, type InboxItem } from "../model/githubTasks";
import { InboxDetail } from "./InboxView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

const item: InboxItem = {
  provider: "github",
  kind: "pr",
  repo: "acme/web",
  number: 482,
  title: "Tasks panel keyboard",
  url: "https://github.com/acme/web/pull/482",
  state: "open",
  updatedAt: "2026-10-06T12:00:00Z",
  labels: [],
  assignees: [],
  draft: false,
  projectPath: "/tmp/web",
};

const chat: SessionSummary = {
  id: "s1",
  cwd: "/tmp/web",
  harness: "claude",
  model: "m",
  runtimeMode: "supervised",
  title: "Tasks panel audit",
  createdAt: 1,
  updatedAt: 1,
};

const lite = (
  number: number,
  extra: Partial<PrStackView["entries"][number]>,
) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
  state: "open" as const,
  isDraft: false,
  headRef: `mc/pr-${number}`,
  baseRef: "main",
  checks: "passing" as const,
  attention: "none" as const,
  attentionReason: null,
  ownerSessionIds: [],
  isNeighbor: false,
  ...extra,
});

const STACK: PrStackView = {
  group: {
    repo: "acme/web",
    baseRef: "main",
    members: [480, 482],
    mergedCount: 1,
  },
  entries: [
    lite(480, { state: "merged" }),
    lite(482, {
      baseRef: "mc/pr-480",
      attention: "action",
      attentionReason: "Needs restack",
      ownerSessionIds: ["s1"],
    }),
  ],
};

let stack: PrStackView | null;
let root: Root;
let container: HTMLDivElement;

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  clearInboxCache();
  stack = STACK;
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "pr_stack_for") return stack;
    if (command === "git_github_pr_checks")
      return { headOid: "abc", checks: [] };
    if (command === "git_github_work_item_details")
      return { body: "The overview body", author: "" };
    if (command === "git_github_work_item_thread")
      return { comments: [], commits: [], truncated: false };
    throw new Error(`Unexpected command: ${command}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearComposerDraft("s1");
  vi.unstubAllGlobals();
});

async function render(
  relatedSessions: SessionSummary[] = [chat],
  sessionTitleById?: (id: string) => string | undefined,
) {
  await act(async () =>
    root.render(
      createElement(InboxDetail, {
        item,
        cwd: "/tmp/web",
        projects: [],
        revision: 0,
        relatedSessions,
        sessionTitleById,
        onDiscuss: () => {},
        onStart: () => {},
      }),
    ),
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const rail = () =>
  container.querySelector("nav[aria-label='Stack, base to tip']");

it("shows the rail and health line above the PR overview on Summary", async () => {
  await render();
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("pr_stack_for", {
    repo: "acme/web",
    number: 482,
  });
  const nav = rail()!;
  expect(nav).not.toBeNull();
  const note = container.querySelector("[role='note']")!;
  expect(note.textContent).toContain("Needs restack");
  const overview = [...container.querySelectorAll("p, div")].find(
    (el) => el.textContent === "The overview body",
  )!;
  expect(overview).toBeTruthy();
  expect(
    note.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it("drafts the restack prompt into the related chat without sending anything", async () => {
  await render();
  const button = container.querySelector<HTMLButtonElement>(
    "[role='note'] button",
  )!;
  expect(button.textContent).toBe(
    "Draft restack prompt in “Tasks panel audit”",
  );
  const before = vi.mocked(invoke).mock.calls.length;
  act(() => button.click());
  expect(getComposerDraft("s1")).toBe(
    "Restack #482 onto main: its parent #480 was merged. Rebase mc/pr-482 onto main, resolve conflicts, and force-push with lease. Then retarget the pull request with gh pr edit 482 --base main.",
  );
  expect(vi.mocked(invoke).mock.calls.length).toBe(before);
  expect(container.querySelector("[role='status']")?.textContent).toBe(
    "Draft added to “Tasks panel audit”",
  );
});

it("renders neither rail nor health line for a PR in no stack", async () => {
  stack = null;
  await render();
  expect(rail()).toBeNull();
  expect(container.querySelector("[role='note']")).toBeNull();
  expect(container.querySelector(".pr-inbox-stack")).toBeNull();
});

it("offers no draft action without a related chat", async () => {
  await render([]);
  expect(rail()).not.toBeNull();
  expect(container.querySelector("[role='note'] button")).toBeNull();
});

it("drafts into the PR's owner chat even when no chat is linked to the PR", async () => {
  await render([], (id) => (id === "s1" ? "Tasks panel audit" : undefined));
  const button = container.querySelector<HTMLButtonElement>(
    "[role='note'] button",
  )!;
  expect(button.textContent).toBe(
    "Draft restack prompt in \u201CTasks panel audit\u201D",
  );
  act(() => button.click());
  expect(getComposerDraft("s1")).toContain("Restack #482 onto main");
});

it("shows only the health line for a standalone PR that needs attention", async () => {
  stack = {
    group: {
      repo: "acme/web",
      baseRef: "main",
      members: [482],
      mergedCount: 0,
    },
    entries: [
      lite(482, { attention: "block", attentionReason: "Checks failing" }),
    ],
  };
  await render();
  expect(rail()).toBeNull();
  expect(container.querySelector("[role='note']")?.textContent).toBe(
    "Checks failing",
  );
});
