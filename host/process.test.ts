import { describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProvider } from "./process";

it.each(["cursor", "pi", "fx"] as const)(
  "does not execute an unrelated ambiguous %s binary while resolving providers",
  async (provider) => {
    const directory = mkdtempSync(
      join(tmpdir(), "monocode-provider-identity-"),
    );
    const name = provider === "cursor" ? "agent" : provider;
    const candidate = join(directory, name);
    const sentinel = join(directory, "executed");
    writeFileSync(candidate, `#!/bin/sh\nprintf bad > '${sentinel}'\n`);
    chmodSync(candidate, 0o755);
    vi.stubEnv("PATH", directory);
    try {
      let resolved: string | undefined;
      try {
        resolved = await resolveProvider(provider);
      } catch {
        /* no matching provider is expected on CI */
      }
      expect(resolved).not.toBe(candidate);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform !== "win32")(
  "recognizes an npm-installed pi launcher stub through its package manifest",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "monocode-pi-npm-"));
    const packageDirectory = join(
      directory,
      "lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle",
    );
    const stub = join(packageDirectory, "cli.js");
    mkdirSync(packageDirectory, { recursive: true });
    // Mirrors the real npm launcher: a thin stub whose content carries none
    // of the marker strings — identity only lives in the package manifest.
    writeFileSync(
      stub,
      '#!/usr/bin/env node\nimport { createRequire } from "node:module";\n\nenableCompileCache();\ncreateRequire(import.meta.url)("./cli-runtime.js");\n',
    );
    chmodSync(stub, 0o755);
    writeFileSync(
      join(packageDirectory, "../../package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent" }),
    );
    const candidate = join(directory, "bin/pi");
    mkdirSync(join(directory, "bin"), { recursive: true });
    symlinkSync(stub, candidate);
    vi.stubEnv("PATH", join(directory, "bin"));
    try {
      expect(await resolveProvider("pi")).toBe(candidate);
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform !== "win32")(
  "does not mistake an unrelated npm stub named pi for the pi agent",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "monocode-pi-unrelated-"));
    const packageDirectory = join(
      directory,
      "lib/node_modules/pi-coding-agent-tools/dist",
    );
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "cli.js"), "#!/usr/bin/env node\n");
    chmodSync(join(packageDirectory, "cli.js"), 0o755);
    writeFileSync(
      join(packageDirectory, "../../package.json"),
      JSON.stringify({ name: "pi-coding-agent-tools" }),
    );
    const candidate = join(directory, "bin/pi");
    mkdirSync(join(directory, "bin"), { recursive: true });
    symlinkSync(join(packageDirectory, "cli.js"), candidate);
    vi.stubEnv("PATH", join(directory, "bin"));
    try {
      const resolved = await resolveProvider("pi").catch(() => undefined);
      expect(resolved).not.toBe(candidate);
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform !== "win32")(
  "recognizes a Cursor agent shim without executing it",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "monocode-cursor-identity-"));
    const targetDirectory = join(directory, "cursor-agent-package");
    const target = join(targetDirectory, "cursor-agent");
    const candidate = join(directory, "agent");
    const sentinel = join(directory, "executed");
    mkdirSync(targetDirectory);
    writeFileSync(target, `#!/bin/sh\nprintf bad > '${sentinel}'\n`);
    chmodSync(target, 0o755);
    symlinkSync(target, candidate);
    vi.stubEnv("PATH", directory);
    try {
      expect(await resolveProvider("cursor")).toBe(candidate);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// Providers installed with a Node version manager live in a directory a
// non-interactive service PATH never contains (the managers are initialised
// from interactive shell startup files).
describe.runIf(process.platform !== "win32")(
  "provider lookup in version-manager directories",
  () => {
    const launcher = (directory: string) => {
      mkdirSync(directory, { recursive: true });
      const file = join(directory, "grok");
      writeFileSync(file, "#!/bin/sh\necho grok\n");
      chmodSync(file, 0o755);
      return file;
    };
    const withHome = async (
      setup: (home: string) => string | undefined,
      env: Record<string, string> = {},
    ) => {
      const home = realpathSync(
        mkdtempSync(join(tmpdir(), "monocode-provider-home-")),
      );
      vi.stubEnv("HOME", home);
      vi.stubEnv("PATH", "/usr/bin:/bin");
      for (const [key, value] of Object.entries(env))
        vi.stubEnv(key, value.replace("$HOME", home));
      try {
        const expected = setup(home);
        const resolved = await resolveProvider("grok").catch(() => undefined);
        return { resolved, expected };
      } finally {
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
      }
    };

    it.each([
      ["nvm", ".nvm/versions/node/v22.1.0/bin"],
      ["volta", ".volta/bin"],
      ["pnpm", ".local/share/pnpm"],
      ["asdf", ".asdf/shims"],
      ["mise", ".local/share/mise/shims"],
      ["fnm default alias", ".local/share/fnm/aliases/default/bin"],
    ])("finds a provider installed by %s", async (_name, relative) => {
      const { resolved, expected } = await withHome((home) =>
        launcher(join(home, relative)),
      );
      expect(resolved).toBe(expected);
    });

    it("prefers the newest nvm Node version", async () => {
      const { resolved, expected } = await withHome((home) => {
        launcher(join(home, ".nvm/versions/node/v9.11.2/bin"));
        launcher(join(home, ".nvm/versions/node/v20.9.0/bin"));
        return launcher(join(home, ".nvm/versions/node/v22.1.0/bin"));
      });
      expect(resolved).toBe(expected);
    });

    it("honours NVM_DIR and VOLTA_HOME", async () => {
      const nvm = await withHome(
        (home) => launcher(join(home, "custom-nvm/versions/node/v22.1.0/bin")),
        { NVM_DIR: "$HOME/custom-nvm" },
      );
      expect(nvm.resolved).toBe(nvm.expected);
      const volta = await withHome(
        (home) => launcher(join(home, "custom-volta/bin")),
        { VOLTA_HOME: "$HOME/custom-volta" },
      );
      expect(volta.resolved).toBe(volta.expected);
    });
  },
);
