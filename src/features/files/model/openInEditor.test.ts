// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  editorRequest,
  editorsFor,
  lastEditorId,
  rememberEditor,
} from "./openInEditor";

const editors = [
  { id: "vscode", name: "Visual Studio Code", remote: true },
  { id: "windsurf", name: "Windsurf", remote: false },
  { id: "zed", name: "Zed", remote: true },
];

describe("editorRequest", () => {
  it("opens a remote folder on the machine, never sending a remote:// path", () => {
    expect(editorRequest("vscode", "remote://env-1/home/k/proj")).toEqual({
      command: "open_remote_in_external_editor",
      args: {
        editorId: "vscode",
        environmentId: "env-1",
        hostPath: "/home/k/proj",
        kind: "folder",
        line: null,
        column: null,
      },
    });
  });

  it("opens a remote file at its line and column", () => {
    const { command, args } = editorRequest(
      "zed",
      "remote://env-1/home/k/wt/a.rs",
      { isFile: true, line: 12, column: 3 },
    );
    expect(command).toBe("open_remote_in_external_editor");
    expect(args).toMatchObject({
      hostPath: "/home/k/wt/a.rs",
      kind: "file",
      line: 12,
      column: 3,
    });
    expect(JSON.stringify(args)).not.toContain("remote://");
  });

  it("opens a local folder with the existing command", () => {
    expect(editorRequest("vscode", "/work/proj")).toEqual({
      command: "open_in_external_editor",
      args: {
        editorId: "vscode",
        cwd: "/work/proj",
        file: null,
        line: null,
        column: null,
      },
    });
  });

  it("opens a local file inside its project at the line", () => {
    expect(
      editorRequest("vscode", "/work/proj/src/a.ts", {
        isFile: true,
        projectCwd: "/work/proj",
        line: 5,
      }).args,
    ).toEqual({
      editorId: "vscode",
      cwd: "/work/proj",
      file: "/work/proj/src/a.ts",
      line: 5,
      column: null,
    });
  });

  it("falls back to the file's folder when the project is unknown", () => {
    expect(
      editorRequest("vscode", "/work/proj/src/a.ts", { isFile: true }).args,
    ).toMatchObject({ cwd: "/work/proj/src", file: "/work/proj/src/a.ts" });
  });

  it("rejects a malformed remote path instead of guessing", () => {
    expect(() => editorRequest("vscode", "remote://env-only")).toThrow(
      /remote/i,
    );
  });
});

describe("editorsFor", () => {
  it("lists every editor for a local path", () => {
    expect(editorsFor(editors, "/work/proj")).toEqual(editors);
  });

  it("lists only remote-capable editors for a remote path", () => {
    expect(
      editorsFor(editors, "remote://env-1/home/k").map((e) => e.id),
    ).toEqual(["vscode", "zed"]);
  });
});

describe("remembered editor", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips through storage", () => {
    expect(lastEditorId()).toBeNull();
    rememberEditor("zed");
    expect(lastEditorId()).toBe("zed");
  });
});
