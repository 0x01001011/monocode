// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveFlow, type FlowPhase } from "../model/flow";
import { FlowStrip } from "./FlowStrip";

let container: HTMLDivElement;
let root: Root;

const FLOW: FlowPhase[] = [
  { id: "spec", label: "Spec", status: "done", path: "docs/specs/alpha.md" },
  { id: "plan", label: "Plan", status: "done", detail: "6 tasks", path: "docs/plans/alpha.md" },
  { id: "build", label: "Build", status: "running", detail: "3 of 6, 2 subagents working" },
  { id: "check", label: "Check", status: "pending" },
];

function render(props: Partial<ComponentProps<typeof FlowStrip>> = {}) {
  act(() => root.render(createElement(FlowStrip, { phases: FLOW, ...props })));
}

const items = () => Array.from(container.querySelectorAll("ol > li"));
const labelOf = (li: Element) => (li.querySelector("button, span")?.firstChild?.textContent ?? "").trim();
const buttons = () => Array.from(container.querySelectorAll("button"));
const current = () => items().filter((li) => li.getAttribute("aria-current") === "step").map(labelOf);

/** The name a screen reader reads for an item: text and glyph labels in document order. */
function nameOf(li: Element): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node instanceof HTMLElement && node.getAttribute("aria-hidden") === "true") return;
    if (node instanceof HTMLElement && node.getAttribute("role") === "img") {
      parts.push(node.getAttribute("aria-label") ?? "");
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? "").trim();
      if (t) parts.push(t);
      return;
    }
    node.childNodes.forEach(walk);
  };
  walk(li);
  return parts.join(", ");
}

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

