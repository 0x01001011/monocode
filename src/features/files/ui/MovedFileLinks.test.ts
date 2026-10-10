// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MovedFileLinks } from "./MovedFileLinks";
import { findInOtherCheckouts } from "../model/movedFile";

vi.mock("../model/movedFile", () => ({ findInOtherCheckouts: vi.fn() }));

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
  vi.resetAllMocks();
});

const show = async (onOpenFile?: () => void) => {
  await act(async () =>
    root.render(
      createElement(MovedFileLinks, {
        path: "remote://m1/home/k/wt/task-1-report.md",
        cwd: "remote://m1/home/k/wt",
        onOpenFile,
      }),
    ),
  );
  await act(async () => {});
};

it("offers each checkout that has the file and opens it as that exact path", async () => {
  vi.mocked(findInOtherCheckouts).mockResolvedValue([
    {
      path: "remote://m1/home/k/main/task-1-report.md",
      checkout: "remote://m1/home/k/main",
    },
  ]);
  const open = vi.fn();
  await show(open);
  const button = container.querySelector("button")!;
  // The machine prefix is hidden, and the home folder is abbreviated.
  expect(button.textContent).toBe("~/main/task-1-report.md");
  act(() => button.click());
  expect(open).toHaveBeenCalledWith(
    "remote://m1/home/k/main/task-1-report.md",
    undefined,
    { exact: true, cwd: "remote://m1/home/k/main" },
  );
});

it("shows nothing when the file is nowhere else", async () => {
  vi.mocked(findInOtherCheckouts).mockResolvedValue([]);
  await show(vi.fn());
  expect(container.textContent).toBe("");
});

it("shows nothing when it cannot open files", async () => {
  vi.mocked(findInOtherCheckouts).mockResolvedValue([
    { path: "/a/b.md", checkout: "/a" },
  ]);
  await show(undefined);
  expect(container.textContent).toBe("");
});
