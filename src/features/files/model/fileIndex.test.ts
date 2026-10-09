import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectFile } from "../../../platform/tauri/fs";
import { listProjectFiles, statFiles } from "../../../platform/tauri/fs";
import {
  invalidateProjectFiles,
  loadProjectFiles,
  peekProjectFiles,
  rememberOpenedFile,
  resolveFileOpenRequest,
  resolveOpenablePath,
  subscribeProjectFiles,
} from "./fileIndex";
import { notifyDirsChanged } from "./fileTree";

const cwd = "/Users/me/project";
const files: ProjectFile[] = [
  {
    name: "App.tsx",
    path: "/Users/me/project/apps/desktop/src/App.tsx",
    relative: "apps/desktop/src/App.tsx",
  },
  {
    name: "App.tsx",
    path: "/Users/me/project/apps/web/src/App.tsx",
    relative: "apps/web/src/App.tsx",
  },
  {
    name: "main.tsx",
    path: "/Users/me/project/apps/desktop/src/main.tsx",
    relative: "apps/desktop/src/main.tsx",
  },
];

const extra: ProjectFile = {
  name: "pasted.ts",
  path: "/Users/me/project/pasted.ts",
  relative: "pasted.ts",
};

vi.mock("../../../platform/tauri/fs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../platform/tauri/fs")>();
  return {
    ...actual,
    listProjectFiles: vi.fn(async () => files),
    statFiles: vi.fn(async (paths: string[]) =>
      paths.map((path) => ({ path, mtimeMs: null })),
    ),
  };
});

const list = vi.mocked(listProjectFiles);
const stat = vi.mocked(statFiles);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("resolveOpenablePath", () => {
  beforeEach(() => {
    invalidateProjectFiles();
    list.mockReset();
    list.mockResolvedValue(files);
  });

  it("maps a basename-only link to the shortest matching project path", async () => {
    const resolved = await resolveOpenablePath(cwd, "App.tsx");
    expect(resolved).toBe(files[1].path);
  });

  it("prefers recently opened files for ambiguous basenames", async () => {
    rememberOpenedFile(cwd, files[1].path);
    const resolved = await resolveOpenablePath(cwd, "App.tsx");
    expect(resolved).toBe(files[1].path);
  });

  it("matches a relative project path", async () => {
    const resolved = await resolveOpenablePath(
      cwd,
      "apps/desktop/src/main.tsx",
    );
    expect(resolved).toBe(files[2].path);
  });

  it("still opens a direct file when the optional project index is unavailable", async () => {
    list.mockRejectedValue(new Error("Project scan unavailable"));
    await expect(
      resolveOpenablePath(cwd, "apps/desktop/src/main.tsx"),
    ).resolves.toBe(files[2].path);
  });

  it("preserves an exact path even when it is absent from the project index", async () => {
    const ignored = `${cwd}/ignored/App.tsx`;
    await expect(
      resolveFileOpenRequest(cwd, ignored, { exact: true }),
    ).resolves.toBe(ignored);
    expect(list).not.toHaveBeenCalled();
  });
});

describe("resolveFileOpenRequest with session mentions", () => {
  const bare = `${cwd}/research.md`;
  const mentioned = `${cwd}/autoresearch/loop-1/research.md`;
  const texts = () => [
    "report: autoresearch/loop-1/research.md",
    "see research.md",
  ];

  beforeEach(() => {
    invalidateProjectFiles();
    list.mockResolvedValue(files);
  });

  function existing(...paths: string[]) {
    stat.mockImplementation(async (input) =>
      input.map((path) => ({ path, mtimeMs: paths.includes(path) ? 1 : null })),
    );
  }

  it("opens the path the agent named when a bare gitignored file is missing", async () => {
    existing(mentioned);
    expect(await resolveFileOpenRequest(cwd, bare, undefined, texts)).toBe(
      mentioned,
    );
  });

  it("keeps the direct path when that file exists", async () => {
    existing(bare, mentioned);
    expect(await resolveFileOpenRequest(cwd, bare, undefined, texts)).toBe(
      bare,
    );
  });

  it("falls back to the direct path when no mentioned path exists", async () => {
    existing();
    expect(await resolveFileOpenRequest(cwd, bare, undefined, texts)).toBe(
      bare,
    );
  });

  it("does not stat or search the transcript for exact opens", async () => {
    existing(mentioned);
    const mentions = vi.fn(texts);
    expect(
      await resolveFileOpenRequest(cwd, bare, { exact: true }, mentions),
    ).toBe(bare);
    expect(mentions).not.toHaveBeenCalled();
  });

  it("survives an unreachable host while checking candidates", async () => {
    stat.mockRejectedValue(new Error("offline"));
    expect(await resolveFileOpenRequest(cwd, bare, undefined, texts)).toBe(
      bare,
    );
  });
});

