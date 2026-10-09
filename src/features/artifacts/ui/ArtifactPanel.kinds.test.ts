// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Artifact } from "../artifacts";
import { ArtifactPanel } from "./ArtifactPanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../sessions/ui/AgentMarkdown", () => ({
  AgentMarkdown: ({ text }: { text: string }) => createElement("div", null, text),
}));
vi.mock("../../html-preview/ui/HtmlPreview", () => ({
  HtmlPreview: () => createElement("div", { "data-fake-preview": "" }),
}));
vi.mock("../../../platform/tauri/clipboard", () => ({
  copyMessage: vi.fn().mockResolvedValue(undefined),
}));

const page: Artifact = {
  id: "page-1",
  kind: "html",
  title: "Dashboard",
  body: "<p>x</p>",
  createdAt: 1,
  updatedAt: 2,
};
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
  vi.clearAllMocks();
});

const render = () =>
  act(async () =>
    root.render(createElement(ArtifactPanel, { id: page.id, color: "#aaa", onClose: vi.fn() })),
  );

it("calls an html artifact a web page, not a document", async () => {
  vi.mocked(invoke).mockResolvedValue(page);
  await render();
  expect(container.querySelector('[aria-label="Copy web page"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Delete web page"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Copy document"]')).toBeNull();
});

it("does not call something a document before it knows what it is", async () => {
  let resolve!: (value: Artifact) => void;
  vi.mocked(invoke).mockReturnValue(new Promise((r) => (resolve = r as typeof resolve)));
  await render();
  expect(container.textContent).not.toMatch(/document/i);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading…");
  await act(async () => resolve(page));
});

it("says the artifact is gone without guessing its kind", async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  await render();
  expect(container.textContent).toContain("This artifact is no longer available.");
});
