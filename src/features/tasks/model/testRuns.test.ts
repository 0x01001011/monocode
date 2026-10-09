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
    "npm test -- --run",
    "cd x && npx vitest run",
    "bash -lc 'npm test'",
    "zsh -lc \"cd app && npm run check:web\"",
    "cd x && bash -lc 'npm test'",
    "pnpm vitest run",
    "yarn vitest",
    "pnpm exec vitest run",
    "npm exec vitest",
    "npm exec -- vitest run",
    "yarn exec jest",
    "timeout 60 npm test",
    "timeout -s KILL 5m cargo test",
    "uv run pytest -q",
    "poetry run pytest",
    "pnpm -r test",
    "pnpm --filter web test",
    "pnpm -F web run test:unit",
    "npm --prefix app test",
    "npm t",
    "make test",
    "cargo nextest run",
    "cargo nextest run --workspace",
    "deno test",
    "deno test -A",
    "node --test",
    "node --experimental-vm-modules --test src",
    "$ npm test",
    "`npm test`",
    "Running: npm test",
    "Shell: cargo test",
    "echo start\nnpm test\necho done",
    "echo hi; (cd x && npm test)",
    "cat <<EOF > notes.txt\nhello\nEOF\nnpm test",
    "# run later\nnpm test",
    "FOO=\"a b\" npm test",
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
    "echo 'a; vitest'",
    "echo \"a && npm test\"",
    "echo $(vitest)",
    "echo \"$(npm test)\"",
    "echo `npm test`",
    "echo a \\; npm test",
    "cat <<EOF\nnpm test\nEOF",
    "cat <<'EOF' > run.sh\nnpx vitest run\nEOF",
    "cat <<-EOF\n\tcargo test\n\tEOF",
    "cat <<EOF | tee x\nnpm test\nEOF",
    "echo 'multi\nnpm test\nline'",
    "# npm test",
    "echo hi # npm test",
    "bash script.sh",
    "bash -c 'echo hello'",
    "make build",
    "node --test-only x",
    "node script.js",
    "deno run x.ts",
    "cargo nextest list",
    "uv run python main.py",
    "timeout 60 sleep 5",
    "npm --prefix app install",
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

  it.each(["failed", "error"])("reports failed for status %s", (status) => {
    expect(lastTestRun([shell("npm test", { status })])?.status).toBe("failed");
  });

  it.each(["cancelled", "canceled"])("a %s call never ran: it is skipped, not failed", (status) => {
    expect(lastTestRun([shell("npm test", { status })])).toBeUndefined();
    const older = [shell("npm test"), shell("npm test", { status })];
    expect(lastTestRun(older)).toMatchObject({ status: "passed" });
  });

  it("a denied approval never ran: it is skipped and the scan continues to older blocks", () => {
    const denied = shell("npm test", { approval: { requestId: 1, decided: "deny" } });
    expect(lastTestRun([denied])).toBeUndefined();
    const failedBefore = [shell("npm test", { status: "failed" }), denied];
    expect(lastTestRun(failedBefore)).toMatchObject({ status: "failed" });
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

describe("lastTestRun piped runs", () => {
  it.each([
    "npx vitest run 2>&1 | tail -20",
    "npm test | head",
    "cd app && npm run check:web 2>&1 |& tee out.log",
    "cargo test | grep -c ok",
    "bash -lc 'npm test | tail'",
    "cd x && bash -lc \"cargo test | tail\"",
  ])("%s is unknown whatever the harness status says", (command) => {
    expect(lastTestRun([shell(command)])?.status).toBe("unknown");
    expect(lastTestRun([shell(command, { status: "failed" })])?.status).toBe("unknown");
  });

  it("keeps the time of an unknown run", () => {
    expect(lastTestRun([shell("npm test | tail", { toolStartedAt: 100, toolEndedAt: 900 })])).toEqual({
      status: "unknown",
      at: 900,
      command: "npm test | tail",
    });
  });

  it("a piped run still in flight is running", () => {
    const block = shell("npm test | tail", { status: "running", toolStartedAt: 100, toolEndedAt: undefined });
    expect(lastTestRun([block])).toMatchObject({ status: "running", at: 100 });
  });

  it.each([
    "set -o pipefail; npm test | tail",
    "set -eo pipefail && npx vitest run 2>&1 | tail -5",
  ])("%s trusts the status with pipefail", (command) => {
    expect(lastTestRun([shell(command)])?.status).toBe("passed");
    expect(lastTestRun([shell(command, { status: "failed" })])?.status).toBe("failed");
  });

  it.each([
    "npm test || echo failed",
    "npm test 2>&1",
    "echo 'a | b' && npm test",
    "echo \"a | b\"; npm test",
    "echo $(ls | wc -l) && npm test",
    "cat <<EOF\na | b\nEOF\nnpm test",
  ])("%s has no pipe outside quotes", (command) => {
    expect(lastTestRun([shell(command)])?.status).toBe("passed");
  });
});

describe("lastTestRun cost", () => {
  it("scans 5k shell blocks with 70 KB commands well under a second", () => {
    const huge = `cat > big.txt <<EOF\n${"npm test line of generated text\n".repeat(2200)}EOF\nnpm test`;
    expect(huge.length).toBeGreaterThan(70_000);
    const blocks = Array.from({ length: 5000 }, () => shell(huge));
    const started = performance.now();
    expect(lastTestRun(blocks)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("analyses only the first 1000 characters, and reports no more than that", () => {
    const run = lastTestRun([shell(`npm test -- ${"x".repeat(5000)}`)]);
    expect(run?.status).toBe("passed");
    expect(run?.command.length).toBeLessThanOrEqual(1000);
    expect(lastTestRun([shell(`echo ${"x".repeat(1200)}; npm test`)])).toBeUndefined();
  });
});
