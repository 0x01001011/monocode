import { describe, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import { lastTestRun } from "./testRuns";

let seq = 0;
/** A finished shell call with the command in its title (what the transcript shows). */
function shell(command: string, over: Partial<Block> & { status?: string } = {}): Block {
  const { status = "completed", ...rest } = over;
  seq += 1;
  return {
    id: `b${seq}`,
    role: "tool",
    text: "",
    tool: { kind: "execute", title: command, status },
    toolStartedAt: 1_000 * seq,
    toolEndedAt: 1_000 * seq + 500,
    ...rest,
  } as Block;
}

describe("lastTestRun runner matching", () => {
  it.each([
    "vitest run src/features/tasks",
    "npx vitest run",
    "./node_modules/.bin/vitest",
    "npm test",
    "npm test -- --watch=false",
    "npm run test",
    "npm run test:unit",
    "npm run check",
    "npm run check:web",
    "pnpm test",
    "yarn test",
    "cargo test",
    "cargo +nightly test --lib",
    "pytest -q",
    "python3 -m pytest tests",
    "npx jest --ci",
    "go test ./...",
    "go test -run TestX ./pkg",
    "npx playwright test -c cfg.ts",
    "CI=1 npm test",
    "cd app && npm run check:web",
    "export PATH=$HOME/bin:$PATH; npx vitest run | tail -5",
    "/bin/zsh -lc \"cargo test --release\"",
    "Run command: npm test",
    "Bash: cargo test",
  ])("recognises %s", (command) => {
    expect(lastTestRun([shell(command)])?.command).toBeTruthy();
  });

  it.each([
    "cat vitest.config.ts",
    "grep -rn jest src",
    "git commit -m \"fix vitest\"",
    "echo pytest-cov",
    "npm install vitest",
    "npm run build",
    "npm run checkout",
    "npm run check-types",
    "npm run tests",
    "cargo build",
    "cargo testify",
    "go testing",
    "ls pytest.ini",
    "node scripts/jester.js",
    "playwright install",
    "mypytest run",
  ])("ignores %s", (command) => {
    expect(lastTestRun([shell(command)])).toBeUndefined();
  });

  it("reads the original command from a shell preview when the title was simplified", () => {
    const block = shell("Shell", { tool: { kind: "execute", title: "Shell", status: "completed", preview: { kind: "shell", title: "cargo test" } } });
    expect(lastTestRun([block])?.command).toBe("cargo test");
  });

  it("falls back to the block text", () => {
    const block = shell("", { text: "npm test", tool: { kind: "execute", title: "", status: "completed" } });
    expect(lastTestRun([block])?.command).toBe("npm test");
  });

  it("strips a 'Run command:' prefix from the reported command", () => {
    expect(lastTestRun([shell("Run command: npm test")])?.command).toBe("npm test");
  });
});

describe("lastTestRun", () => {
  it("is undefined without blocks or without a match", () => {
    expect(lastTestRun(undefined)).toBeUndefined();
    expect(lastTestRun([])).toBeUndefined();
    expect(lastTestRun([shell("git status")])).toBeUndefined();
  });

  it("reports passed for a successful call, with the end time", () => {
    const block = shell("npm test", { toolStartedAt: 100, toolEndedAt: 900 });
    expect(lastTestRun([block])).toEqual({ status: "passed", at: 900, command: "npm test" });
  });

  it("accepts the success status as well as completed", () => {
    expect(lastTestRun([shell("npm test", { status: "success" })])?.status).toBe("passed");
  });

  it.each(["failed", "error", "cancelled"])("reports failed for status %s", (status) => {
    expect(lastTestRun([shell("npm test", { status })])?.status).toBe("failed");
  });

  it("reports a denied approval as failed", () => {
    expect(lastTestRun([shell("npm test", { approval: { requestId: 1, decided: "deny" } })])?.status).toBe("failed");
  });

  it.each(["in_progress", "running", "pending"])("reports running for status %s, timed from the start", (status) => {
    const block = shell("npm test", { status, toolStartedAt: 100, toolEndedAt: undefined });
    expect(lastTestRun([block])).toEqual({ status: "running", at: 100, command: "npm test" });
  });

  it("a call that went back to running keeps its start time, not a stale end time", () => {
    const block = shell("npm test", { status: "running", toolStartedAt: 100, toolEndedAt: 900 });
    expect(lastTestRun([block])).toMatchObject({ status: "running", at: 100 });
  });

  it("falls back to the start time, and leaves the time out when none was recorded", () => {
    expect(lastTestRun([shell("npm test", { toolStartedAt: 100, toolEndedAt: undefined })])?.at).toBe(100);
    const bare = lastTestRun([shell("npm test", { toolStartedAt: undefined, toolEndedAt: undefined })]);
    expect(bare).toEqual({ status: "passed", command: "npm test" });
    expect("at" in (bare ?? {})).toBe(false);
  });

  it("the newest matching block wins, whatever came before", () => {
    const blocks = [shell("npm test", { status: "failed" }), shell("git status"), shell("cargo test"), shell("ls")];
    expect(lastTestRun(blocks)).toMatchObject({ status: "passed", command: "cargo test" });
    const rerun = [shell("npm test"), shell("npm test", { status: "failed" })];
    expect(lastTestRun(rerun)?.status).toBe("failed");
  });

  it("ignores tools that are not shell calls, even when they mention a runner", () => {
    const read: Block = { id: "r", role: "tool", text: "", tool: { kind: "read", title: "npm test", status: "completed" } } as Block;
    const agent: Block = { id: "a", role: "tool", text: "npm test", tool: { kind: "agent", title: "Agent", status: "completed" } } as Block;
    const assistant: Block = { id: "m", role: "assistant", text: "npm test" } as Block;
    expect(lastTestRun([read, agent, assistant])).toBeUndefined();
  });

  it("finds a shell call by its title when the kind is generic, dropping the tool name", () => {
    const block: Block = { id: "x", role: "tool", text: "", tool: { kind: "other", title: "Bash npm test", status: "completed" } } as Block;
    expect(lastTestRun([block])?.command).toBe("npm test");
    const run: Block = { id: "y", role: "tool", text: "", tool: { kind: "bash", title: "npm test", status: "completed" } } as Block;
    expect(lastTestRun([run])?.status).toBe("passed");
  });
});
