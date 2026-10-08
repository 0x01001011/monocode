// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { rememberEditor } from "../model/openInEditor";
import { editorIdFromMenu, editorMenuItems } from "./editorMenu";

const editors = [
  { id: "vscode", name: "Visual Studio Code", remote: true },
  { id: "windsurf", name: "Windsurf", remote: false },
];

describe("editorMenuItems", () => {
  beforeEach(() => localStorage.clear());

  it("lists the last used editor first", () => {
    rememberEditor("windsurf");
    const [item] = editorMenuItems(editors, "/work/proj/a.ts");
    expect(item).toMatchObject({
      submenu: [
        { id: "external-editor:windsurf" },
        { id: "external-editor:vscode" },
      ],
    });
  });

  it("lists every installed editor for a local path", () => {
    expect(editorMenuItems(editors, "/work/proj/a.ts")).toEqual([
      {
        kind: "item",
        id: "external-editor",
        label: "Open in Editor",
        submenu: [
          {
            kind: "item",
            id: "external-editor:vscode",
            label: "Visual Studio Code",
          },
          { kind: "item", id: "external-editor:windsurf", label: "Windsurf" },
        ],
      },
    ]);
  });

  it("lists only remote-capable editors for a remote path", () => {
    const [item] = editorMenuItems(editors, "remote://env-1/home/k/a.rs");
    expect(item).toMatchObject({
      submenu: [{ id: "external-editor:vscode" }],
    });
  });

  it("adds nothing when no editor can open the path", () => {
    expect(editorMenuItems([], "/work/a.ts")).toEqual([]);
    expect(editorMenuItems([editors[1]], "remote://env-1/home/k/a.rs")).toEqual(
      [],
    );
  });
});

describe("editorIdFromMenu", () => {
  it("reads an editor id from a submenu pick", () => {
    expect(editorIdFromMenu("external-editor:zed")).toBe("zed");
  });

  it("ignores other menu ids and the submenu parent", () => {
    expect(editorIdFromMenu("external-editor")).toBeUndefined();
    expect(editorIdFromMenu("reveal")).toBeUndefined();
    expect(editorIdFromMenu("external-editor:")).toBeUndefined();
  });
});
