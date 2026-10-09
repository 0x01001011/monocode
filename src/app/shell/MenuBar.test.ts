// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../model/updater", () => ({ runUpdateFlow: vi.fn() }));

import { MenuBar } from "./MenuBar";

let container: HTMLDivElement;
let root: Root;
let outside: HTMLButtonElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  outside = document.createElement("button");
  document.body.append(outside);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      createElement(MenuBar, {
        onNew: vi.fn(),
        onToggleSidebar: vi.fn(),
        onToggleSessionSidebar: vi.fn(),
      }),
    ),
  );
  outside.focus();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  outside.remove();
  vi.unstubAllGlobals();
});

function tapAlt() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt" }));
  });
}

function press(target: Element, key: string) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const items = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-menubar-item]"));

describe("MenuBar keyboard entry", () => {
  it("renders nothing until Alt is tapped", () => {
    expect(document.querySelector('[role="menubar"]')).toBeNull();
  });

  it("focuses the first menu when Alt reveals the bar", () => {
    tapAlt();

    expect(document.querySelector('[role="menubar"]')).not.toBeNull();
    expect(document.activeElement).toBe(items()[0]);
  });

  it("exposes menubar semantics on the top-level buttons", () => {
    tapAlt();

    expect(items().map((item) => item.getAttribute("role"))).toEqual([
      "menuitem",
      "menuitem",
      "menuitem",
    ]);
    for (const item of items()) {
      expect(item.getAttribute("aria-haspopup")).toBe("menu");
      expect(item.getAttribute("aria-expanded")).toBe("false");
    }
    expect(items().map((item) => item.tabIndex)).toEqual([0, -1, -1]);
  });

  it("moves between menus with Left and Right and wraps", () => {
    tapAlt();
    const [file, view, terminal] = items();

    press(file!, "ArrowRight");
    expect(document.activeElement).toBe(view);
    press(view!, "ArrowRight");
    expect(document.activeElement).toBe(terminal);
    press(terminal!, "ArrowRight");
    expect(document.activeElement).toBe(file);
    press(file!, "ArrowLeft");
    expect(document.activeElement).toBe(terminal);
  });

  it("opens a dropdown with Down and reports it as expanded", () => {
    tapAlt();
    const [file] = items();

    press(file!, "ArrowDown");

    expect(file!.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("hides the bar on Escape and returns focus to where it was", () => {
    tapAlt();
    press(items()[0]!, "Escape");

    expect(document.querySelector('[role="menubar"]')).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it("returns focus to the previous element when Alt is tapped again", () => {
    tapAlt();
    tapAlt();

    expect(document.querySelector('[role="menubar"]')).toBeNull();
    expect(document.activeElement).toBe(outside);
  });
});
