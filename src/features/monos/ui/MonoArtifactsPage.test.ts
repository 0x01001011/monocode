// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Artifact } from "../../artifacts/artifacts";
import { MonoArtifactsPage } from "./MonoArtifactsPage";

const artifact = (id: string, title: string, kind: Artifact["kind"], updatedAt: number): Artifact => ({
  id,
  kind,
  title,
  body: "x",
  createdAt: 1,
  updatedAt,
});
const items = [
  artifact("a1", "Quarterly dashboard", "html", Date.UTC(2026, 9, 8)),
  artifact("a2", "PR review notes", "document", Date.UTC(2026, 9, 7)),
  artifact("a3", "Sales chart", "html", Date.UTC(2026, 9, 6)),
];

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (artifacts: Artifact[] | undefined, onOpen = vi.fn(), onBack = vi.fn()) => {
  act(() => root.render(createElement(MonoArtifactsPage, { artifacts, onOpen, onBack })));
  return { onOpen, onBack };
};
const rows = () => [...container.querySelectorAll<HTMLButtonElement>("[data-artifact-row]")];
const type = (value: string) => {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

it("lists artifacts in the given order with their kind", () => {
  render(items);
  expect(rows().map((row) => row.getAttribute("data-artifact-row"))).toEqual(["a1", "a2", "a3"]);
  expect(rows()[0].textContent).toContain("Quarterly dashboard");
  expect(rows()[0].textContent).toContain("Web page");
  expect(rows()[1].textContent).toContain("Document");
});

it("opens the artifact that was clicked", () => {
  const { onOpen } = render(items);
  act(() => rows()[1].click());
  expect(onOpen).toHaveBeenCalledWith("a2");
});

it("filters by title or kind as the person types", () => {
  render(items);
  type("chart");
  expect(rows().map((row) => row.getAttribute("data-artifact-row"))).toEqual(["a3"]);
  type("web page");
  expect(rows().map((row) => row.getAttribute("data-artifact-row"))).toEqual(["a1", "a3"]);
  type("nothing like this");
  expect(rows()).toHaveLength(0);
  expect(container.textContent).toContain("No artifacts match");
});

it("explains the empty state and the loading state", () => {
  render([]);
  expect(container.textContent).toContain("No artifacts yet");
  render(undefined);
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading");
});

it("goes back", () => {
  const { onBack } = render(items);
  act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!.click());
  expect(onBack).toHaveBeenCalled();
});
