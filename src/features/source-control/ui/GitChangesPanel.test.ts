// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => {}),
}));

const { invalidateWatchedFiles, reportError } = vi.hoisted(() => ({
  invalidateWatchedFiles: vi.fn(),
  reportError: vi.fn(async () => {}),
}));

vi.mock("../../../shared/lib/confirm", () => ({
  confirmNative: vi.fn(async () => true),
  reportError,
}));

vi.mock("../../../platform/tauri/fs", () => ({
  gitDiffIndex: vi.fn(),
  gitHistory: vi.fn(async () => []),
  gitPrStatus: vi.fn(async () => null),
  gitPull: vi.fn(async () => {}),
  gitPush: vi.fn(async () => {}),
  gitSync: vi.fn(async () => {}),
  gitCommit: vi.fn(async () => {}),
  gitHeadMessage: vi.fn(async () => ""),
  gitStageAll: vi.fn(async () => {}),
  gitUnstageAll: vi.fn(async () => {}),
  gitDiscardAll: vi.fn(async () => {}),
  gitStageFile: vi.fn(async () => {}),
  gitUnstageFile: vi.fn(async () => {}),
  gitDiscardFile: vi.fn(async () => {}),
  gitPrCreate: vi.fn(async () => ""),
  gitRangeContext: vi.fn(),
  gitIsAncestor: vi.fn(async () => false),
  gitBranches: vi.fn(async () => ({ current: null, detached: false, branches: [] })),
  notifyGitChanged: vi.fn(),
  subscribeGitChanged: () => () => {},
  basename: (path: string) => path.split("/").pop() ?? path,
}));

vi.mock("../../../integrations/harness", () => ({
  generateCommitMessage: vi.fn(async () => ""),
  generatePrContent: vi.fn(async () => null),
}));

vi.mock("../../files/model/fileWatch", () => ({
  invalidateWatchedFiles,
  nudgeWatchedFiles: vi.fn(),
}));

vi.mock("../../inbox/model/inboxSelfActivity", () => ({
  recordInboxSelfActivity: vi.fn(),
}));

const prState = vi.hoisted(() => ({
  view: null as import("../../pr-tracking/model/types").PrSetView | null,
}));

vi.mock("../../pr-tracking/data/prTracking", () => ({
  recordPrUrl: vi.fn(async () => {}),
  usePrSet: (sessionId?: string) => (sessionId ? prState.view : null),
  refreshPrSet: vi.fn(async () => {}),
  dismissPr: vi.fn(async () => {}),
}));

import { GitChangesPanel } from "./GitChangesPanel";
import {
  gitBranches,
  gitDiffIndex,
  gitIsAncestor,
  gitPrCreate,
  gitPrStatus,
  gitPull,
  gitPush,
  gitRangeContext,
  gitStageFile,
  gitUnstageFile,
  notifyGitChanged,
} from "../../../platform/tauri/fs";
import {
  generateCommitMessage,
  generatePrContent,
} from "../../../integrations/harness";
import { openUrl } from "@tauri-apps/plugin-opener";
import { recordPrUrl } from "../../pr-tracking/data/prTracking";
import type { GitChangedFile, GitDiffIndex } from "../../../platform/tauri/fs";
import type { PrEntry } from "../../pr-tracking/model/types";

