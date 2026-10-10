import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { describe, expect, it } from "vitest";

// Tailwind builds only the class names it finds spelled out in source. This compiles the app's
// stylesheet against what the scanner finds in TaskGraph.tsx alone (not its tests, which spell
// the classes out too), so an interpolated variant prefix shows up here as a missing rule.
const ROOT = process.cwd();
const STYLES = join(ROOT, "src/styles");

const escape = (cls: string) => cls.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);

async function cssFor(file: string): Promise<string> {
  const content = readFileSync(join(ROOT, file), "utf8");
  const candidates = new Scanner({}).scanFiles([{ content, extension: "tsx" }]);
  const compiler = await compile(readFileSync(join(STYLES, "index.css"), "utf8"), {
    base: STYLES,
    onDependency: () => {},
  });
  return compiler.build(candidates);
}

describe("TaskGraph classes", () => {
  it("emits the hover and focus-inside rules that open the row actions", { timeout: 30_000 }, async () => {
    const css = await cssFor("src/features/tasks/ui/TaskGraph.tsx");
    const needed = [
      "group-hover/row:max-w-none",
      "group-hover/row:pointer-events-auto",
      "group-hover/row:opacity-100",
      "group-hover/row:hidden",
      "group-has-[[data-actions]:focus-within]/row:max-w-none",
      "group-has-[[data-actions]:focus-within]/row:pointer-events-auto",
      "group-has-[[data-actions]:focus-within]/row:opacity-100",
      "group-has-[[data-actions]:focus-within]/row:hidden",
      "@max-[300px]:hidden",
      "@max-[340px]:hidden",
      "@max-[360px]:gap-1",
      "@max-[400px]:hidden",
      "@min-[300px]:basis-26",
      "basis-16",
      "shrink-0",
      "whitespace-nowrap",
      "@container",
    ];
    const missing = needed.filter((cls) => !css.includes(`.${escape(cls)}`));
    expect(missing).toEqual([]);
  });
});
