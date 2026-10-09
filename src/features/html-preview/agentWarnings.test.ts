import { describe, expect, it, vi } from "vitest";
import { newSession } from "../sessions/model/session";
import type { Artifact } from "../artifacts/artifacts";
import { handleAgentApp, type AgentAppHost } from "../agent-app/model/agentApp";

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
  const write = (requestId: string, input: Record<string, unknown>) =>
    handleAgentApp(source, requestId, "artifacts.write", input, host) as Promise<
      Record<string, unknown>
    >;
  return { write };
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
