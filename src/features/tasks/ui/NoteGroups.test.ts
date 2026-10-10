// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Gap } from "../model/gaps";
import { NoteGroups } from "./NoteGroups";

let container: HTMLDivElement;
let root: Root;

const GAPS: Gap[] = [{ kind: "no-commit", nodeId: "task-2", label: "Task 2", text: "no commit recorded" }];
const LONG = "Keep password login as a fallback for the hosts that still lack keys, until the migration is done";

function render(props: Partial<ComponentProps<typeof NoteGroups>> = {}) {
  const all = {
    deferred: [
      { taskIndex: 2, text: "Rename helper" },
      { taskIndex: 3, text: "Cache later", parked: true },
    ],
    gaps: GAPS,
    decisions: [{ taskIndex: 1, text: LONG }],
    open: { deferred: true, gaps: true, decisions: true },
    onToggle: vi.fn(),
    onReveal: vi.fn(),
    onChangeDecision: vi.fn(),
    ...props,
  };
  act(() => root.render(createElement(NoteGroups, all)));
  return all;
}

const text = () => container.textContent ?? "";
const heading = (name: string) => container.querySelector<HTMLButtonElement>(`[data-notes="${name}"]`);
const click = (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  act(() => el?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};

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

describe("NoteGroups", () => {
  it("renders three groups with their counts, each heading a disclosure button", () => {
    render();
    expect(heading("deferred")?.textContent).toBe("Deferred · 2");
    expect(heading("gaps")?.textContent).toBe("Gaps · 1");
    expect(heading("decisions")?.textContent).toBe("Decisions made for you · 1");
    for (const name of ["deferred", "gaps", "decisions"]) {
      expect(heading(name)?.tagName).toBe("BUTTON");
      expect(heading(name)?.getAttribute("aria-expanded")).toBe("true");
    }
  });

  it("leaves out an empty group", () => {
    render({ gaps: [], decisions: [] });
    expect(heading("gaps")).toBeNull();
    expect(heading("decisions")).toBeNull();
    expect(heading("deferred")).not.toBeNull();
  });

  it("a collapsed group hides its items and a press asks to toggle that group", () => {
    const props = render({ open: { deferred: false, gaps: false, decisions: false } });
    expect(heading("deferred")?.getAttribute("aria-expanded")).toBe("false");
    expect(text()).not.toContain("Rename helper");
    click(heading("gaps"));
    expect(props.onToggle).toHaveBeenCalledWith("gaps");
  });

  it("Deferred lists parked and small issues with their task, parked ones tagged", () => {
    render();
    const items = Array.from(container.querySelectorAll("[data-group=deferred] li")).map((li) => li.textContent);
    expect(items).toEqual(["Rename helperTask 2", "Cache laterparkedTask 3"]);
  });

  it("each gap is a button that reveals its row", () => {
    const props = render();
    const gap = container.querySelector("[data-group=gaps] li button");
    expect(gap?.textContent).toBe("Task 2: no commit recorded");
    click(gap);
    expect(props.onReveal).toHaveBeenCalledWith("task-2");
  });

  it("Decisions explain themselves and Change this hands the note over", () => {
    const props = render();
    expect(text()).toContain("Calls the agent made without stopping to ask. Change any of them by telling the agent.");
    const change = container.querySelector("[data-group=decisions] li button");
    expect(change?.textContent).toBe("Change this");
    expect(change?.getAttribute("aria-label")).toBe(`Change this: ${LONG.slice(0, 60).trimEnd()}…`);
    click(change);
    expect(props.onChangeDecision).toHaveBeenCalledWith({ taskIndex: 1, text: LONG });
  });

  it("offers no Change this without a handler", () => {
    render({ onChangeDecision: undefined });
    expect(container.querySelector("[data-group=decisions] li button")).toBeNull();
  });

  it("uses 24 px targets with the inset focus ring", () => {
    render();
    for (const b of Array.from(container.querySelectorAll("button"))) {
      expect(b.className).toMatch(/min-h-6/);
      expect(b.className).toContain("focus-visible:focus-ring-inset");
    }
  });
});
