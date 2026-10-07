import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  installScript,
  parseTarget,
  remoteCommand,
  validatePort,
  validateTarget,
} from "./deploy.mjs";

const sha256 = "a".repeat(64);

describe("host deploy", () => {
  it("reads the machine from the end of noisy output", () => {
    expect(parseTarget("Welcome!\nLinux\nx86_64\n")).toBe("linux-x64");
    expect(parseTarget("Darwin\narm64")).toBe("darwin-arm64");
    expect(parseTarget("Linux\r\naarch64\r\n")).toBe("linux-arm64");
  });

  it("refuses machines a host cannot run on", () => {
    expect(() => parseTarget("Windows_NT\nx86_64")).toThrow("Unsupported");
    expect(() => parseTarget("Linux\nriscv64")).toThrow("Unsupported");
    expect(() => parseTarget("")).toThrow("Unsupported");
  });

  it("only accepts SSH targets that cannot become options or commands", () => {
    for (const ok of ["k@100.127.60.130", "me@host.example", "alias", "[::1]"])
      expect(validateTarget(ok)).toBe(ok);
    for (const bad of ["-oProxyCommand=x", "a b", "a;b", "a$(b)", "", "a\nb"])
      expect(() => validateTarget(bad)).toThrow("Not an SSH target");
  });

  it("accepts ports 1-65535 only", () => {
    expect(validatePort("3774")).toBe(3774);
    for (const bad of ["0", "65536", "x", "1.5", ""])
      expect(() => validatePort(bad)).toThrow("Not a port");
  });

  it("verifies, unpacks and activates the archive, keeping the old runtime", () => {
    const script = installScript({
      sha256,
      version: "0.8.0",
      port: 3774,
      upload: '"$HOME/.monocode-host/runtime/.upload-$$"',
    });
    expect(script).toContain(`= '${sha256}'`);
    expect(script).toContain('--version)" = \'0.8.0\'');
    expect(script).toContain("previous-runtime");
    expect(script).toContain("service install --port 3774");
    // The checksum and version are checked before the runtime is activated.
    expect(script.indexOf("checksum mismatch")).toBeLessThan(
      script.indexOf("runtime-path.new"),
    );
    expect(script.indexOf("version mismatch")).toBeLessThan(
      script.indexOf("runtime-path.new"),
    );
    // It must be valid shell.
    expect(() =>
      execFileSync("sh", ["-n"], { input: script, stdio: ["pipe", "pipe", "pipe"] }),
    ).not.toThrow();
  });

  it("rejects values that could escape the script", () => {
    const base = { sha256, version: "0.8.0", port: 3774, upload: "x" };
    expect(() => installScript({ ...base, sha256: "z" })).toThrow("checksum");
    expect(() => installScript({ ...base, version: "0.8.0'; rm -rf ~" })).toThrow(
      "version",
    );
    expect(() => installScript({ ...base, port: 0 })).toThrow("Not a port");
  });

  it("sends the script as plain characters", () => {
    const script = installScript({
      sha256,
      version: "0.8.0",
      port: 3774,
      upload: '"$HOME/x-$$"',
    });
    const command = remoteCommand(Buffer.from(script).toString("base64"));
    expect(command).toMatch(/^sh -c 'eval "\$\(echo [A-Za-z0-9+/=]+ \| base64 -d\)"'$/);
    // Round trip through a real shell: the decoded script is the original.
    const decoded = execFileSync(
      "sh",
      ["-c", command.replace('eval "$(echo ', 'printf %s "$(echo ').replace(" | base64 -d)\"'", ' | base64 -d)"\'')],
      { encoding: "utf8" },
    );
    expect(decoded).toBe(script.replace(/\n+$/, ""));
    expect(() => remoteCommand("a b; rm")).toThrow("Invalid script");
  });
});
