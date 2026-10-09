import { describe, expect, it, vi } from "vitest";
import { newSession } from "../sessions/model/session";
import type { Artifact } from "../artifacts/artifacts";
import { handleAgentApp, type AgentAppHost } from "../agent-app/model/agentApp";
import { clearPreviewLogs, markPreviewLoaded, recordPreviewLog } from "./previewLogs";

function fixture() {
  const source = newSession("codex", "/tmp/project", "codex:test");
  source.id = "lead";
  const store = new Map<string, Artifact>();
  const host = {
    isMono: () => true,
    artifact: vi.fn(async (id: string) => store.get(id) ?? null),
    saveArtifact: vi.fn(
      async (input: Omit<Artifact, "createdAt" | "updatedAt">) => {
        const saved = { ...input, createdAt: 1, updatedAt: 1 };
        store.set(saved.id, saved);
        return saved;
      },
    ),
    postArtifact: vi.fn(async () => {}),
  } as unknown as AgentAppHost;
  const call = (action: string, input: Record<string, unknown>) =>
    handleAgentApp(source, "req-1", action, input, host) as Promise<Record<string, unknown>>;
  const write = (requestId: string, input: Record<string, unknown>) =>
    handleAgentApp(source, requestId, "artifacts.write", input, host) as Promise<
      Record<string, unknown>
    >;
  return { write, call };
}

describe("artifacts.write warnings", () => {
  it("tells the agent when a new page references files it cannot load", async () => {
    const { write } = fixture();
    const result = await write("r1", {
      kind: "html",
      body: `<!doctype html><title>t</title><link rel="stylesheet" href="style.css">`,
    });
    expect(result.saved).toBe(true);
    expect(result.warnings).toEqual([
      expect.stringContaining("style.css"),
    ]);
  });

  it("warns again when a revision still has the problem, and clears it when fixed", async () => {
    const { write } = fixture();
    const created = await write("r2", {
      kind: "html",
      body: `<img src="logo.png">`,
    });
    const id = created.id as string;
    expect((await write("r3", { id, body: `<img src="logo.png"><p>v2</p>` })).warnings)
      .toHaveLength(1);
    const fixed = await write("r4", { id, body: `<p>self-contained</p>` });
    expect(fixed).not.toHaveProperty("warnings");
  });

  it("adds nothing to a clean page or to a document", async () => {
    const { write } = fixture();
    expect(
      await write("r5", { kind: "html", body: `<!doctype html><p>ok</p>` }),
    ).not.toHaveProperty("warnings");
    expect(
      await write("r6", { kind: "document", body: `# Notes\n\n<img src="a.png">` }),
    ).not.toHaveProperty("warnings");
  });
});

describe("artifacts.logs", () => {
  const key = (id: string) => `artifact:${id}`;

  it("tells the agent when the page has not been opened yet", async () => {
    const { write, call } = fixture();
    const created = await write("l1", { kind: "html", body: "<p>x</p>" });
    const result = await call("artifacts.logs", { id: created.id });
    expect(result).toMatchObject({ id: created.id, loaded: false, total: 0, entries: [] });
    expect(String(result.note)).toMatch(/open/i);
  });

  it("returns the page's console, newest last, once it has loaded", async () => {
    const { write, call } = fixture();
    const created = await write("l2", { kind: "html", body: "<p>x</p>" });
    const id = created.id as string;
    markPreviewLoaded(key(id));
    recordPreviewLog(key(id), "log", "start");
    recordPreviewLog(key(id), "error", "Uncaught ReferenceError: chart is not defined");
    const result = await call("artifacts.logs", { id });
    expect(result.loaded).toBe(true);
    expect(result.total).toBe(2);
    expect((result.entries as { level: string; text: string }[]).map((e) => [e.level, e.text])).toEqual([
      ["log", "start"],
      ["error", "Uncaught ReferenceError: chart is not defined"],
    ]);
    expect(result).not.toHaveProperty("note");
    clearPreviewLogs(key(id));
  });

  it("says a loaded page with no output is simply quiet, and honours limit", async () => {
    const { write, call } = fixture();
    const id = (await write("l3", { kind: "html", body: "<p>x</p>" })).id as string;
    markPreviewLoaded(key(id));
    expect(await call("artifacts.logs", { id })).toMatchObject({ loaded: true, total: 0, entries: [] });
    for (let i = 0; i < 80; i += 1) recordPreviewLog(key(id), "log", `m${i}`);
    const defaults = (await call("artifacts.logs", { id })).entries as { text: string }[];
    expect(defaults).toHaveLength(50);
    expect(defaults[49].text).toBe("m79");
    const few = (await call("artifacts.logs", { id, limit: 3 })).entries as { text: string }[];
    expect(few.map((e) => e.text)).toEqual(["m77", "m78", "m79"]);
    await expect(call("artifacts.logs", { id, limit: 0 })).rejects.toThrow(/limit/);
    await expect(call("artifacts.logs", { id, limit: 201 })).rejects.toThrow(/limit/);
    clearPreviewLogs(key(id));
  });

  it("refuses unknown artifacts and documents", async () => {
    const { write, call } = fixture();
    await expect(call("artifacts.logs", { id: "nope" })).rejects.toThrow(/not found/i);
    const doc = await write("l4", { kind: "document", body: "# Notes" });
    await expect(call("artifacts.logs", { id: doc.id })).rejects.toThrow(/html/i);
  });
});