function index(overrides: Partial<GitDiffIndex> = {}): GitDiffIndex {
  return {
    branch: "feature/pull",
    head: "abc123",
    files: [],
    additions: 0,
    deletions: 0,
    remote: null,
    upstream: null,
    defaultBranch: "main",
    ahead: 0,
    behind: 0,
    aheadOfDefault: 0,
    headPushed: true,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // Keep delayed file invalidations from reaching the next test's mocks.
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.mocked(gitDiffIndex).mockReset();
  vi.mocked(gitPull).mockReset();
  vi.mocked(gitStageFile).mockReset().mockResolvedValue(undefined);
  vi.mocked(gitUnstageFile).mockReset().mockResolvedValue(undefined);
  vi.mocked(notifyGitChanged).mockClear();
  vi.mocked(generateCommitMessage).mockReset();
  invalidateWatchedFiles.mockReset();
  prState.view = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

describe("GitChangesPanel commit message generation", () => {
  it("cancels promptly and ignores a late result after a retry", async () => {
    vi.mocked(gitDiffIndex).mockResolvedValue(
      index({
        files: [
          {
            path: "/repo/change.ts",
            relative: "change.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            staged: true,
            unstaged: false,
          },
        ],
      }),
    );
    let resolveFirst!: (message: string) => void;
    vi.mocked(generateCommitMessage)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce("New message");
    await renderPanel();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Generate commit message"]',
        )!
        .click();
    });
    const signal = vi.mocked(generateCommitMessage).mock.calls[0]?.[2];
    expect(signal?.aborted).toBe(false);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Cancel commit message generation"]',
        )!
        .click();
    });
    expect(signal?.aborted).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Generate commit message"]',
      )?.disabled,
    ).toBe(false);
    expect(container.querySelector("textarea")?.disabled).toBe(false);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Generate commit message"]',
        )!
        .click();
    });
    expect(container.querySelector("textarea")?.value).toBe("New message");

    await act(async () => resolveFirst("Old message"));
    expect(container.querySelector("textarea")?.value).toBe("New message");
  });
});

afterEach(() => {
  act(() => root.unmount());
  vi.clearAllTimers();
  vi.useRealTimers();
  container.remove();
  document.body
    .querySelectorAll("[data-popover-side]")
    .forEach((element) => element.remove());
  vi.unstubAllGlobals();
});

async function renderPanel(cwd = "/repo", sessionId?: string) {
  act(() =>
    root.render(
      createElement(GitChangesPanel, {
        cwd,
        sessionId,
        enabled: true,
        onOpenFile: vi.fn(),
        onOpenAllChanges: vi.fn(),
        onOpenCommit: vi.fn(),
      }),
    ),
  );
  await act(async () => {});
}

async function openBranchMenu() {
  const toggle = container.querySelector<HTMLButtonElement>(
    '[aria-label="Branch actions"]',
  )!;
  await act(async () => toggle.click());
  await act(async () => {});
  return document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
}

function changedFile(
  relative: string,
  overrides: Partial<GitChangedFile> = {},
): GitChangedFile {
  return {
    path: `/repo/${relative}`,
    relative,
    status: "modified",
    additions: 1,
    deletions: 0,
    staged: false,
    unstaged: true,
    ...overrides,
  };
}

async function showTree() {
  const toggle = container.querySelector<HTMLButtonElement>(
    '[aria-label="View as Tree"]',
  );
  if (toggle) await act(async () => toggle.click());
  let collapsed: HTMLButtonElement | null;
  while (
    (collapsed = container.querySelector<HTMLButtonElement>(
      'button[title][aria-expanded="false"]',
    ))
  ) {
    const folder = collapsed;
    await act(async () => folder.click());
  }
}

