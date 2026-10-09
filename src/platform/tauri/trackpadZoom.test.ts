import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { claimTrackpadMagnify } from "./trackpadZoom";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

afterEach(() => vi.clearAllMocks());

it("does not leave a rejection unhandled when there is no event bridge", async () => {
  // Outside the app (tests, browser previews) listen() rejects.
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.mocked(listen).mockRejectedValue(new TypeError("no tauri internals"));
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    const release = claimTrackpadMagnify(() => {});
    release();
    // Rejections are reported once the microtask queue and a tick have drained.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", record);
  }
  expect(unhandled).toEqual([]);
});

it("stops listening when the last claim is released", async () => {
  const stop = vi.fn();
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.mocked(listen).mockResolvedValue(stop);
  const releaseA = claimTrackpadMagnify(() => {});
  const releaseB = claimTrackpadMagnify(() => {});
  expect(listen).toHaveBeenCalledTimes(1);
  releaseA();
  await Promise.resolve();
  expect(stop).not.toHaveBeenCalled();
  releaseB();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(stop).toHaveBeenCalledTimes(1);
});
