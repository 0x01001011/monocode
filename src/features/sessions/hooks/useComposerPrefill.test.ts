// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearComposerPrefill,
  isComposerMounted,
  peekComposerPrefill,
  requestComposerPrefill,
} from "../model/composerPrefill";
import { useComposerPrefill } from "./useComposerPrefill";

let container: HTMLDivElement;
let root: Root;
const insert = vi.fn();

function Probe(props: { sessionId: string; visible: boolean }) {
  useComposerPrefill(props.sessionId, props.visible, insert);
  return null;
}
const render = (sessionId: string, visible: boolean) => act(() => root.render(createElement(Probe, { sessionId, visible })));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  insert.mockClear();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  for (const id of ["a", "b"]) {
    const pending = peekComposerPrefill(id);
    if (pending) clearComposerPrefill(id, pending.token);
  }
});

describe("useComposerPrefill", () => {
  it("marks the session's composer mounted while the pane is mounted, hidden or not", () => {
    expect(isComposerMounted("a")).toBe(false);
    render("a", false);
    expect(isComposerMounted("a")).toBe(true);
    render("b", false);
    expect(isComposerMounted("a")).toBe(false);
    expect(isComposerMounted("b")).toBe(true);
    act(() => root.unmount());
    expect(isComposerMounted("b")).toBe(false);
    root = createRoot(container);
  });

  it("inserts a request that was made before the pane mounted, then clears it", () => {
    requestComposerPrefill("a", "About your decision: x");
    render("a", true);
    expect(insert).toHaveBeenCalledWith("About your decision: x");
    expect(peekComposerPrefill("a")).toBeNull();
  });

  it("inserts a request made while the pane is showing", () => {
    render("a", true);
    expect(insert).not.toHaveBeenCalled();
    act(() => requestComposerPrefill("a", "later"));
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith("later");
  });

  it("waits while the pane is hidden", () => {
    requestComposerPrefill("a", "wait");
    render("a", false);
    expect(insert).not.toHaveBeenCalled();
    render("a", true);
    expect(insert).toHaveBeenCalledWith("wait");
  });

  it("ignores requests for other sessions and inserts only once", () => {
    requestComposerPrefill("b", "not mine");
    render("a", true);
    render("a", true);
    expect(insert).not.toHaveBeenCalled();
    expect(peekComposerPrefill("b")?.text).toBe("not mine");
  });
});
