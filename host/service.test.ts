import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  hostStartFailure,
  launchAgent,
  servicePath,
  systemdSetupFailure,
  systemdUnit,
  uninstallService,
  withServicePath,
} from "./service";

it("keeps paths and environment content from injecting service configuration", () => {
  const options = {
    directory: "/Users/a & b/%folder",
    port: 3774,
    executable: '/runtime/a"b/node',
    entry: "/runtime/$name/host.mjs",
  };
  const plist = launchAgent(options, "/bin:<test>&other");
  expect(plist).toContain("a&quot;b/node");
  expect(plist).toContain("/bin:&lt;test&gt;&amp;other");
  expect(plist).not.toContain("<test>");
  const unit = systemdUnit(options, "/bin:/a\n[Service]\nExecStart=/bad");
  expect(unit.match(/^ExecStart=/gm)).toHaveLength(1);
  expect(unit).toContain("%%folder");
  expect(unit).toContain("$$name");
  expect(unit).toContain("KillMode=control-group");
});

it.skipIf(process.platform === "win32").each(["darwin", "linux"] as const)(
  "removes the %s service registration but keeps host data",
  async (platform) => {
    const home = mkdtempSync(join(tmpdir(), "monocode-service-test-"));
    try {
      const service =
        platform === "darwin"
          ? join(home, "Library/LaunchAgents/com.monocode.host.plist")
          : join(home, ".config/systemd/user/monocode-host.service");
      const data = join(home, ".monocode-host/host.db");
      for (const file of [service, data]) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "existing");
      }
      const calls: string[][] = [];
      const notes = await uninstallService({
        platform,
        home,
        run: async (command, args) => {
          calls.push([command, ...args]);
          // A service that is not loaded must not block cleanup.
          if (args.includes("bootout") || args.includes("disable"))
            throw new Error("not loaded");
        },
      });
      expect(existsSync(service)).toBe(false);
      expect(readFileSync(data, "utf8")).toBe("existing");
      if (platform === "darwin")
        expect(calls[0].slice(0, 2)).toEqual(["launchctl", "bootout"]);
      else {
        expect(calls).toContainEqual([
          "systemctl",
          "--user",
          "disable",
          "--now",
          "monocode-host.service",
        ]);
        expect(notes.join("\n")).toContain("loginctl disable-linger");
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

it("unregisters only this user's Windows task", async () => {
  const scripts: string[] = [];
  await uninstallService({
    platform: "win32",
    powershell: async (script) => scripts.push(script),
  });
  expect(scripts[0]).toContain('"MonoCode Host-$sid"');
  expect(scripts[0]).toContain("Unregister-ScheduledTask");
  expect(scripts[0]).not.toMatch(/Remove-Item|\.monocode-host/);
});

describe("service PATH", () => {
  it("adds Homebrew only on macOS and never repeats an entry", () => {
    const base = "/home/u/.local/bin:/usr/bin";
    const linux = servicePath(base, "/home/u", "linux").split(":");
    expect(linux).not.toContain("/opt/homebrew/bin");
    expect(linux.filter((entry) => entry === "/home/u/.local/bin")).toHaveLength(1);
    expect(linux).toContain("/usr/local/bin");
    expect(servicePath(base, "/Users/u", "darwin").split(":")).toContain(
      "/opt/homebrew/bin",
    );
  });

  const options = {
    directory: "/home/u/.monocode-host",
    port: 3774,
    executable: "/runtime/node",
    entry: "/runtime/host.mjs",
  };

  it("refreshes only the PATH of an existing systemd unit", () => {
    const edited = systemdUnit(options, "/old").replace(
      "RestartSec=5",
      "RestartSec=30\n# kept: local tuning",
    );
    const next = withServicePath(edited, "/new:/bin");
    expect(next).toContain('Environment="PATH=/new:/bin"');
    expect(next).toContain("RestartSec=30");
    expect(next).toContain("# kept: local tuning");
    expect(next).not.toContain("/old");
    expect(withServicePath(next, "/new:/bin")).toBe(next);
  });

  it("leaves a unit without a PATH line alone", () => {
    expect(withServicePath("[Service]\nExecStart=/x\n", "/new")).toBe(
      "[Service]\nExecStart=/x\n",
    );
  });
});

describe("Linux setup failures", () => {
  it.each([
    [Object.assign(new Error("spawn loginctl ENOENT"), { code: "ENOENT" })],
    [Object.assign(new Error("x"), { stderr: "Failed to connect to bus: No such file or directory" })],
    [Object.assign(new Error("x"), { stderr: "System has not been booted with systemd as init system" })],
  ])("explains a host without a systemd user manager: %#", (error) => {
    const message = systemdSetupFailure(error, "alice");
    expect(message).toMatch(/no systemd user manager/i);
    expect(message).toContain("monocode-host start");
    expect(message).not.toContain("sudo loginctl");
  });

  it.each([
    [new Error("linger disabled")],
    [Object.assign(new Error("x"), { stderr: "Access denied" })],
  ])("keeps the administrator advice when lingering is off: %#", (error) => {
    const message = systemdSetupFailure(error, "alice");
    expect(message).toContain("sudo loginctl enable-linger alice");
  });
});

describe("host start failures", () => {
  it("points Linux users at the journal, which is where the unit logs", () => {
    const message = hostStartFailure("linux", "/home/u/.monocode-host");
    expect(message).toContain("journalctl --user -u monocode-host.service");
    expect(message).not.toContain("host.log");
  });

  it("points other platforms at host.log, which their service writes", () => {
    expect(hostStartFailure("darwin", "/Users/u/.monocode-host")).toContain(
      "/Users/u/.monocode-host/host.log",
    );
  });
});
