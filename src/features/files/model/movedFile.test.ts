import { beforeEach, describe, expect, it, vi } from "vitest";
import { statFiles } from "../../../platform/tauri/fs";
import { listWorktrees } from "../../source-control/model/worktrees";
import { findInOtherCheckouts } from "./movedFile";

vi.mock("../../../platform/tauri/fs", () => ({ statFiles: vi.fn() }));
vi.mock("../../source-control/model/worktrees", () => ({
  listWorktrees: vi.fn(),
}));

const tree = (path: string, extra: object = {}) => ({
  path,
  branch: null,
  head: "",
  isMain: false,
  locked: false,
  prunable: false,
  missing: false,
  dirty: null,
  unpushed: null,
  sessionIds: [],
  ...extra,
});

const host = "remote://m1/home/k";
const worktree = `${host}/icc-workspace-worktrees/wt-mc-d6a7cd0f`;
const main = `${host}/icc-workspace`;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listWorktrees).mockResolvedValue({
    defaultRoot: `${host}/icc-workspace-worktrees`,
    worktrees: [tree(main, { isMain: true }), tree(worktree), tree(`${host}/other`)],
  });
});

const found = (checkout: string, relative: string) => ({
  checkout,
  path: `${checkout}/${relative}`,
});

const existing = (...paths: string[]) =>
  vi.mocked(statFiles).mockImplementation(async (wanted) =>
    wanted.map((path) => ({
      path,
      mtimeMs: paths.includes(path) ? 1 : null,
    })),
  );

describe("findInOtherCheckouts", () => {
  it("finds the same relative path in the project's other checkouts", async () => {
    existing(`${main}/task-1-report.md`);
    expect(
      await findInOtherCheckouts(`${worktree}/task-1-report.md`, worktree),
    ).toEqual([found(main, "task-1-report.md")]);
    // Only other checkouts are checked, never the one that failed.
    expect(vi.mocked(statFiles).mock.calls[0][0]).toEqual([
      `${main}/task-1-report.md`,
      `${host}/other/task-1-report.md`,
    ]);
  });

  it("keeps nested paths and lists every checkout that has the file", async () => {
    existing(`${main}/docs/a.md`, `${host}/other/docs/a.md`);
    expect(
      await findInOtherCheckouts(`${worktree}/docs/a.md`, worktree),
    ).toEqual([found(main, "docs/a.md"), found(`${host}/other`, "docs/a.md")]);
  });

  it("skips missing and prunable worktrees", async () => {
    vi.mocked(listWorktrees).mockResolvedValue({
      defaultRoot: "",
      worktrees: [
        tree(main, { isMain: true }),
        tree(worktree),
        tree(`${host}/gone`, { missing: true }),
        tree(`${host}/stale`, { prunable: true }),
      ],
    });
    existing(`${main}/a.md`);
    await findInOtherCheckouts(`${worktree}/a.md`, worktree);
    expect(vi.mocked(statFiles).mock.calls[0][0]).toEqual([`${main}/a.md`]);
  });

  it("returns nothing for a path outside the checkout", async () => {
    expect(await findInOtherCheckouts(`${host}/elsewhere/a.md`, worktree)).toEqual([]);
    expect(listWorktrees).not.toHaveBeenCalled();
  });

  it("returns nothing when the worktrees or files cannot be read", async () => {
    vi.mocked(listWorktrees).mockRejectedValue(new Error("unreachable"));
    expect(await findInOtherCheckouts(`${worktree}/a.md`, worktree)).toEqual([]);
    vi.mocked(listWorktrees).mockResolvedValue({
      defaultRoot: "",
      worktrees: [tree(main)],
    });
    vi.mocked(statFiles).mockRejectedValue(new Error("unreachable"));
    expect(await findInOtherCheckouts(`${worktree}/a.md`, worktree)).toEqual([]);
  });

  it("still checks a main checkout that contains the worktree", async () => {
    const nested = `${main}/.worktrees/wt`;
    vi.mocked(listWorktrees).mockResolvedValue({
      defaultRoot: "",
      worktrees: [tree(main, { isMain: true }), tree(nested)],
    });
    existing(`${main}/a.md`);
    expect(await findInOtherCheckouts(`${nested}/a.md`, nested)).toEqual([
      found(main, "a.md"),
    ]);
  });

  it("works for local checkouts", async () => {
    vi.mocked(listWorktrees).mockResolvedValue({
      defaultRoot: "",
      worktrees: [tree("/Users/me/app", { isMain: true }), tree("/Users/me/app-wt/x")],
    });
    existing("/Users/me/app/notes.md");
    expect(
      await findInOtherCheckouts("/Users/me/app-wt/x/notes.md", "/Users/me/app-wt/x"),
    ).toEqual([found("/Users/me/app", "notes.md")]);
  });
});
