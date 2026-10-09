// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

let appRoot: HTMLElement;
let root: Root;

function App({ minimalHeader = false }: { minimalHeader?: boolean }) {
  const [open, setOpen] = useState(false);
  return createElement(
    "div",
    null,
    createElement(
      "button",
      { id: "trigger", type: "button", onClick: () => setOpen(true) },
      "Open",
    ),
    open
      ? createElement(
          Modal,
          {
            title: "Delete session",
            minimalHeader,
            onClose: () => setOpen(false),
          },
          createElement("input", { id: "name", "aria-label": "Name" }),
          createElement("button", { id: "confirm", type: "button" }, "Delete"),
        )
      : null,
  );
}

const byId = (id: string) => document.getElementById(id)!;
const key = (
  target: Element | Window,
  name: string,
  init: KeyboardEventInit = {},
) => {
  const event = new KeyboardEvent("keydown", {
    key: name,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
};

async function mount(props: { minimalHeader?: boolean } = {}) {
  await act(async () => root.render(createElement(App, props)));
  byId("trigger").focus();
  await act(async () => byId("trigger").click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  document.body.innerHTML = '<div id="root"></div>';
  appRoot = byId("root");
  root = createRoot(appRoot);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Modal focus management", () => {
  it("focuses the close button and makes the app behind it inert", async () => {
    await mount();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
    expect(appRoot.hasAttribute("inert")).toBe(true);
    // The dialog portals to <body>, so it stays outside the inert subtree.
    expect(appRoot.contains(document.querySelector('[role="dialog"]'))).toBe(
      false,
    );
  });

  it("wraps Tab and Shift+Tab inside the dialog", async () => {
    await mount();
    const close = document.querySelector<HTMLElement>('[aria-label="Close"]')!;
    await act(async () => byId("confirm").focus());
    await act(async () => void key(byId("confirm"), "Tab"));
    expect(document.activeElement).toBe(close);
    await act(async () => void key(close, "Tab", { shiftKey: true }));
    expect(document.activeElement).toBe(byId("confirm"));
  });

  it("returns focus to the trigger and lifts the inert state on close", async () => {
    await mount();
    await act(async () => void key(window, "Escape"));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(appRoot.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(byId("trigger"));
  });

  it("gives a minimal header's dialog a focused control inside", async () => {
    await mount({ minimalHeader: true });
    expect(document.activeElement?.id).toBe("name");
    await act(async () => void key(window, "Escape"));
    expect(document.activeElement).toBe(byId("trigger"));
  });
});
