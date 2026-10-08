import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dialog = vi.hoisted(() => ({
  ask: vi.fn(),
  message: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

import {
  confirmNative,
  errorDetail,
  formatErrorReport,
  reportError,
} from "./confirm";

beforeEach(() => {
  dialog.ask.mockReset().mockResolvedValue(true);
  dialog.message.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("confirmNative", () => {
  it("opens a native warning sheet whose confirm button names the action", async () => {
    await expect(
      confirmNative("Delete 3 files?", "Delete files"),
    ).resolves.toBe(true);
    expect(dialog.ask).toHaveBeenCalledWith("Delete 3 files?", {
      title: "MonoCode",
      kind: "warning",
      okLabel: "Delete files",
    });
  });

  it("returns the user's answer", async () => {
    dialog.ask.mockResolvedValue(false);
    await expect(confirmNative("Delete?", "Delete")).resolves.toBe(false);
  });
});

describe("errorDetail", () => {
  it.each([
    [new Error("fatal: not a git repository"), "fatal: not a git repository"],
    ["Error: remote hung up", "remote hung up"],
    ["  spaced  ", "spaced"],
    [{ toString: () => "custom" }, "custom"],
    [undefined, "undefined"],
  ])("reads %#", (input, expected) => {
    expect(errorDetail(input)).toBe(expected);
  });
});

describe("formatErrorReport", () => {
  it("leads with a plain sentence and puts the raw error second", () => {
    expect(
      formatErrorReport(
        "pull",
        new Error("could not resolve host"),
        "Check your connection and try again.",
      ),
    ).toBe(
      "Couldn't pull. Check your connection and try again.\n\ncould not resolve host",
    );
  });

  it("works without a hint", () => {
    expect(formatErrorReport("copy the session ID", "denied")).toBe(
      "Couldn't copy the session ID.\n\ndenied",
    );
  });

  it("omits the detail block when the error has no text", () => {
    expect(formatErrorReport("pull", new Error(""))).toBe("Couldn't pull.");
  });
});

describe("reportError", () => {
  it("shows the report in a native error sheet", async () => {
    await reportError("push", new Error("rejected"), "Pull first.");
    expect(dialog.message).toHaveBeenCalledWith(
      "Couldn't push. Pull first.\n\nrejected",
      { title: "MonoCode", kind: "error" },
    );
  });

  it("falls back to an alert when the native sheet is unavailable", async () => {
    const alert = vi.fn();
    vi.stubGlobal("alert", alert);
    dialog.message.mockRejectedValue(new Error("no tauri"));
    await reportError("push", "rejected");
    expect(alert).toHaveBeenCalledWith("Couldn't push.\n\nrejected");
  });
});