describe("GitChangesPanel folder actions", () => {
  it.each(["/repo", "remote://machine/home/user/repo"])(
    "stages a collapsed folder in one operation for %s",
    async (cwd) => {
      const files = [
        changedFile("src/app.ts", { path: `${cwd}/src/app.ts` }),
        changedFile("src/nested/new.ts", {
          path: `${cwd}/src/nested/new.ts`,
          status: "untracked",
        }),
        changedFile("src-other/other.ts"),
        changedFile("docs/ready.md", { staged: true, unstaged: false }),
      ];
      vi.mocked(gitDiffIndex).mockResolvedValue(index({ files }));
      await renderPanel(cwd);
      await showTree();
      const folder = container.querySelector<HTMLButtonElement>(
        'button[title="src"]',
      )!;
      await act(async () => folder.click());
      expect(folder.getAttribute("aria-expanded")).toBe("false");
      expect(container.querySelector('button[title="src/app.ts"]')).toBeNull();

      invalidateWatchedFiles.mockClear();
      vi.mocked(notifyGitChanged).mockClear();
      const reads = vi.mocked(gitDiffIndex).mock.calls.length;
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label="Stage Changes in src"]',
          )!
          .click();
      });

      expect(gitStageFile).toHaveBeenCalledExactlyOnceWith(cwd, "src");
      expect(gitUnstageFile).not.toHaveBeenCalled();
      expect(invalidateWatchedFiles).toHaveBeenCalledWith([
        `${cwd}/src/app.ts`,
        `${cwd}/src/nested/new.ts`,
      ]);
      expect(notifyGitChanged).toHaveBeenCalled();
      expect(vi.mocked(gitDiffIndex).mock.calls.length).toBeGreaterThan(reads);
      expect(folder.getAttribute("aria-expanded")).toBe("false");
    },
  );

  it("stages a nested folder without toggling it or including its siblings", async () => {
    vi.mocked(gitDiffIndex).mockResolvedValue(
      index({
        files: [
          changedFile("src/app.ts"),
          changedFile("src/nested/one.ts"),
          changedFile("src/nested/deeper/two.ts"),
          changedFile("src/nested-other/three.ts"),
        ],
      }),
    );
    await renderPanel();
    await showTree();
    const folder = container.querySelector<HTMLButtonElement>(
      'button[title="src/nested"]',
    )!;
    invalidateWatchedFiles.mockClear();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Stage Changes in src/nested"]',
        )!
        .click();
    });

    expect(gitStageFile).toHaveBeenCalledExactlyOnceWith("/repo", "src/nested");
    expect(folder.getAttribute("aria-expanded")).toBe("true");
    expect(invalidateWatchedFiles).toHaveBeenCalledWith([
      "/repo/src/nested/one.ts",
      "/repo/src/nested/deeper/two.ts",
    ]);
  });

  it("unstages the staged folder including files that also have unstaged changes", async () => {
    vi.mocked(gitDiffIndex).mockResolvedValue(
      index({
        files: [
          changedFile("src/app.ts", { staged: true, unstaged: false }),
          changedFile("src/nested/partial.ts", { staged: true }),
          changedFile("docs/readme.md", { staged: true, unstaged: false }),
        ],
      }),
    );
    await renderPanel();
    await showTree();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Unstage Changes in src"]',
        )!
        .click();
    });

    expect(gitUnstageFile).toHaveBeenCalledExactlyOnceWith("/repo", "src");
    expect(gitStageFile).not.toHaveBeenCalled();
  });

  it("disables folder and file mutations while a folder action is running", async () => {
    vi.mocked(gitDiffIndex).mockResolvedValue(
      index({
        files: [changedFile("src/app.ts"), changedFile("docs/readme.md")],
      }),
    );
    let finish!: () => void;
    vi.mocked(gitStageFile).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await renderPanel();
    await showTree();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Stage Changes in src"]',
        )!
        .click();
    });
    const actions = [
      ...container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label^="Stage Changes"], button[aria-label="Discard Changes"]',
      ),
    ];
    expect(actions.length).toBeGreaterThan(2);
    expect(actions.every((action) => action.disabled)).toBe(true);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Stage Changes in docs"]',
        )!
        .click();
    });
    expect(gitStageFile).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    expect(actions.every((action) => !action.disabled)).toBe(true);
  });

  it("reports errors and enables folder actions again", async () => {
    reportError.mockClear();
    vi.mocked(gitDiffIndex).mockResolvedValue(
      index({ files: [changedFile("src/app.ts")] }),
    );
    const locked = new Error("Git index is locked");
    vi.mocked(gitStageFile).mockRejectedValueOnce(locked);
    await renderPanel();
    await showTree();
    invalidateWatchedFiles.mockClear();
    const stage = container.querySelector<HTMLButtonElement>(
      '[aria-label="Stage Changes in src"]',
    )!;
    await act(async () => stage.click());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(reportError).toHaveBeenCalledWith("stage src", locked);
    expect(stage.disabled).toBe(false);
    expect(invalidateWatchedFiles).not.toHaveBeenCalled();
  });
});

