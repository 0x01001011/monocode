// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphFilter } from "./GraphFilter";

let container: HTMLDivElement;
let root: Root;

function render(props: Partial<ComponentProps<typeof GraphFilter>> = {}) {
  const onChange = props.onChange ?? vi.fn();
  act(() =>
    root.render(createElement(GraphFilter, { value: "all", counts: { all: 9, left: 4, problems: 1 }, onChange, ...props })),
  );
  return onChange;
}

const radios = () => Array.from(container.querySelectorAll<HTMLElement>("[role=radio]"));
const key = (el: Element, k: string) =>
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("GraphFilter", () => {
  it("is a radiogroup with All, Left and Problems and their counts", () => {
    render();
    expect(container.querySelector("[role=radiogroup]")?.getAttribute("aria-label")).toBe("Show");
    expect(radios().map((r) => r.textContent)).toEqual(["All 9", "Left 4", "Problems 1"]);
    expect(radios().map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  });

  it("has one tab stop, on the chosen option", () => {
    render({ value: "left" });
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("a click chooses that option", () => {
    const onChange = render();
    act(() => radios()[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith("problems");
  });

  it("arrow keys move and choose, wrapping at both ends", () => {
    const onChange = render({ value: "all" });
    radios()[0]!.focus();
    key(radios()[0]!, "ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith("left");
    expect(document.activeElement).toBe(radios()[1]);
    key(radios()[1]!, "ArrowLeft");
    expect(onChange).toHaveBeenLastCalledWith("all");
    key(radios()[0]!, "ArrowLeft");
    expect(onChange).toHaveBeenLastCalledWith("problems");
    key(radios()[2]!, "ArrowDown");
    expect(onChange).toHaveBeenLastCalledWith("all");
  });

  it("uses 24 px targets with the inset focus ring", () => {
    render();
    for (const r of radios()) {
      expect(r.className).toContain("min-h-6");
      expect(r.className).toContain("focus-visible:focus-ring-inset");
      expect(r.className).not.toContain("outline-none");
    }
  });
});
