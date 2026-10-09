import { describe, expect, it } from "vitest";
import { MAX_PLAN_BYTES, parsePlan } from "./planFile";

const lines = (...l: string[]) => l.join("\n");
const numbers = (text: string) => parsePlan(text).tasks.map((t) => t.n);

describe("parsePlan headings", () => {
  it("returns no tasks for empty or taskless text", () => {
    expect(parsePlan("")).toEqual({ tasks: [] });
    expect(parsePlan("just words\n- [ ] orphan step\n")).toEqual({ tasks: [] });
  });

  it("reads the first level-1 heading as the plan title", () => {
    const plan = parsePlan(lines("# **Tasks** Panel Plan", "", "### Task 1: One", "# Second"));
    expect(plan.title).toBe("Tasks Panel Plan");
  });

  it.each([
    ["# Task 1: A", 1, "A"],
    ["## Task 2: B", 2, "B"],
    ["### Task 3: C", 3, "C"],
    ["#### Task 4: D", 4, "D"],
    ["##### Task 5: E", 5, "E"],
    ["###### Task 6: F", 6, "F"],
    ["   ### Task 7: indented up to three spaces", 7, "indented up to three spaces"],
    ["### Task 8. dot", 8, "dot"],
    ["### Task 9) paren", 9, "paren"],
    ["### Task 10 - hyphen", 10, "hyphen"],
    ["### Task 11 – en dash", 11, "en dash"],
    ["### Task 12 — em dash", 12, "em dash"],
    ["### Task 13: closing hashes ###", 13, "closing hashes"],
    ["### **Task 14: bold whole**", 14, "bold whole"],
    ["### **Task 15:** bold label", 15, "bold label"],
    ["### Task 16: `code` and *em* and __strong__", 16, "code and em and strong"],
    ["### task 17: lower case", 17, "lower case"],
    ["### Task   18:    spaced   out", 18, "spaced out"],
  ])("accepts %j", (heading, n, title) => {
    expect(parsePlan(heading).tasks).toEqual([{ n, title, steps: [] }]);
  });

  it("gives an empty title the task number", () => {
    expect(parsePlan("### Task 3:").tasks).toEqual([{ n: 3, title: "Task 3", steps: [] }]);
  });

  it.each([
    ["no separator", "### Task 1 Foo"],
    ["bold-only line", "**Task 1: Foo**"],
    ["plain line", "Task 1: Foo"],
    ["no space after hashes", "###Task 1: Foo"],
    ["seven hashes", "####### Task 1: Foo"],
    ["indented four spaces (code)", "    ### Task 1: Foo"],
    ["decimal number", "### Task 1.2: Foo"],
    ["number range", "### Task 1-2: Foo"],
    ["not a number", "### Task A: Foo"],
    ["word before", "### Subtask 1: Foo"],
    ["list item", "- ### Task 1: Foo"],
  ])("rejects %s", (_name, heading) => {
    expect(parsePlan(heading).tasks).toEqual([]);
  });

  it("keeps the first of duplicate task numbers and ignores its steps", () => {
    const plan = parsePlan(
      lines("### Task 1: First", "- [ ] a", "### Task 2: Two", "### Task 1: Again", "- [x] b", "- [ ] c"),
    );
    expect(plan.tasks.map((t) => [t.n, t.title, t.steps.length])).toEqual([
      [1, "First", 1],
      [2, "Two", 0],
    ]);
  });

  it("keeps plan order, not numeric order, and tolerates gaps", () => {
    expect(numbers(lines("### Task 3: c", "### Task 1: a", "### Task 7: g"))).toEqual([3, 1, 7]);
  });

  it("handles CRLF and lone CR line endings", () => {
    const plan = parsePlan("### Task 1: One\r\n- [ ] a\r\n- [x] b\r\n### Task 2: Two\r- [ ] c\r");
    expect(plan.tasks).toEqual([
      { n: 1, title: "One", steps: [{ text: "a", done: false }, { text: "b", done: true }] },
      { n: 2, title: "Two", steps: [{ text: "c", done: false }] },
    ]);
  });
});