describe("GitChangesPanel pull action", () => {
  it("disables Pull when the branch has no upstream", async () => {
    vi.mocked(gitDiffIndex).mockResolvedValue(
      index({ remote: null, upstream: null }),
    );
    await renderPanel();

    const pull = await openBranchMenu();
    expect(pull.textContent).toContain("Pull");
    expect(pull.disabled).toBe(true);
  });

  it("disables Pull when the repository has no remote", async () => {
    vi.mocked(gitDiffIndex).mockResolvedValue(
      index({ remote: null, upstream: "origin/feature/pull" }),
    );
    await renderPanel();

    const pull = await openBranchMenu();
    expect(pull.disabled).toBe(true);
  });

  it("pulls the current branch and reloads watched files", async () => {
    vi.mocked(gitDiffIndex).mockResolvedValue(
      index({ remote: "origin", upstream: "origin/feature/pull" }),
    );
    await renderPanel();

    const pull = await openBranchMenu();
    expect(pull.disabled).toBe(false);

    invalidateWatchedFiles.mockClear();
    await act(async () => {
      pull.click();
      await Promise.resolve();
    });

    expect(gitPull).toHaveBeenCalledWith("/repo");
    expect(invalidateWatchedFiles).toHaveBeenCalled();
  });
});

describe("GitChangesPanel remote pull request", () => {
  it("creates it from the host Git range without calling a local harness", async () => {
    const cwd = "remote://machine/home/user/repo";
    vi.mocked(gitDiffIndex).mockResolvedValue(
      index({
        remote: "origin",
        upstream: "origin/feature/pull",
        ahead: 1,
        aheadOfDefault: 1,
      }),
    );
    vi.mocked(gitRangeContext).mockResolvedValue({
      base: "main",
      head: "feature/pull",
      commitSummary: "abc123 Fix remote flow\ndef456 Add coverage",
      diffSummary: "2 files changed, 4 insertions(+)\n",
      diffPatch: "",
    });
    vi.mocked(gitPrCreate).mockResolvedValue("https://example.test/pull/42");
    await renderPanel(cwd);

    const button = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((candidate) => candidate.textContent?.trim() === "Create PR");
    expect(button?.disabled).toBe(false);
    await act(async () => {
      button!.click();
      await Promise.resolve();
    });

    expect(gitPush).toHaveBeenCalledWith(cwd);
    expect(gitRangeContext).toHaveBeenCalledWith(cwd);
    expect(generatePrContent).not.toHaveBeenCalled();
    expect(gitPrCreate).toHaveBeenCalledWith(
      cwd,
      "Fix remote flow",
      expect.stringContaining("## Changes\n\n2 files changed"),
      "main",
      "feature/pull",
    );
    expect(openUrl).toHaveBeenCalledWith("https://example.test/pull/42");
    // Remote chats are not tracked.
    expect(recordPrUrl).not.toHaveBeenCalled();
  });
});

