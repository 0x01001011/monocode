// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inertBackground,
  restoreFocus,
  tabbableWithin,
  trapTab,
} from "./focusTrap";

let app: HTMLElement;
let dialog: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = `
    <div id="root"><button id="trigger">Open</button></div>
    <div id="dialog" tabindex="-1">
      <button id="close">Close</button>
      <input id="name" />
      <button id="disabled" disabled>Nope</button>
      <button id="skipped" tabindex="-1">Skip</button>
      <div hidden><button id="hidden">Hidden</button></div>
      <a id="link" href="#x">Link</a>
      <button id="confirm">Confirm</button>
    </div>`;
  app = document.getElementById("root")!;
  dialog = document.getElementById("dialog")!;
});

afterEach(() => {
  document.body.innerHTML = "";
});

const press = (
  target: Element,
  shiftKey = false,
  init: KeyboardEventInit = {},
) => {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
};

describe("tabbableWithin", () => {
  it("lists enabled, visible, tabbable controls in document order", () => {
    expect(tabbableWithin(dialog).map((el) => el.id)).toEqual([
      "close",
      "name",
      "link",
      "confirm",
    ]);
  });

  it("skips controls inside an inert subtree", () => {
    document.getElementById("name")!.setAttribute("inert", "");
    expect(tabbableWithin(dialog).map((el) => el.id)).not.toContain("name");
  });
});

describe("trapTab", () => {
  const handle = (event: KeyboardEvent) => trapTab(event, dialog);

  it("wraps Tab from the last control to the first", () => {
    const confirm = document.getElementById("confirm")!;
    confirm.focus();
    dialog.addEventListener("keydown", handle);
    const event = press(confirm);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("close");
  });

  it("wraps Shift+Tab from the first control to the last", () => {
    const close = document.getElementById("close")!;
    close.focus();
    dialog.addEventListener("keydown", handle);
    const event = press(close, true);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("confirm");
  });

  it("pulls focus back in when it sits on the panel itself", () => {
    dialog.focus();
    dialog.addEventListener("keydown", handle);
    press(dialog, true);
    expect(document.activeElement?.id).toBe("confirm");
    dialog.focus();
    press(dialog);
    expect(document.activeElement?.id).toBe("close");
  });

  it("leaves Tab between inner controls to the browser", () => {
    const name = document.getElementById("name")!;
    name.focus();
    dialog.addEventListener("keydown", handle);
    expect(press(name).defaultPrevented).toBe(false);
    expect(press(name, true).defaultPrevented).toBe(false);
  });

  it("holds focus on the panel when there is nothing to tab to", () => {
    dialog.innerHTML = "<p>Plain text</p>";
    dialog.addEventListener("keydown", handle);
    const event = press(dialog);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
  });

  it("ignores other keys, modified Tab and events from outside the panel", () => {
    const confirm = document.getElementById("confirm")!;
    confirm.focus();
    dialog.addEventListener("keydown", handle);
    expect(press(confirm, false, { key: "Enter" }).defaultPrevented).toBe(
      false,
    );
    expect(press(confirm, false, { ctrlKey: true }).defaultPrevented).toBe(
      false,
    );

    // A popover portaled to <body> still bubbles through React's tree.
    const popover = document.createElement("input");
    document.body.append(popover);
    expect(
      trapTab(
        new KeyboardEvent("keydown", { key: "Tab", cancelable: true }),
        dialog,
      ),
    ).toBe(false);
    const fromPopover = new KeyboardEvent("keydown", {
      key: "Tab",
      cancelable: true,
      bubbles: true,
    });
    popover.dispatchEvent(fromPopover);
    expect(trapTab(fromPopover, dialog)).toBe(false);
  });
});

describe("inertBackground", () => {
  it("makes the app root inert and releases it", () => {
    const release = inertBackground(document, dialog);
    expect(app.hasAttribute("inert")).toBe(true);
    release();
    expect(app.hasAttribute("inert")).toBe(false);
  });

  it("keeps the root inert until the last of two modals closes", () => {
    const second = document.createElement("div");
    document.body.append(second);
    const releaseFirst = inertBackground(document, dialog);
    const releaseSecond = inertBackground(document, second);
    releaseSecond();
    expect(app.hasAttribute("inert")).toBe(true);
    releaseFirst();
    expect(app.hasAttribute("inert")).toBe(false);
  });

  it("releasing twice does not release another modal's hold", () => {
    const second = document.createElement("div");
    document.body.append(second);
    const releaseFirst = inertBackground(document, dialog);
    const releaseSecond = inertBackground(document, second);
    releaseSecond();
    releaseSecond();
    expect(app.hasAttribute("inert")).toBe(true);
    releaseFirst();
    expect(app.hasAttribute("inert")).toBe(false);
  });

  it("leaves a root that was already inert as it found it", () => {
    app.setAttribute("inert", "");
    inertBackground(document, dialog)();
    expect(app.hasAttribute("inert")).toBe(true);
  });

  it("does nothing when the panel lives inside the root", () => {
    const inside = document.createElement("div");
    app.append(inside);
    inertBackground(document, inside)();
    const release = inertBackground(document, inside);
    expect(app.hasAttribute("inert")).toBe(false);
    release();
  });
});

describe("restoreFocus", () => {
  it("focuses the opener when nothing else holds focus", () => {
    const trigger = document.getElementById("trigger")!;
    restoreFocus(document, trigger);
    expect(document.activeElement).toBe(trigger);
  });

  it("does not steal focus the app moved on purpose", () => {
    const trigger = document.getElementById("trigger")!;
    const other = document.getElementById("name")!;
    other.focus();
    restoreFocus(document, trigger);
    expect(document.activeElement).toBe(other);
  });

  it("skips an opener that left the page or is not focusable", () => {
    const gone = document.createElement("button");
    expect(() => restoreFocus(document, gone)).not.toThrow();
    expect(() => restoreFocus(document, null)).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });
});