describe("parsePlan steps", () => {
  const steps = (...body: string[]) => parsePlan(lines("### Task 1: T", ...body)).tasks[0]?.steps ?? [];

  it.each([
    ["- [ ] dash", "dash", false],
    ["* [ ] star", "star", false],
    ["+ [ ] plus", "plus", false],
    ["1. [ ] numbered", "numbered", false],
    ["12. [ ] numbered two digits", "numbered two digits", false],
    ["3) [ ] paren numbered", "paren numbered", false],
    ["- [x] done lower", "done lower", true],
    ["- [X] done upper", "done upper", true],
    ["* [x] star done", "star done", true],
    ["1. [X] numbered done", "numbered done", true],
    ["  - [ ] two-space indent", "two-space indent", false],
    ["-   [ ]   extra   spaces", "extra spaces", false],
  ])("reads %j", (line, text, done) => {
    expect(steps(line)).toEqual([{ text, done }]);
  });

  it.each([
    ["nested three spaces", "   - [ ] nested"],
    ["nested four spaces", "    - [ ] nested"],
    ["tab indented", "\t- [ ] nested"],
    ["plain bullet", "- plain bullet"],
    ["no space in box", "- [] none"],
    ["other mark", "- [-] partial"],
    ["no text", "- [ ]"],
    ["no space before box", "-[ ] x"],
    ["text before box", "see - [ ] x"],
    ["blockquote", "> - [ ] quoted"],
  ])("ignores %s", (_name, line) => {
    expect(steps(line)).toEqual([]);
  });

  it("strips emphasis and the Step label", () => {
    expect(
      steps(
        "- [ ] **Step 1: Write failing tests** in `a.test.ts`",
        "- [ ] **Step 2:** do _it_ now",
        "- [x] Step 3 - plain label",
        "- [ ] __Step 4. Run__ it",
        "- [ ] Step 5) paren label",
        "- [ ] *Step 6 — emdash* label",
        "- [ ] ~~strike~~ and `code`",
        "- [ ] snake_case_name and 2*3*4 stay",
        "- [ ] Stepping stones",
        "- [ ] Step by step",
      ),
    ).toEqual([
      { text: "Write failing tests in a.test.ts", done: false },
      { text: "do it now", done: false },
      { text: "plain label", done: true },
      { text: "Run it", done: false },
      { text: "paren label", done: false },
      { text: "emdash label", done: false },
      { text: "strike and code", done: false },
      { text: "snake_case_name and 2*3*4 stay", done: false },
      { text: "Stepping stones", done: false },
      { text: "Step by step", done: false },
    ]);
  });

  it("drops a step whose text is only a label", () => {
    expect(steps("- [ ] **Step 1:**")).toEqual([]);
  });

  it("collapses whitespace and caps text at 200 characters", () => {
    const long = steps(`- [ ] ${"word ".repeat(100)}`)[0]?.text ?? "";
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.startsWith("word word")).toBe(true);
    expect(long).toBe(long.trim());
  });

  it("attaches steps to the task above and ignores steps before the first task", () => {
    const plan = parsePlan(
      lines("- [ ] orphan", "## Task 1: A", "- [ ] a1", "- [x] a2", "## Task 2: B", "- [ ] b1", "## Task 3: C"),
    );
    expect(plan.tasks.map((t) => t.steps.map((s) => s.text))).toEqual([["a1", "a2"], ["b1"], []]);
  });

  it("keeps steps under deeper sub-headings with the task", () => {
    const plan = parsePlan(lines("## Task 1: A", "- [ ] a1", "### Notes", "- [x] a2", "#### Deeper", "- [ ] a3"));
    expect(plan.tasks[0]?.steps.map((s) => s.text)).toEqual(["a1", "a2", "a3"]);
  });

  it("ends a task at a heading of the same or higher level that is not a task", () => {
    const plan = parsePlan(lines("### Task 1: A", "- [ ] a1", "### Notes", "- [ ] not a step of 1", "## Phase B", "- [ ] nor this"));
    expect(plan.tasks[0]?.steps.map((s) => s.text)).toEqual(["a1"]);
  });

  it("ignores tasks and steps inside fenced code blocks", () => {
    const plan = parsePlan(
      lines(
        "### Task 1: Real",
        "- [ ] before",
        "```md",
        "### Task 9: Fake",
        "- [ ] fake step",
        "```",
        "~~~",
        "- [x] tilde fake",
        "~~~",
        "- [ ] after",
        "````",
        "```",
        "### Task 8: still fake inside a longer fence",
        "````",
        "### Task 2: Back",
      ),
    );
    expect(plan.tasks.map((t) => [t.n, t.steps.map((s) => s.text)])).toEqual([
      [1, ["before", "after"]],
      [2, []],
    ]);
  });

  it("treats an unclosed fence as running to the end", () => {
    const plan = parsePlan(lines("### Task 1: Real", "- [ ] a", "```", "### Task 2: Fake", "- [ ] b"));
    expect(plan.tasks.map((t) => t.n)).toEqual([1]);
    expect(plan.tasks[0]?.steps).toHaveLength(1);
  });

  it("recognizes an indented fence inside a list item", () => {
    const plan = parsePlan(lines("### Task 1: Real", "- [ ] a", "      ```", "### Task 2: Fake", "      ```", "- [ ] b"));
    expect(plan.tasks.map((t) => t.n)).toEqual([1]);
    expect(plan.tasks[0]?.steps.map((s) => s.text)).toEqual(["a", "b"]);
  });
});

describe("parsePlan limits", () => {
  it("keeps the first 200 tasks", () => {
    const text = Array.from({ length: 250 }, (_, i) => `### Task ${i + 1}: T${i + 1}\n- [ ] s`).join("\n");
    const plan = parsePlan(text);
    expect(plan.tasks).toHaveLength(200);
    expect(plan.tasks[199]?.n).toBe(200);
  });

  it("keeps the first 200 steps of a task", () => {
    const text = `### Task 1: T\n${Array.from({ length: 300 }, (_, i) => `- [ ] s${i}`).join("\n")}`;
    const steps = parsePlan(text).tasks[0]?.steps ?? [];
    expect(steps).toHaveLength(200);
    expect(steps[199]?.text).toBe("s199");
  });

  it("ignores text beyond 512 KB", () => {
    const head = "### Task 1: In\n- [ ] a\n";
    const pad = `${"x".repeat(100)}\n`.repeat(Math.ceil(MAX_PLAN_BYTES / 101));
    const plan = parsePlan(`${head}${pad}### Task 2: Out\n`);
    expect(plan.tasks.map((t) => t.n)).toEqual([1]);
  });

  it("is fast on a very long line", () => {
    const started = performance.now();
    parsePlan(`### Task 1: ${"*a ".repeat(150_000)}\n- [ ] ${"_x ".repeat(150_000)}\n`);
    parsePlan(`${"`".repeat(400_000)}\n${"#".repeat(100_000)}`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("is fast on 10k headings and 10k checkboxes", () => {
    const started = performance.now();
    const heads = Array.from({ length: 10_000 }, (_, i) => `### Task ${i + 1}: T`).join("\n");
    const boxes = Array.from({ length: 10_000 }, () => "- [ ] step").join("\n");
    expect(parsePlan(heads).tasks).toHaveLength(200);
    expect(parsePlan(`### Task 1: T\n${boxes}`).tasks[0]?.steps).toHaveLength(200);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