describe("GitChangesPanel pull request attribution", () => {
  async function createLocalPr(sessionId?: string) {
    vi.mocked(recordPrUrl).mockClear();
    vi.mocked(gitDiffIndex).mockResolvedValue(
      index({
        remote: "origin",
        upstream: "origin/feature/pull",
        ahead: 0,
        aheadOfDefault: 1,
      }),
    );
    vi.mocked(generatePrContent).mockResolvedValue({
      title: "Fix",
      body: "Body",
      base: "main",
      head: "feature/pull",
    });
    vi.mocked(gitPrCreate).mockResolvedValue(
      "https://github.com/acme/web/pull/482\n",
    );
    await renderPanel("/repo", sessionId);
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((candidate) => candidate.textContent?.trim() === "Create PR");
    expect(button?.disabled).toBe(false);
    await act(async () => {
      button!.click();
      await Promise.resolve();
    });
    await act(async () => {});
    expect(gitPrCreate).toHaveBeenCalled();
  }

  it("records the created PR for the chat after gitPrCreate succeeds", async () => {
    await createLocalPr("s1");
    expect(recordPrUrl).toHaveBeenCalledWith(
      "s1",
      "https://github.com/acme/web/pull/482",
    );
  });

  it("records nothing without a chat", async () => {
    await createLocalPr(undefined);
    expect(recordPrUrl).not.toHaveBeenCalled();
  });
});

