import { describe, expect, it } from "vitest";
import { parseFrameMessage } from "./frameChannel";

const name = "mc:7f1c";
const msg = (extra: Record<string, unknown>) => ({ mcp: 1, n: name, ...extra });

describe("parseFrameMessage", () => {
  it("accepts the known message types from this frame", () => {
    expect(parseFrameMessage(msg({ type: "ready" }), name)).toEqual({ type: "ready" });
    expect(parseFrameMessage(msg({ type: "escape" }), name)).toEqual({ type: "escape" });
  });

  it.each([
    ["a different frame's nonce", { mcp: 1, n: "mc:other", type: "escape" }],
    ["no nonce", { mcp: 1, type: "escape" }],
    ["no protocol marker", { n: name, type: "escape" }],
    ["a wrong protocol marker", { mcp: 2, n: name, type: "escape" }],
    ["an unknown type", msg({ type: "eval" })],
    ["a non-string type", msg({ type: 5 })],
    ["an inherited type", Object.create(msg({ type: "escape" }))],
  ])("rejects %s", (_label, data) => {
    expect(parseFrameMessage(data, name)).toBeNull();
  });

  it.each([null, undefined, "escape", 42, [], true])(
    "rejects non-object data: %j",
    (data) => {
      expect(parseFrameMessage(data, name)).toBeNull();
    },
  );

  it("never returns the page's own object, only a fresh allowlisted one", () => {
    const data = msg({ type: "escape", extra: "<script>", __proto__: { polluted: 1 } });
    const parsed = parseFrameMessage(data, name);
    expect(parsed).toEqual({ type: "escape" });
    expect(parsed).not.toBe(data);
  });
});
