import { execFile } from "node:child_process";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** A directory this young may be a concurrent install still being set up. */
const MIN_AGE_MS = 10 * 60 * 1000;

/** The command line of a process, or undefined when it cannot be read. */
async function processCommand(pid: number): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  try {
    const { stdout } = await exec("ps", ["-p", String(pid), "-o", "command="], {
      timeout: 5_000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

const pointer = (base: string, name: string) =>
  readFile(join(base, name), "utf8").then(
    (text) => resolve(text.trim()),
    () => undefined,
  );

/**
 * Host runtimes nothing needs any more. Every install, upgrade and deploy
 * unpacks another ~120 MB runtime and none was ever deleted. Keeps the current
 * and previous runtime (the rollback target), anything a running host executes
 * from, and anything recent. When a host is running but its command line cannot
 * be read, nothing is stale. Read-only.
 */
export async function staleRuntimes(
  base: string,
  options: {
    running?: number;
    commandOf?: (pid: number) => Promise<string | undefined>;
    now?: number;
    minAgeMs?: number;
  },
): Promise<string[]> {
  const root = join(base, "runtime");
  const names = await readdir(root).catch(() => [] as string[]);
  if (names.length === 0) return [];
  let command = "";
  if (options.running !== undefined) {
    const found = await (options.commandOf ?? processCommand)(options.running);
    if (found === undefined) return [];
    command = found;
  }
  const kept = new Set(
    (
      await Promise.all([
        pointer(base, "runtime-path"),
        pointer(base, "previous-runtime"),
      ])
    ).filter((path): path is string => path !== undefined),
  );
  const now = options.now ?? Date.now();
  const minAge = options.minAgeMs ?? MIN_AGE_MS;
  const stale: string[] = [];
  for (const name of names) {
    const dir = join(root, name);
    const info = await stat(dir).catch(() => undefined);
    if (!info?.isDirectory() || now - info.mtimeMs < minAge) continue;
    if (kept.has(resolve(dir)) || command.includes(`${dir}${sep}`)) continue;
    stale.push(name);
  }
  return stale;
}

/** Delete the stale runtimes; returns the names removed. */
export async function pruneRuntimes(
  base: string,
  options: Parameters<typeof staleRuntimes>[1],
): Promise<string[]> {
  const names = await staleRuntimes(base, options);
  await Promise.all(
    names.map((name) =>
      rm(join(base, "runtime", name), { recursive: true, force: true }),
    ),
  );
  return names;
}