describe("GitChangesPanel chat pull requests", () => {
  const REPO = "acme/web";
  function prEntry(
    number: number,
    headRef: string,
    over: Partial<PrEntry> = {},
  ): PrEntry {
    return {
      snapshot: {
        repo: REPO,
        number,
        url: `https://github.com/${REPO}/pull/${number}`,
        title: `PR ${number}`,
        state: "open",
        isDraft: false,
        headRef,
        baseRef: "main",
        originalBaseRef: "main",
        headOid: `oid-${number}`,
        author: "maya",
        checks: "none",
        review: "none",
        mergeable: "mergeable",
        behindBy: null,
        fetchedAt: Date.now(),
      },
      relation: "owned",
      ownerSessionId: "s1",
      onLiveBranch: false,
      parent: null,
      attention: "none",
      attentionReason: null,
      dismissed: false,
      error: null,
      ...over,
    };
  }
  function setView(entries: PrEntry[]) {
    prState.view = {
      sessionId: "s1",
      entries,
      stacks: [],
      tracking: "full",
      status: "ok",
      refreshedAt: Date.now(),
    };
  }
  const buttonText = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === text,
    );

  beforeEach(() => {
    vi.mocked(gitPrCreate).mockReset().mockResolvedValue(
      "https://github.com/acme/web/pull/490",
    );
    vi.mocked(gitIsAncestor).mockReset().mockResolvedValue(false);
    vi.mocked(gitBranches).mockClear();
    vi.mocked(gitPrStatus).mockReset().mockResolvedValue(null);
    vi.mocked(generatePrContent).mockResolvedValue({
      title: "Next",
      body: "Body",
      base: "main",
      head: "mc/next",
    });
  });

  function readyToCreate() {
    vi.mocked(gitDiffIndex).mockResolvedValue(
      index({
        branch: "mc/next",
        remote: "origin",
        upstream: "origin/mc/next",
        aheadOfDefault: 1,
      }),
    );
  }

  it("adds nothing with an empty set or without a chat", async () => {
    readyToCreate();
    setView([]);
    await renderPanel("/repo", "s1");
    expect(container.querySelector(".pr-section")).toBeNull();
    expect(container.querySelector("[data-pr-base-field]")).toBeNull();
    expect(buttonText("Create PR")).toBeDefined();

    setView([prEntry(482, "mc/tasks-panel-keyboard")]);
    await renderPanel("/repo", undefined);
    expect(container.querySelector(".pr-section")).toBeNull();
    expect(container.querySelector("[data-pr-base-field]")).toBeNull();
    expect(gitIsAncestor).not.toHaveBeenCalled();
  });

  it("lists the chat's PRs under the sync actions and moves View into the split button", async () => {
    vi.mocked(gitDiffIndex).mockResolvedValue(
      index({
        branch: "mc/tasks-panel-keyboard",
        remote: "origin",
        upstream: "origin/mc/tasks-panel-keyboard",
      }),
    );
    vi.mocked(gitPrStatus).mockResolvedValue({
      number: 482,
      title: "PR 482",
      url: `https://github.com/${REPO}/pull/482`,
      state: "open",
    });
    setView([
      prEntry(480, "mc/tasks-panel-virtual"),
      prEntry(482, "mc/tasks-panel-keyboard", { onLiveBranch: true }),
    ]);
    await renderPanel("/repo", "s1");
    const section = container.querySelector(".pr-section");
    expect(section).not.toBeNull();
    expect(section!.querySelectorAll("[data-pr-row]")).toHaveLength(2);
    expect(buttonText("View #482")).toBeDefined();
    expect(buttonText("View PR #482")).toBeUndefined();
  });

  it("preselects a stacked base and creates the PR against it", async () => {
    readyToCreate();
    setView([
      prEntry(480, "mc/tasks-panel-virtual"),
      prEntry(482, "mc/tasks-panel-keyboard", { parent: 480 }),
    ]);
    vi.mocked(gitIsAncestor).mockImplementation(async (_cwd, ref) =>
      ref === "mc/tasks-panel-keyboard" || ref === "mc/tasks-panel-virtual",
    );
    await renderPanel("/repo", "s1");
    await act(async () => {});

    const field = container.querySelector("[data-pr-base-field]");
    expect(field).not.toBeNull();
    const label = field!.querySelector("label");
    expect(label?.textContent).toBe("Base");
    const select = field!.querySelector("select")!;
    expect(label?.htmlFor).toBe(select.id);
    expect(field!.querySelector(".pr-base-value")?.textContent).toBe(
      "#482 · mc/tasks-panel-keyboard",
    );
    expect(field!.querySelector(".pr-tag")?.textContent).toBe("Stacked");
    expect(gitIsAncestor).toHaveBeenCalledWith(
      "/repo",
      "mc/tasks-panel-keyboard",
      "HEAD",
    );

    await act(async () => {
      buttonText("Create PR")!.click();
      await Promise.resolve();
    });
    await act(async () => {});
    expect(gitPrCreate).toHaveBeenCalledWith(
      "/repo",
      "Next",
      "Body",
      "mc/tasks-panel-keyboard",
      "mc/next",
    );
    // The title and body are generated against the stacked base, too.
    expect(generatePrContent).toHaveBeenCalledWith(
      "/repo",
      undefined,
      "mc/tasks-panel-keyboard",
    );
  });

  it("lets the user override the base", async () => {
    readyToCreate();
    setView([prEntry(482, "mc/tasks-panel-keyboard")]);
    vi.mocked(gitIsAncestor).mockResolvedValue(true);
    await renderPanel("/repo", "s1");
    await act(async () => {});
    const select = container.querySelector<HTMLSelectElement>(
      "[data-pr-base-field] select",
    )!;
    expect([...select.options].map((o) => o.value)).toEqual([
      "mc/tasks-panel-keyboard",
      "main",
    ]);
    await act(async () => {
      select.value = "main";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector(".pr-base-value")?.textContent).toBe("main");
    expect(container.querySelector("[data-pr-base-field] .pr-tag")).toBeNull();
    await act(async () => {
      buttonText("Create PR")!.click();
      await Promise.resolve();
    });
    await act(async () => {});
    expect(gitPrCreate).toHaveBeenCalledWith("/repo", "Next", "Body", "main", "mc/next");
    expect(generatePrContent).toHaveBeenCalledWith("/repo", undefined, "main");
  });

  it("targets the default branch when no chat PR is an ancestor", async () => {
    readyToCreate();
    setView([prEntry(482, "mc/tasks-panel-keyboard")]);
    await renderPanel("/repo", "s1");
    await act(async () => {});
    expect(container.querySelector(".pr-base-value")?.textContent).toBe("main");
    expect(container.querySelector("[data-pr-base-field] .pr-tag")).toBeNull();
  });
});