describe("FlowStrip", () => {
  it("is a list labelled Superpowers flow with the phases in order", () => {
    render();
    const list = container.querySelector("ol");
    expect(list?.getAttribute("aria-label")).toBe("Superpowers flow");
    expect(items().map(labelOf)).toEqual(["Spec", "Plan", "Build", "Check"]);
  });

  it("renders nothing for an empty list", () => {
    render({ phases: [] });
    expect(container.innerHTML).toBe("");
  });

  it("marks the first running phase as the current step", () => {
    render();
    expect(current()).toEqual(["Build"]);
  });

  it("prefers attention, failed and blocked over a later running phase", () => {
    for (const status of ["attention", "failed", "blocked"] as const) {
      render({
        phases: [
          { id: "spec", label: "Spec", status: "done" },
          { id: "build", label: "Build", status, detail: "2 of 6" },
          { id: "check", label: "Check", status: "running" },
        ],
      });
      expect(current()).toEqual(["Build"]);
    }
  });

  it("falls back to the first pending phase, and to none when everything is done", () => {
    render({
      phases: [
        { id: "plan", label: "Plan", status: "done" },
        { id: "build", label: "Build", status: "pending" },
        { id: "check", label: "Check", status: "pending" },
      ],
    });
    expect(current()).toEqual(["Build"]);
    render({
      phases: [
        { id: "plan", label: "Plan", status: "done" },
        { id: "check", label: "Check", status: "done" },
      ],
    });
    expect(current()).toEqual([]);
  });

  it("makes the current phase semibold and no other", () => {
    render();
    const bold = items().filter((li) => li.querySelector(".font-semibold")).map(labelOf);
    expect(bold).toEqual(["Build"]);
  });

  it("has buttons only for phases with a path, and they pass the path to onOpenPath", () => {
    const onOpenPath = vi.fn();
    render({ onOpenPath });
    expect(buttons().map((b) => (b.textContent ?? "").trim())).toEqual(["Spec", "Plan"]);
    act(() => buttons()[0].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => buttons()[1].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onOpenPath.mock.calls).toEqual([["docs/specs/alpha.md"], ["docs/plans/alpha.md"]]);
  });

  it("shows plain text instead of buttons without a callback", () => {
    render();
    expect(buttons()).toHaveLength(0);
    expect(items().map(labelOf)).toEqual(["Spec", "Plan", "Build", "Check"]);
  });

  it("uses a focus ring, a 24 px target and the focus color for its buttons", () => {
    render({ onOpenPath: () => {} });
    for (const b of buttons()) {
      expect(b.className).toContain("min-h-6");
      expect(b.className).toContain("focus-visible:focus-ring-inset");
      expect(b.className).toContain("text-focus");
      expect(b.className).not.toContain("text-accent");
    }
  });

  it("hides the separators from assistive technology and omits the last one", () => {
    render();
    const seps = Array.from(container.querySelectorAll("li [aria-hidden=true]")).filter((s) => s.textContent === "›");
    expect(seps).toHaveLength(3);
    expect(items().at(-1)?.textContent).not.toContain("›");
  });

  it("names each item as label, status words, detail without repeating anything", () => {
    render({ onOpenPath: () => {} });
    expect(items().map(nameOf)).toEqual([
      "Spec, done",
      "Plan, done, 6 tasks",
      "Build, running, 3 of 6, 2 subagents working",
      "Check, not started",
    ]);
  });

  it("reads a build that needs a look as struggling, like the task tree", () => {
    render({ phases: [{ id: "build", label: "Build", status: "attention", detail: "4 of 6" }] });
    expect(nameOf(items()[0])).toBe("Build, struggling, 4 of 6");
    expect(container.querySelector("[role=img]")?.textContent).toBe("!");
  });

  it("reads a check with review findings as the issues glyph", () => {
    render({ phases: [{ id: "check", label: "Check", status: "attention", detail: "final review found issues" }] });
    expect(nameOf(items()[0])).toBe("Check, review found issues, final review found issues");
  });

  it("keeps the board vocabulary for the other phases and statuses", () => {
    const names = (build: FlowPhase["status"]) => {
      render({ phases: [{ id: "build", label: "Build", status: build }] });
      return nameOf(items()[0]);
    };
    expect(names("running")).toBe("Build, running");
    expect(names("blocked")).toBe("Build, blocked");
    expect(names("failed")).toBe("Build, failed");
    expect(names("done")).toBe("Build, done");
  });

  it("gives Ship its own words instead of the review vocabulary", () => {
    const ship = (status: FlowPhase["status"], detail: string) => {
      render({ phases: [{ id: "ship", label: "Ship", status, detail }] });
      return nameOf(items()[0]);
    };
    expect(ship("attention", "3 left")).toBe("Ship, not ready, 3 left");
    expect(ship("failed", "2 left")).toBe("Ship, tests failed, 2 left");
    expect(ship("pending", "4 left")).toBe("Ship, not started, 4 left");
    // "ready" is both the glyph's word and the detail: it is said once.
    expect(ship("done", "ready")).toBe("Ship, ready");
    expect(items()[0]?.textContent).toContain("ready");
  });

  it("shows Ship after Check with its detail", () => {
    render({ phases: [...FLOW, { id: "ship", label: "Ship", status: "attention", detail: "3 left" }] });
    expect(items().map(labelOf)).toEqual(["Spec", "Plan", "Build", "Check", "Ship"]);
    expect(items().at(-1)?.textContent).toContain("3 left");
  });

  it("is a list for assistive technology even where list-style none drops the semantics", () => {
    render();
    expect(container.querySelector("ol")?.getAttribute("role")).toBe("list");
  });

  it("has no current step for a finished plan with a done final review and no test run found", () => {
    const nodes = [1, 2].map((n) => ({ id: `task-${n}`, title: `Task ${n}`, index: n, status: "done" as const }));
    const phases = deriveFlow({
      plan: {
        source: "sdd",
        id: "sdd:p",
        title: "P",
        done: 2,
        total: 2,
        nodes,
        planPath: "docs/p.md",
        specPath: "docs/s.md",
        finalReview: { id: "final-review", title: "Last review", status: "done" },
      },
      subagentsRunning: 0,
      now: 0,
    });
    expect(phases.map((p) => p.status)).toEqual(["done", "done", "done", "done"]);
    render({ phases });
    expect(current()).toEqual([]);
  });

  it("wraps instead of overflowing", () => {
    render();
    expect(container.querySelector("ol")?.className).toContain("flex-wrap");
  });

  it("updates in place when a status changes", () => {
    render();
    expect(nameOf(items()[2])).toContain("running");
    render({
      phases: FLOW.map((p) => (p.id === "build" ? { ...p, status: "done" as const, detail: "6 of 6" } : p)),
    });
    expect(nameOf(items()[2])).toBe("Build, done, 6 of 6");
    expect(current()).toEqual(["Check"]);
  });
});
