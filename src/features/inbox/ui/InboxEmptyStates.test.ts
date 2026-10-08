// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { InboxView } from "./InboxView";
import { saveInboxConnections, saveInboxSource } from "../model/inboxFilters";

const { listInboxItems } = vi.hoisted(() => ({ listInboxItems: vi.fn() }));
vi.mock("../model/githubTasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model/githubTasks")>()),
  listInboxItems,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("No native bridge")),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.mocked(invoke).mockRejectedValue(new Error("No native bridge"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  listInboxItems.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function connect(github: boolean) {
  saveInboxConnections({
    github,
    gitlab: false,
    linear: false,
    jira: false,
    azuredevops: false,
  });
  saveInboxSource("github");
}

async function mount(onOpenIntegrations = vi.fn()) {
  await act(async () =>
    root.render(
      createElement(InboxView, {
        cwd: "/tmp/app",
        recents: [],
        onAsk: async () => "",
        onAskRestart: async () => "",
        onAskMount: () => {},
        onOpenIntegrations,
      }),
    ),
  );
  return onOpenIntegrations;
}

const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );

it("offers a way to connect an account when no source is connected", async () => {
  connect(false);
  listInboxItems.mockResolvedValue({ items: [], errors: {} });
  const onOpenIntegrations = await mount();
  expect(container.textContent).toContain(
    "Add a connection to start using the Inbox.",
  );
  await act(async () => button("Connect an account")!.click());
  expect(onOpenIntegrations).toHaveBeenCalledWith("github");
});

it("shows a source error as an alert with a Try again button", async () => {
  connect(true);
  listInboxItems.mockResolvedValue({
    items: [],
    errors: { github: "GitHub rate limit reached" },
  });
  await mount();
  const alert = container.querySelector('[role="alert"]')!;
  expect(alert.textContent).toBe("GitHub rate limit reached");
  expect(alert.className).toContain("text-danger");
  const calls = listInboxItems.mock.calls.length;
  await act(async () => button("Try again")!.click());
  expect(listInboxItems.mock.calls.length).toBeGreaterThan(calls);
});

it("labels the loading spinner", async () => {
  connect(true);
  listInboxItems.mockReturnValue(new Promise(() => {}));
  await mount();
  const status = container.querySelector('[role="status"]')!;
  expect(status.getAttribute("aria-label")).toBe("Loading inbox");
});

it("lets the user clear a search that matches nothing", async () => {
  connect(true);
  listInboxItems.mockResolvedValue({ items: [], errors: {} });
  await mount();
  expect(button("Clear filters")).toBeUndefined();
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Filter inbox"]',
  )!;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setValue.call(input, "nothing like this");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("No matching");
  await act(async () => button("Clear filters")!.click());
  expect(input.value).toBe("");
  expect(button("Clear filters")).toBeUndefined();
});
