// @vitest-environment happy-dom
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrStackView } from "../model/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

const VIEW: PrStackView = {
  group: { repo: "acme/app", baseRef: "main", members: [7], mergedCount: 0 },
  entries: [],
};

async function loadModule() {
  vi.resetModules();
  return import("./prStack");
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("getPrStack", () => {
  it("passes a well-formed view through, single-member groups included", async () => {
    vi.mocked(invoke).mockResolvedValue(VIEW);
    const m = await loadModule();
    expect(await m.getPrStack("acme/app", 7)).toEqual(VIEW);
    expect(invoke).toHaveBeenCalledWith("pr_stack_for", {
      repo: "acme/app",
      number: 7,
    });
  });

  it("answers null for a PR with no snapshot without warning", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const m = await loadModule();
    expect(await m.getPrStack("acme/app", 7)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    [[]],
    ["x"],
    [{}],
    [{ entries: [], group: {} }],
    [{ entries: {}, group: { members: [] } }],
  ])("treats a malformed payload %j as a failed lookup", async (payload) => {
    vi.mocked(invoke).mockResolvedValue(payload);
    const m = await loadModule();
    expect(await m.getPrStack("acme/app", 7)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("skips the backend for an empty repo or a bad number", async () => {
    const m = await loadModule();
    expect(await m.getPrStack(" ", 7)).toBeNull();
    expect(await m.getPrStack("acme/app", 0)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});
