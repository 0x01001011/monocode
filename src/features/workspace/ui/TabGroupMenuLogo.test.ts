// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const pickAndSetProjectLogo = vi.hoisted(() => vi.fn());

vi.mock("../../projects/model/projectLogos", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../projects/model/projectLogos")
  >()),
  pickAndSetProjectLogo,
}));

import { TabGroupMenu } from "./TabGroupMenu";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  pickAndSetProjectLogo.mockReset();
});

function renderMenu() {
  const onClose = vi.fn();
  const onLogoChange = vi.fn();
  act(() =>
    root.render(
      createElement(TabGroupMenu, {
        x: 20,
        y: 20,
        groupId: "g",
        label: "Group",
        colorIndex: null,
        customColor: null,
        currentColor: "#7c3aed",
        logoPath: null,
        logoProject: "/repo",
        mascotName: null,
        mascotProject: "/repo",
        onRename: vi.fn(),
        onColorChange: vi.fn(),
        onCustomColorChange: vi.fn(),
        onMascotChange: vi.fn(),
        onLogoChange,
        onPick: vi.fn(),
        onClose,
      }),
    ),
  );
  return { onClose, onLogoChange };
}

const addLogo = () =>
  document.querySelector<HTMLButtonElement>(
    'button[aria-label="Add project logo"]',
  )!;

it("keeps the menu open and says so when the logo cannot be saved", async () => {
  pickAndSetProjectLogo.mockRejectedValue(new Error("disk full"));
  const { onClose, onLogoChange } = renderMenu();

  await act(async () => addLogo().click());

  const alert = document.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("Couldn't save the logo.");
  expect(alert.textContent).toContain("disk full");
  expect(alert.classList).toContain("text-danger");
  expect(onClose).not.toHaveBeenCalled();
  expect(onLogoChange).not.toHaveBeenCalled();
});

it("closes the menu after a logo is saved or the picker is cancelled", async () => {
  pickAndSetProjectLogo.mockResolvedValueOnce("/logo.png");
  const first = renderMenu();
  await act(async () => addLogo().click());
  expect(first.onLogoChange).toHaveBeenCalledTimes(1);
  expect(first.onClose).toHaveBeenCalledTimes(1);

  pickAndSetProjectLogo.mockResolvedValueOnce(null);
  const second = renderMenu();
  await act(async () => addLogo().click());
  expect(second.onLogoChange).not.toHaveBeenCalled();
  expect(second.onClose).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