describe("loadProjectFiles", () => {
  beforeEach(() => {
    invalidateProjectFiles();
    list.mockReset();
    list.mockResolvedValue(files);
  });

  afterEach(() => {
    vi.useRealTimers();
    invalidateProjectFiles();
  });

  it("returns the cached listing until refresh", async () => {
    await loadProjectFiles(cwd);
    list.mockResolvedValue([...files, extra]);
    expect(await loadProjectFiles(cwd)).toEqual(files);
    expect(list).toHaveBeenCalledTimes(1);
    expect(await loadProjectFiles(cwd, true)).toEqual([...files, extra]);
    expect(peekProjectFiles(cwd)).toEqual([...files, extra]);
  });

  it("does not drop a refresh that arrives while a scan is in flight", async () => {
    const first = deferred<ProjectFile[]>();
    const second = deferred<ProjectFile[]>();
    list.mockImplementationOnce(() => first.promise);
    list.mockImplementationOnce(() => second.promise);

    const initial = loadProjectFiles(cwd);
    const refresh = loadProjectFiles(cwd, true);
    expect(list).toHaveBeenCalledTimes(2);

    first.resolve(files);
    expect(await initial).toEqual(files);
    expect(peekProjectFiles(cwd)).toBeNull();

    second.resolve([...files, extra]);
    expect(await refresh).toEqual([...files, extra]);
    expect(peekProjectFiles(cwd)).toEqual([...files, extra]);
  });

  it("reuses the in-flight scan when refresh is not requested", async () => {
    const pending = deferred<ProjectFile[]>();
    list.mockImplementationOnce(() => pending.promise);

    const first = loadProjectFiles(cwd);
    const second = loadProjectFiles(cwd);
    expect(list).toHaveBeenCalledTimes(1);

    pending.resolve(files);
    expect(await first).toEqual(files);
    expect(await second).toEqual(files);
  });

  it("keeps both worktree indexes during repeated tab switches", async () => {
    const other = "/Users/me/project-worktree";
    const otherFiles = [{ ...extra, path: `${other}/pasted.ts` }];
    list.mockImplementation(async (path) =>
      path === cwd ? files : otherFiles,
    );

    for (let index = 0; index < 10; index++) {
      expect(await loadProjectFiles(cwd)).toBe(files);
      expect(await loadProjectFiles(other)).toBe(otherFiles);
    }
    expect(list).toHaveBeenCalledTimes(2);
    expect(peekProjectFiles(cwd)).toBe(files);
    expect(peekProjectFiles(other)).toBe(otherFiles);
  });

  it("lets scans for separate worktrees finish independently", async () => {
    const other = "/Users/me/project-worktree";
    const first = deferred<ProjectFile[]>();
    const second = deferred<ProjectFile[]>();
    list.mockImplementationOnce(() => first.promise);
    list.mockImplementationOnce(() => second.promise);
    const firstScan = loadProjectFiles(cwd);
    const secondScan = loadProjectFiles(other);
    expect(loadProjectFiles(cwd)).toBe(firstScan);
    expect(loadProjectFiles(other)).toBe(secondScan);
    first.resolve(files);
    second.resolve([extra]);
    await Promise.all([firstScan, secondScan]);
    expect(peekProjectFiles(cwd)).toBe(files);
    expect(peekProjectFiles(other)).toEqual([extra]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("invalidates one worktree without evicting or cancelling another", async () => {
    const other = "/Users/me/project-worktree";
    await loadProjectFiles(cwd);
    await loadProjectFiles(other);
    invalidateProjectFiles(cwd);
    expect(peekProjectFiles(cwd)).toBeNull();
    expect(await loadProjectFiles(other)).toBe(files);
    expect(list).toHaveBeenCalledTimes(2);
    await loadProjectFiles(cwd);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("does not let an invalidated scan restore its old listing", async () => {
    const pending = deferred<ProjectFile[]>();
    list.mockImplementationOnce(() => pending.promise);
    const scan = loadProjectFiles(cwd);
    invalidateProjectFiles(cwd);
    pending.resolve(files);
    await scan;
    expect(peekProjectFiles(cwd)).toBeNull();
  });

  it("bounds retained worktrees and keeps recently revisited ones", async () => {
    for (let index = 0; index < 32; index++) {
      await loadProjectFiles(`/repo/tree-${index}`);
    }
    await loadProjectFiles("/repo/tree-0");
    await loadProjectFiles("/repo/tree-32");
    expect(peekProjectFiles("/repo/tree-0")).toBe(files);
    expect(peekProjectFiles("/repo/tree-1")).toBeNull();
    expect(list).toHaveBeenCalledTimes(33);
  });

  it("evicts older worktrees sooner when listings are huge, but keeps a floor", async () => {
    const huge = Array.from({ length: 60_000 }, (_, index) => ({
      ...files[0]!,
      relative: `f${index}.ts`,
    }));
    list.mockResolvedValue(huge);
    for (let index = 0; index < 9; index++) {
      await loadProjectFiles(`/repo/big-${index}`);
    }
    expect(peekProjectFiles("/repo/big-0")).toBeNull();
    for (let index = 1; index < 9; index++) {
      expect(peekProjectFiles(`/repo/big-${index}`)).toBe(huge);
    }
  });

  it("notifies subscribers when the listing changes", async () => {
    const onChange = vi.fn();
    const stop = subscribeProjectFiles(onChange);
    await loadProjectFiles(cwd);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(peekProjectFiles(cwd)).toEqual(files);
    stop();
  });

  it("reloads after a directory change", async () => {
    vi.useFakeTimers();
    await loadProjectFiles(cwd);
    list.mockResolvedValue([...files, extra]);

    const onChange = vi.fn();
    const stop = subscribeProjectFiles(onChange);
    onChange.mockClear();
    notifyDirsChanged();

    await vi.runAllTimersAsync();
    expect(peekProjectFiles(cwd)).toEqual([...files, extra]);
    expect(onChange).toHaveBeenCalled();
    stop();
  });

  it("does not drop a scan for a different project", async () => {
    const other = "/Users/me/other";
    const pending = deferred<ProjectFile[]>();
    list.mockImplementationOnce(() => pending.promise);

    const scan = loadProjectFiles(other);
    invalidateProjectFiles(cwd);
    pending.resolve(files);

    expect(await scan).toEqual(files);
    expect(peekProjectFiles(other)).toEqual(files);
  });
});
