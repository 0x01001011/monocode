import { afterEach, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneRuntimes } from "./runtimes";

const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});
const DAY = 24 * 60 * 60 * 1000;

function fixture(names: string[], ageMs = DAY) {
  const base = mkdtempSync(join(tmpdir(), "monocode-runtimes-"));
  bases.push(base);
  const old = new Date(Date.now() - ageMs);
  for (const name of names) {
    const dir = join(base, "runtime", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "host.mjs"), "x");
    utimesSync(dir, old, old);
  }
  const exists = (name: string) => existsSync(join(base, "runtime", name));
  return { base, exists };
}

it("removes superseded runtimes but keeps the current and previous ones", async () => {
  const { base, exists } = fixture(["0.9.0-a", "0.9.0-b", "0.9.0-c", "0.8.0-x"]);
  writeFileSync(join(base, "runtime-path"), `${join(base, "runtime", "0.9.0-c")}\n`);
  writeFileSync(join(base, "previous-runtime"), `${join(base, "runtime", "0.9.0-b")}\n`);
  const removed = await pruneRuntimes(base, {});
  expect(removed.sort()).toEqual(["0.8.0-x", "0.9.0-a"]);
  expect(exists("0.9.0-c")).toBe(true);
  expect(exists("0.9.0-b")).toBe(true);
  expect(exists("0.9.0-a")).toBe(false);
  expect(exists("0.8.0-x")).toBe(false);
});

it("keeps recent directories, which may belong to a concurrent install", async () => {
  const { base, exists } = fixture(["0.9.0-fresh"], 60_000);
  writeFileSync(join(base, "runtime-path"), `${join(base, "runtime", "elsewhere")}\n`);
  expect(await pruneRuntimes(base, {})).toEqual([]);
  expect(exists("0.9.0-fresh")).toBe(true);
});

it("keeps a runtime that a running host executes from", async () => {
  const { base, exists } = fixture(["0.9.0-live", "0.9.0-old"]);
  writeFileSync(join(base, "runtime-path"), `${join(base, "runtime", "0.9.0-other")}\n`);
  const removed = await pruneRuntimes(base, {
    running: 4242,
    commandOf: async () =>
      `${join(base, "runtime", "0.9.0-live", "bin", "node")} ${join(base, "runtime", "0.9.0-live", "host.mjs")} serve`,
  });
  expect(removed).toEqual(["0.9.0-old"]);
  expect(exists("0.9.0-live")).toBe(true);
});

it("removes nothing when it cannot tell what the running host executes", async () => {
  const { base, exists } = fixture(["0.9.0-a", "0.9.0-b"]);
  const removed = await pruneRuntimes(base, {
    running: 4242,
    commandOf: async () => undefined,
  });
  expect(removed).toEqual([]);
  expect(exists("0.9.0-a")).toBe(true);
  expect(exists("0.9.0-b")).toBe(true);
});

it("ignores stray files and a missing runtime directory", async () => {
  const { base } = fixture([]);
  expect(await pruneRuntimes(base, {})).toEqual([]);
  mkdirSync(join(base, "runtime"), { recursive: true });
  writeFileSync(join(base, "runtime", "notes.txt"), "keep");
  expect(await pruneRuntimes(base, {})).toEqual([]);
  expect(existsSync(join(base, "runtime", "notes.txt"))).toBe(true);
});
