import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = [
  "src/app/shell",
  "src/app/ui",
  "src/features/settings",
  "src/features/workspace",
  "src/features/projects",
  "src/features/quick-composer",
];

// The Windows close button keeps the platform's red.
const ALLOWED = new Set(["src/app/shell/WindowControls.tsx"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    // Forward slashes everywhere, so the allow-list matches on Windows too.
    const path = join(dir, name).replace(/\\/g, "/");
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) ? [path] : [];
  });
}

function offenders(pattern: RegExp): string[] {
  return ROOTS.flatMap(sources)
    .filter((path) => !ALLOWED.has(path))
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          pattern.test(line) ? [`${path}:${index + 1}`] : [],
        ),
    );
}

describe("shared color tokens in shell, settings, workspace, projects and quick composer", () => {
  it("uses text-muted instead of ink at 35-55% for informational text", () => {
    expect(offenders(/text-content\/(3[5-9]|4\d|5[0-5])(?![\d.])/)).toEqual([]);
  });

  it("uses the status tokens instead of raw red, amber and emerald shades", () => {
    expect(
      offenders(/\b(?:text|bg|border)-(?:red|amber|emerald|rose)-\d/),
    ).toEqual([]);
  });

  it("keeps white off accent fills", () => {
    expect(offenders(/bg-accent(?![\w/-])[^"`]*text-white/)).toEqual([]);
  });
});
