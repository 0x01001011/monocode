// @vitest-environment happy-dom
// Frozen acceptance spec for HTML previews (autoresearch metric). Do not edit.
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { newSession } from "../sessions/model/session";
import type { Artifact } from "../artifacts/artifacts";
import { artifactLabel } from "../artifacts/artifacts";
import { ArtifactContent } from "../artifacts/ui/ArtifactContent";
import { filePreviewKind } from "../files/model/filePreview";
import { handleAgentApp, type AgentAppHost } from "../agent-app/model/agentApp";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) =>
    command === "preview_open" ? "tok9" : undefined,
  ),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../sessions/ui/AgentMarkdown", () => ({
  AgentMarkdown: ({ text }: { text: string }) => createElement("div", null, text),
}));

describe("html preview integration", () => {
  it("routes file kinds to their previews", () => {
    expect(filePreviewKind("/r/README.md")).toBe("markdown");
    expect(filePreviewKind("/r/logo.svg")).toBe("svg");
    expect(filePreviewKind("/r/site/Index.HTML")).toBe("html");
    expect(filePreviewKind("/r/page.htm")).toBe("html");
    expect(filePreviewKind("/r/main.ts")).toBeNull();
  });

  it("labels and renders html artifacts in a sandboxed frame", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    expect(artifactLabel("html")).toBe("Web page");
    const artifact: Artifact = {
      id: "artifact-1",
      kind: "html",
      title: "Chart",
      body: "<p>chart</p>",
      createdAt: 1,
      updatedAt: 2,
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(ArtifactContent, { artifact })));
    await act(async () => {});
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toContain("/tok9/");
    expect(iframe?.getAttribute("sandbox")).toContain("allow-scripts");
    expect(container.textContent).not.toContain("<p>chart</p>");
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("lets agents write html artifacts with a title from the page", async () => {
    const source = newSession("codex", "/tmp/project", "codex:test");
    source.id = "lead";
    let saved: Artifact | null = null;
    const host = {
      isMono: () => true,
      artifact: vi.fn(async (id: string) => (saved?.id === id ? saved : null)),
      saveArtifact: vi.fn(async (input: Omit<Artifact, "createdAt" | "updatedAt">) => {
        saved = { ...input, createdAt: 1, updatedAt: 1 };
        return saved;
      }),
      postArtifact: vi.fn(async () => {}),
    } as unknown as AgentAppHost;
    const body = "<!doctype html><title>Q3 dashboard</title><script>1</script>";
    const result = await handleAgentApp(
      source,
      "page-1",
      "artifacts.write",
      { kind: "html", body },
      host,
    );
    expect(result).toMatchObject({ kind: "html", title: "Q3 dashboard", saved: true });
    expect(host.saveArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "html", body }),
    );
    await expect(
      handleAgentApp(source, "page-2", "artifacts.write", { kind: "pdf", body }, host),
    ).rejects.toThrow(/kind/i);
  });

  it("allows only the preview scheme as a frame source in the app CSP", () => {
    const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    const security = conf.app.security;
    for (const key of ["csp", "devCsp"]) {
      const frame = (security[key] as string)
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("frame-src"));
      expect(frame, key).toBeDefined();
      const sources = frame!.split(/\s+/).slice(1);
      expect(sources, key).toContain("preview:");
      expect(sources, key).toContain("http://preview.localhost");
      for (const source of sources)
        expect(["preview:", "http://preview.localhost", "https://preview.localhost"], key).toContain(source);
    }
  });
});
