import { beforeEach, describe, expect, it, vi } from "vitest";

const gitRangeContext = vi.hoisted(() =>
  vi.fn(async (_cwd: string, base?: string) => ({
    base: base ?? "main",
    head: "mc/next",
    commitSummary: "Child work",
    diffSummary: "1 file changed",
    diffPatch: "diff",
  })),
);
const reply = vi.hoisted(() =>
  vi.fn(async () => JSON.stringify({ title: "Child", body: "Body" })),
);

vi.mock("../../../platform/tauri/fs", () => ({
  gitRangeContext,
  gitStagedContext: vi.fn(),
}));
vi.mock("./claude/claudeText", () => ({ runClaudeTextPrompt: reply }));
vi.mock("./codex/codexText", () => ({ runCodexTextPrompt: reply }));
vi.mock("./cursor/cursorText", () => ({
  runCursorTextPrompt: reply,
  stopCursorTextPrompt: vi.fn(async () => undefined),
}));
vi.mock("./grok/grokText", () => ({ runGrokTextPrompt: reply }));
vi.mock("./opencode/opencodeText", () => ({ runOpenCodeTextPrompt: reply }));

const { generateClaudePrContent } = await import("./claude/claudeGit");
const { generateCodexPrContent } = await import("./codex/codexGit");
const { generateCursorPrContent } = await import("./cursor/cursorGit");
const { generateGrokPrContent } = await import("./grok/grokGit");
const { generateOpenCodePrContent } = await import("./opencode/opencodeGit");

const providers = [
  ["claude", generateClaudePrContent],
  ["codex", generateCodexPrContent],
  ["cursor", generateCursorPrContent],
  ["grok", generateGrokPrContent],
  ["opencode", generateOpenCodePrContent],
] as const;

beforeEach(() => {
  gitRangeContext.mockClear();
  reply.mockClear();
});

describe("PR content base", () => {
  it.each(providers)(
    "%s generates a stacked PR against the chosen base",
    async (_name, generate) => {
      await expect(generate("/repo", "mc/parent")).resolves.toMatchObject({
        base: "mc/parent",
        head: "mc/next",
      });
      expect(gitRangeContext).toHaveBeenCalledWith("/repo", "mc/parent");
    },
  );

  it.each(providers)(
    "%s keeps the default range without a base",
    async (_name, generate) => {
      await expect(generate("/repo")).resolves.toMatchObject({ base: "main" });
      expect(gitRangeContext).toHaveBeenCalledWith("/repo", undefined);
    },
  );
});
