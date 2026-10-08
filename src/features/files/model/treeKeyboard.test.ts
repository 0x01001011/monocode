import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FsEntry } from "../../../platform/tauri/fs";
import { listCachedDir } from "./fileTree";
import { treeNavAction, treeTabStop, type TreeNavItem } from "./treeKeyboard";

const { directories } = vi.hoisted(() => ({
  directories: new Map<string, FsEntry[]>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(
    async (_command: string, args: { path: string }) =>
      directories.get(args.path) ?? [],
  ),
}));

// src/ (open) > [lib/ (closed), app.ts], then README.md
const items: TreeNavItem[] = [
  { path: "/p/src", level: 1, isDir: true, open: true },
  { path: "/p/src/lib", level: 2, isDir: true, open: false },
  { path: "/p/src/app.ts", level: 2, isDir: false, open: false },
  { path: "/p/README.md", level: 1, isDir: false, open: false },
];

describe("treeNavAction", () => {
  it("moves with Up, Down, Home and End and stops at the ends", () => {
    expect(treeNavAction("ArrowDown", items, 0)).toEqual({
      type: "focus",
      path: "/p/src/lib",
    });
    expect(treeNavAction("ArrowUp", items, 1)).toEqual({
      type: "focus",
      path: "/p/src",
    });
    expect(treeNavAction("Home", items, 2)).toEqual({
      type: "focus",
      path: "/p/src",
    });
    expect(treeNavAction("End", items, 0)).toEqual({
      type: "focus",
      path: "/p/README.md",
    });
    expect(treeNavAction("ArrowUp", items, 0)).toBeNull();
    expect(treeNavAction("ArrowDown", items, 3)).toBeNull();
  });

  it("expands a closed folder, then steps into it", () => {
    expect(treeNavAction("ArrowRight", items, 1)).toEqual({
      type: "expand",
      path: "/p/src/lib",
    });
    expect(treeNavAction("ArrowRight", items, 0)).toEqual({
      type: "focus",
      path: "/p/src/lib",
    });
  });

  it("does nothing on Right for files or an open empty folder", () => {
    expect(treeNavAction("ArrowRight", items, 2)).toBeNull();
    const empty: TreeNavItem[] = [
      { path: "/p/a", level: 1, isDir: true, open: true },
      { path: "/p/b", level: 1, isDir: false, open: false },
    ];
    expect(treeNavAction("ArrowRight", empty, 0)).toBeNull();
  });

  it("collapses an open folder, otherwise goes to the parent", () => {
    expect(treeNavAction("ArrowLeft", items, 0)).toEqual({
      type: "collapse",
      path: "/p/src",
    });
    expect(treeNavAction("ArrowLeft", items, 2)).toEqual({
      type: "focus",
      path: "/p/src",
    });
    expect(treeNavAction("ArrowLeft", items, 1)).toEqual({
      type: "focus",
      path: "/p/src",
    });
    expect(treeNavAction("ArrowLeft", items, 3)).toBeNull();
  });

  it("ignores other keys and unknown positions", () => {
    expect(treeNavAction("a", items, 0)).toBeNull();
    expect(treeNavAction("ArrowDown", items, -1)).toBeNull();
  });
});

describe("treeTabStop", () => {
  const cwd = "/tab-stop-project";
  const entry = (name: string, isDir = false, ignored = false) => ({
    name,
    path: `${cwd}/${name}`,
    isDir,
    ignored,
  });

  beforeAll(async () => {
    directories.set(cwd, [entry("src", true), entry("dist", true, true)]);
    directories.set(`${cwd}/src`, [entry("src/app.ts")]);
    directories.set(`${cwd}/dist`, []);
    await listCachedDir(cwd);
    await listCachedDir(`${cwd}/src`);
  });

  it("falls back to the first row when nothing visible is selected", () => {
    const open = new Set([cwd]);
    const first = `${cwd}/src`;
    expect(treeTabStop(cwd, null, open, false, first)).toBe(first);
    expect(treeTabStop(cwd, cwd, open, false, first)).toBe(first);
    expect(treeTabStop(cwd, `${cwd}/gone.ts`, open, false, first)).toBe(first);
  });

  it("keeps the selected row while every ancestor folder is open", () => {
    const selected = `${cwd}/src/app.ts`;
    const first = `${cwd}/src`;
    expect(
      treeTabStop(cwd, selected, new Set([cwd, first]), false, first),
    ).toBe(selected);
    // Collapsed parent: the row is not rendered, so the first row takes over.
    expect(treeTabStop(cwd, selected, new Set([cwd]), false, first)).toBe(
      first,
    );
  });

  it("skips a selected row that is hidden as excluded", () => {
    const hidden = `${cwd}/dist`;
    const first = `${cwd}/src`;
    expect(treeTabStop(cwd, hidden, new Set([cwd]), false, first)).toBe(first);
    expect(treeTabStop(cwd, hidden, new Set([cwd]), true, first)).toBe(hidden);
  });
});
