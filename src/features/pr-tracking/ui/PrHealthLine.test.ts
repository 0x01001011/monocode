// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attention, PrEntryLite } from "../model/types";
import { PrHealthLine } from "./PrHealthLine";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function entry(
  attention: Attention,
  attentionReason: string | null,
): PrEntryLite {
  return {
    number: 482,
    title: "Tip",
    url: "https://github.com/acme/app/pull/482",
    state: "open",
    isDraft: false,
    headRef: "mc/c",
    baseRef: "mc/b",
    checks: "passing",
    attention,
    attentionReason,
    ownerSessionIds: [],
    isNeighbor: false,
  };
}

let container: HTMLDivElement;
let root: Root;
const onDraftRestack = vi.fn();

beforeEach(() => {
  onDraftRestack.mockReset();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

function render(
  e: PrEntryLite,
  sessionTitle: string | null = "Tasks panel audit",
) {
  act(() =>
    root.render(
      createElement(PrHealthLine, { entry: e, sessionTitle, onDraftRestack }),
    ),
  );
}

const button = () => container.querySelector("button");

describe("PrHealthLine", () => {
  it("renders nothing when the PR needs no attention", () => {
    render(entry("none", null));
    expect(container.innerHTML).toBe("");
  });

  it("states the most urgent reason with its attention mark, without an action for blockers", () => {
    render(entry("block", "Checks failing"));
    const line = container.querySelector("[role='note']")!;
    expect(line.textContent).toBe("Checks failing");
    expect(line.querySelector(".pr-att")?.getAttribute("data-kind")).toBe(
      "block",
    );
    expect(button()).toBeNull();
  });

  it("offers the restack draft with typographic quotes around the chat name", () => {
    render(entry("action", "Needs restack"));
    expect(container.querySelector(".pr-att")?.getAttribute("data-kind")).toBe(
      "action",
    );
    expect(button()!.textContent).toBe(
      "Draft restack prompt in “Tasks panel audit”",
    );
    expect(container.textContent).not.toMatch(/[—"]/);
    act(() => button()!.click());
    expect(onDraftRestack).toHaveBeenCalledTimes(1);
  });

  it("offers it for a PR behind its base too, but only when a chat exists", () => {
    render(entry("action", "Behind main by 3"));
    expect(container.textContent).toContain("Behind main by 3");
    expect(button()).not.toBeNull();
    render(entry("action", "Behind main by 3"), null);
    expect(button()).toBeNull();
    expect(container.textContent).toBe("Behind main by 3");
  });

  it("shows running checks without a mark or an action", () => {
    render(entry("pending", "Checks running"));
    expect(container.textContent).toBe("Checks running");
    expect(container.querySelector(".pr-att")).toBeNull();
    expect(button()).toBeNull();
  });
});
