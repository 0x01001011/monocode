import { describe, expect, it } from "vitest";
import { previewHeightCss } from "./previewHeight";

describe("previewHeightCss", () => {
  it("uses the standard reader height until the page has reported", () => {
    expect(previewHeightCss(undefined)).toBe("min(70vh, 720px)");
  });

  it("fits the page plus the toolbar, never above the reader's cap", () => {
    expect(previewHeightCss(300)).toBe("min(max(332px, 200px), min(70vh, 720px))");
  });

  it("keeps a very short page from collapsing to nothing", () => {
    expect(previewHeightCss(0)).toBe("min(max(32px, 200px), min(70vh, 720px))");
  });
});
