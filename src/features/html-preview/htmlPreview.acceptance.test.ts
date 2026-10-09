// Frozen acceptance spec for HTML previews (autoresearch metric). Do not edit.
import { describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../integrations/harness/core/types";
import { REMOTE_PROJECT_PREFIX } from "../projects/model/recents";
import {
  createHtmlAutoOpener,
  htmlTitle,
  htmlWrittenPaths,
  isHtmlPath,
  previewUrl,
} from "./htmlPreview";

const edit = (
  fields: Partial<Extract<HarnessEvent, { type: "tool.updated" }>>,
): HarnessEvent => ({
  type: "tool.updated",
  callId: "c1",
  kind: "edit",
  status: "completed",
  ...fields,
});

describe("html preview model", () => {
  it("recognizes HTML files by extension only", () => {
    for (const path of ["/p/index.html", "/p/A.HTM", "C:\\site\\page.Html"])
      expect(isHtmlPath(path), path).toBe(true);
    for (const path of ["/p/notes.html.md", "/p/html", "/p/x.xhtml.bak", "/p/a.md"])
      expect(isHtmlPath(path), path).toBe(false);
  });

  it("builds per-platform scheme URLs and encodes each segment", () => {
    expect(previewUrl("abc", "", false)).toBe("preview://localhost/abc/");
    expect(previewUrl("abc", "docs/about page.html", false)).toBe(
      "preview://localhost/abc/docs/about%20page.html",
    );
    expect(previewUrl("abc", "a#b/c?.html", true)).toBe(
      "http://preview.localhost/abc/a%23b/c%3F.html",
    );
  });

  it("derives a title from <title> or the first heading", () => {
    expect(htmlTitle("<html><head><title> Sales  Q3 </title></head></html>")).toBe(
      "Sales Q3",
    );
    expect(htmlTitle("<body><h1 class=x>Launch <em>plan</em></h1></body>")).toBe(
      "Launch plan",
    );
    expect(htmlTitle("<p>no title</p>")).toBeUndefined();
  });

  it("reports HTML files that an agent finished writing", () => {
    const cwd = "/repo";
    expect(
      htmlWrittenPaths(
        edit({ paths: ["site/index.html", "/repo/site/app.css", "/abs/x.htm"] }),
        cwd,
      ),
    ).toEqual(["/repo/site/index.html", "/abs/x.htm"]);
    expect(
      htmlWrittenPaths(
        edit({ kind: "other", title: "Write", preview: { kind: "write", path: "out.html" } as never }),
        cwd,
      ),
    ).toEqual(["/repo/out.html"]);
    expect(htmlWrittenPaths(edit({ status: "running", paths: ["a.html"] }), cwd)).toEqual([]);
    expect(htmlWrittenPaths(edit({ kind: "delete", paths: ["a.html"] }), cwd)).toEqual([]);
    expect(htmlWrittenPaths(edit({ kind: "read", paths: ["a.html"] }), cwd)).toEqual([]);
    expect(
      htmlWrittenPaths({ type: "message.delta", text: "a.html" } as HarnessEvent, cwd),
    ).toEqual([]);
    expect(
      htmlWrittenPaths(edit({ paths: ["a.html"] }), `${REMOTE_PROJECT_PREFIX}host/repo`),
    ).toEqual([]);
  });

  it("auto-opens each written HTML file once per session", () => {
    const open = vi.fn();
    const autoOpen = createHtmlAutoOpener(open);
    autoOpen("s1", ["/r/a.html", "/r/b.html"]);
    autoOpen("s1", ["/r/a.html"]);
    autoOpen("s2", ["/r/a.html"]);
    autoOpen("s1", []);
    // One preview per batch: the first new file is shown, later writes reload it.
    expect(open.mock.calls).toEqual([["/r/a.html"], ["/r/a.html"]]);
    autoOpen("s1", ["/r/c.html"]);
    expect(open).toHaveBeenLastCalledWith("/r/c.html");
  });
});
