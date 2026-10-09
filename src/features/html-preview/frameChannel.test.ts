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

  describe("open", () => {
    it("accepts web and mail links and returns the normalized URL", () => {
      expect(
        parseFrameMessage(msg({ type: "open", url: "https://example.com/a b?x=1#top" }), name),
      ).toEqual({ type: "open", url: "https://example.com/a%20b?x=1#top" });
      expect(
        parseFrameMessage(msg({ type: "open", url: "http://example.com/" }), name),
      ).toEqual({ type: "open", url: "http://example.com/" });
      expect(
        parseFrameMessage(msg({ type: "open", url: "mailto:a@example.com" }), name),
      ).toEqual({ type: "open", url: "mailto:a@example.com" });
    });

    it.each([
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<p>x</p>",
      "ipc://localhost/cmd",
      "tauri://localhost/",
      "asset://localhost/x",
      "preview://localhost/tok/index.html",
      "/relative/path",
      "example.com",
      "https://",
      "",
      `https://example.com/${"a".repeat(3000)}`,
    ])("rejects %j", (url) => {
      expect(parseFrameMessage(msg({ type: "open", url }), name)).toBeNull();
    });

    it.each([undefined, null, 5, {}, ["https://example.com"]])(
      "rejects a non-string url: %j",
      (url) => {
        expect(parseFrameMessage(msg({ type: "open", url }), name)).toBeNull();
      },
    );
  });

  describe("console", () => {
    it("accepts a level and text, clamped to a sane size", () => {
      expect(
        parseFrameMessage(msg({ type: "console", level: "warn", text: "careful" }), name),
      ).toEqual({ type: "console", level: "warn", text: "careful" });
      const long = parseFrameMessage(
        msg({ type: "console", level: "error", text: "x".repeat(10_000) }),
        name,
      );
      expect(long?.type === "console" && long.text.length).toBe(2000);
    });

    it.each(["log", "info", "warn", "error", "debug"])("allows level %s", (level) => {
      expect(parseFrameMessage(msg({ type: "console", level, text: "t" }), name)).toEqual({
        type: "console",
        level,
        text: "t",
      });
    });

    it.each([
      ["an unknown level", { level: "fatal", text: "t" }],
      ["a missing level", { text: "t" }],
      ["a non-string text", { level: "log", text: { toString: "x" } }],
      ["a missing text", { level: "log" }],
    ])("rejects %s", (_label, extra) => {
      expect(parseFrameMessage(msg({ type: "console", ...extra }), name)).toBeNull();
    });
  });

  describe("scroll", () => {
    it("accepts whole-number offsets and clamps them to a sane range", () => {
      expect(parseFrameMessage(msg({ type: "scroll", x: 12, y: 480 }), name)).toEqual({
        type: "scroll",
        x: 12,
        y: 480,
      });
      expect(parseFrameMessage(msg({ type: "scroll", x: -5, y: 99_999_999 }), name)).toEqual({
        type: "scroll",
        x: 0,
        y: 10_000_000,
      });
      expect(parseFrameMessage(msg({ type: "scroll", x: 1.9, y: 2.4 }), name)).toEqual({
        type: "scroll",
        x: 1,
        y: 2,
      });
    });

    it.each([
      ["missing offsets", {}],
      ["string offsets", { x: "0", y: "10" }],
      ["NaN", { x: Number.NaN, y: 0 }],
      ["Infinity", { x: 0, y: Number.POSITIVE_INFINITY }],
      ["null", { x: null, y: null }],
    ])("rejects %s", (_label, extra) => {
      expect(parseFrameMessage(msg({ type: "scroll", ...extra }), name)).toBeNull();
    });
  });
});
