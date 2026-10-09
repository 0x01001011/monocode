import { afterEach, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  lstatSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs once, right after the host's first read of a file: the moment a
// concurrent agent edit would land between the host's compare and its write.
let afterFirstRead: (() => void) | undefined;
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    readFile: async (...args: Parameters<typeof real.readFile>) => {
      const out = await real.readFile(...args);
      const hook = afterFirstRead;
      afterFirstRead = undefined;
      hook?.();
      return out;
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  afterFirstRead = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const workspace = () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "monocode-write-")));
  roots.push(root);
  return root;
};

it("keeps a concurrent agent edit instead of overwriting it", async () => {
  const { writeHostFile } = await import("./workspace");
  const root = workspace();
  const file = join(root, "notes.txt");
  writeFileSync(file, "v1\n");
  afterFirstRead = () => writeFileSync(file, "AGENT EDIT\n");
  await expect(writeHostFile(root, "notes.txt", "v1\n", "user save\n")).rejects.toThrow(
    /changed on the host/,
  );
  expect(readFileSync(file, "utf8")).toBe("AGENT EDIT\n");
  expect(readdirSync(root)).toEqual(["notes.txt"]);
});

it("replaces the file atomically, keeping its mode and leaving no temp files", async () => {
  const { writeHostFile } = await import("./workspace");
  const root = workspace();
  const file = join(root, "run.sh");
  writeFileSync(file, "old\n");
  chmodSync(file, 0o755);
  const inode = statSync(file).ino;
  await writeHostFile(root, "run.sh", "old\n", "new\n");
  expect(readFileSync(file, "utf8")).toBe("new\n");
  // A new inode means the content was swapped in by rename, not truncated in place.
  expect(statSync(file).ino).not.toBe(inode);
  // Windows has no POSIX mode bits to preserve.
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o755);
  expect(readdirSync(root)).toEqual(["run.sh"]);
});

// File symlinks need elevated rights on Windows.
it.skipIf(process.platform === "win32")(
  "writes through a symlink to its target without replacing the link",
  async () => {
    const { writeHostFile } = await import("./workspace");
    const root = workspace();
    mkdirSync(join(root, "real"));
    writeFileSync(join(root, "real", "config.json"), "{}\n");
    symlinkSync(join(root, "real", "config.json"), join(root, "link.json"));
    await writeHostFile(root, "link.json", "{}\n", '{"a":1}\n');
    expect(lstatSync(join(root, "link.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, "real", "config.json"), "utf8")).toBe('{"a":1}\n');
  },
);
