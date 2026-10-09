// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { RUNTIME_MODES } from "../../sessions/model/session";
import { MonoDetails } from "./MonoDetails";

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<object>()),
  invoke: vi.fn(),
}));
vi.mock("../../sessions/ui/ModelPicker", () => ({
  ModelPicker: () => null,
  ModelSettingRows: () => null,
}));
vi.mock("../model/monoFiles", async (original) => ({
  ...(await original<object>()),
  loadMonoFiles: async () => ({
    id: "mono-1",
    dir: "/data/mono-1",
    soul: "",
    soulHash: "s",
    memory: "",
    memoryHash: "m",
    memoryPath: "/data/mono-1/MEMORY.md",
    topics: [],
  }),
}));
vi.mock("../model/monoHabits", async (original) => ({
  ...(await original<object>()),
  loadHabits: async () => [],
}));

const stored = [
  { id: "mine-1", kind: "html", title: "My dashboard", sourceSessionId: "mono-session", createdAt: 1, updatedAt: 30 },
  { id: "other", kind: "document", title: "Another bot's report", sourceSessionId: "other-session", createdAt: 1, updatedAt: 20 },
  { id: "mine-2", kind: "document", title: "My report", sourceSessionId: "mono-session", createdAt: 1, updatedAt: 10 },
];

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const kv = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => kv.get(k) ?? null,
    setItem: (k: string, v: string) => kv.set(k, v),
    removeItem: (k: string) => kv.delete(k),
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "artifacts_summaries" ? stored : undefined,
  );
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

async function render(extra: Record<string, unknown> = {}) {
  const onOpenArtifact = vi.fn();
  await act(async () =>
    root.render(
      createElement(MonoDetails, {
        open: true,
        monoId: "mono-1",
        cwd: "/home",
        agent: { name: "Broski", mascot: "cat", color: "#9c9", projects: [] },
        state: { status: "idle" },
        harness: "codex",
        model: "codex:gpt-5.4",
        modelSettings: {},
        runtimeMode: RUNTIME_MODES[0],
        onModelChange: vi.fn(),
        onModelSettingsChange: vi.fn(),
        onRuntimeModeChange: vi.fn(),
        onClose: vi.fn(),
        sessionId: "mono-session",
        onOpenArtifact,
        ...extra,
      }),
    ),
  );
  await act(async () => {});
  return { onOpenArtifact };
}
const row = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.startsWith(label));

it("adds an Artifacts row that counts only this bot's artifacts", async () => {
  await render();
  const artifacts = row("Artifacts")!;
  expect(artifacts).toBeDefined();
  expect(artifacts.textContent).toContain("2");
});

it("opens the list and then the chosen artifact", async () => {
  const { onOpenArtifact } = await render();
  act(() => row("Artifacts")!.click());
  const rows = [...container.querySelectorAll<HTMLButtonElement>("[data-artifact-row]")];
  expect(rows.map((r) => r.getAttribute("data-artifact-row"))).toEqual(["mine-1", "mine-2"]);
  act(() => rows[0].click());
  expect(onOpenArtifact).toHaveBeenCalledWith("mine-1");
});

it("shows no Artifacts row when the app cannot open one", async () => {
  await render({ onOpenArtifact: undefined });
  expect(row("Artifacts")).toBeUndefined();
});
