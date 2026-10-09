export type PlanStep = { text: string; done: boolean };
export type PlanTask = { n: number; title: string; steps: PlanStep[] };
export type ParsedPlan = { title?: string; tasks: PlanTask[] };

/** Input beyond this many characters is ignored (the loader skips larger files outright). */
export const MAX_PLAN_BYTES = 512 * 1024;
export const MAX_PLAN_TASKS = 200;
export const MAX_TASK_STEPS = 200;
export const MAX_PLAN_TEXT = 200;
/** A raw line is cut here before any inline matching, so a hostile line cannot be slow. */
const MAX_RAW_LINE = 1000;

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const CLOSING_HASHES = /(?:^|[ \t]+)#+[ \t]*$/;
const TASK_HEADING = /^Task\s+(\d{1,6})\s*[:.)–—-](?!\d)\s*(.*)$/i;
const CHECKBOX = /^ {0,2}(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\][ \t]+(.*)$/;
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const STEP_LABEL = /^Step\s+\d+\s*[:.)–—-]\s*/i;

/** Removes `**x**`, `__x__`, `*x*`, `_x_`, `~~x~~` and backticks, keeping the words. */
function stripEmphasis(raw: string): string {
  return raw
    .replace(/(\*\*)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/g, "$1")
    .replace(/(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\w_])/g, "$1")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replace(/`+/g, "");
}

function clean(raw: string): string {
  const text = stripEmphasis(raw.length > MAX_RAW_LINE ? raw.slice(0, MAX_RAW_LINE) : raw)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_PLAN_TEXT ? text.slice(0, MAX_PLAN_TEXT).trimEnd() : text;
}

/**
 * Reads a superpowers plan file: its tasks (`### Task 3: Title`, any heading level) and each
 * task's top-level checkbox steps, with their ticked state. Never throws; input past 512 KB,
 * 200 tasks or 200 steps per task is ignored. Headings and checkboxes inside fenced code
 * blocks are not plan content.
 */
export function parsePlan(text: string): ParsedPlan {
  const lines = (text.length > MAX_PLAN_BYTES ? text.slice(0, MAX_PLAN_BYTES) : text).split(/\r\n|\r|\n/);
  const tasks: PlanTask[] = [];
  const seen = new Set<number>();
  let title: string | undefined;
  let current: PlanTask | undefined;
  let currentLevel = 0;
  let fence: { char: string; length: number } | undefined;

  for (const line of lines) {
    const hasFenceMark = line.includes("```") || line.includes("~~~");
    if (fence) {
      if (hasFenceMark) {
        const close = FENCE_OPEN.exec(line);
        if (close && close[1][0] === fence.char && close[1].length >= fence.length && close[2].trim() === "") {
          fence = undefined;
        }
      }
      continue;
    }
    if (hasFenceMark) {
      const open = FENCE_OPEN.exec(line);
      // A backtick fence's info string cannot hold a backtick (that is inline code).
      if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
        fence = { char: open[1][0], length: open[1].length };
        continue;
      }
    }

    const c = line.charCodeAt(0);
    if (c === 35 /* # */ || c === 32 /* space */) {
      const heading = HEADING.exec(line);
      if (heading) {
        const level = heading[1].length;
        const inner = clean((heading[2] ?? "").replace(CLOSING_HASHES, ""));
        const task = TASK_HEADING.exec(inner);
        if (task) {
          const n = Number(task[1]);
          currentLevel = level;
          if (seen.has(n) || tasks.length >= MAX_PLAN_TASKS) {
            current = undefined;
          } else {
            seen.add(n);
            current = { n, title: task[2] || `Task ${n}`, steps: [] };
            tasks.push(current);
          }
          continue;
        }
        if (level === 1 && title === undefined && inner) title = inner;
        if (current && level <= currentLevel) current = undefined;
        continue;
      }
    }

    if (!current || current.steps.length >= MAX_TASK_STEPS) continue;
    const box = CHECKBOX.exec(line);
    if (!box) continue;
    const step = clean(box[2]).replace(STEP_LABEL, "").trim();
    if (step) current.steps.push({ text: step, done: box[1] !== " " });
  }
  return { ...(title !== undefined ? { title } : {}), tasks };
}
