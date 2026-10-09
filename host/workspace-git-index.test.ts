import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostGitIndex } from "./workspace";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A status poll that refreshes the index rewrites the user's .git/index and can
// collide with an agent's own `git add`; background reads must not take locks.
it("reads Git status without rewriting the repository index", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "monocode-git-index-")));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
  git("init", "-q");
  for (const name of ["a.txt", "b.txt"]) writeFileSync(join(root, name), name);
  git("add", "-A");
  git("commit", "-qm", "init");
  // Touch the files so the index's cached stat data is stale: the case where
  // `git status` would normally refresh and rewrite the index.
  const later = new Date(Date.now() + 5_000);
  for (const name of ["a.txt", "b.txt"]) utimesSync(join(root, name), later, later);
  const index = join(root, ".git/index");
  const before = statSync(index, { bigint: true }).mtimeNs;
  await hostGitIndex(root);
  expect(statSync(index, { bigint: true }).mtimeNs).toBe(before);
});
