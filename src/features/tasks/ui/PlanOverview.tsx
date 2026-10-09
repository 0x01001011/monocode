import { useState } from "react";
import { planOverview, type PlanOverview as Overview } from "../model/overview";
import { timeLine } from "../model/progress";
import type { BoardSection, BoardStatus } from "../model/taskBoard";
import { TaskGlyph, type GlyphKind } from "./TaskGlyph";

type Props = {
  section: BoardSection;
  now: number;
  /** A problem button was activated: bring that task's row into view. */
  onReveal: (id: string) => void;
  /** Caps the strip's width for wide hosts such as the full tab. */
  compact?: boolean;
};

// The design-system inset ring (see `focus-ring-inset` in styles/index.css), kept inside the pill. Never pair
// it with `outline-none`: in Tailwind 4 that sets the outline style to none, so no ring shows.
const FOCUS = "focus-visible:focus-ring-inset";
const SHOWN_PROBLEMS = 3;

/** Status tokens; a task that has not started is the muted track. Only colour animates. */
const SEGMENT_CLASS: Record<BoardStatus, string> = {
  done: "bg-success",
  running: "bg-focus",
  attention: "bg-warning",
  failed: "bg-danger",
  blocked: "bg-danger",
  pending: "bg-muted/30",
  cancelled: "bg-muted/50",
};

/** The strip's words, in the order a reader scans: what is done first, what is stuck last. */
const STATUS_WORDS: [BoardStatus, string][] = [
  ["done", "done"],
  ["running", "running"],
  ["attention", "needs a look"],
  ["failed", "failed"],
  ["blocked", "blocked"],
  ["pending", "not started"],
  ["cancelled", "cancelled"],
];

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

function countsLine(o: Overview): string {
  const { tasks, steps, left } = o;
  const parts = [`${tasks.done} of ${tasks.total} ${plural(tasks.total, "task")}`];
  if (left === 0) {
    // All done: the steps are a total, not a progress.
    if (steps) parts.push(`${steps.total} ${plural(steps.total, "step")}`);
    return parts.join(" · ");
  }
  // One thing left is named: the last review when every task is done, else the task.
  parts.push(left === 1 ? (tasks.done === tasks.total ? "last review left" : "1 task left") : `${left} left`);
  if (steps) parts.push(`${steps.done} of ${steps.total} ${plural(steps.total, "step")}`);
  return parts.join(" · ");
}

function stripLabel(o: Overview): string {
  return STATUS_WORDS.flatMap(([status, word]) => {
    const n = o.segments.filter((s) => s.status === status).length;
    return n > 0 ? [`${n} ${word}`] : [];
  }).join(", ");
}

/** The mark a problem wears: the same one the tree gives that task. */
function problemGlyph(status: BoardStatus | undefined): GlyphKind {
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  return "struggling";
}

function Problems({
  section,
  problems,
  onReveal,
}: {
  section: BoardSection;
  problems: Overview["problems"];
  onReveal: (id: string) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? problems : problems.slice(0, SHOWN_PROBLEMS);
  const hidden = problems.length - SHOWN_PROBLEMS;
  const pill = `inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-md bg-selection-subtle px-2 text-[11.5px] text-content hover:bg-selection ${FOCUS}`;
  return (
    <div data-problems className="flex flex-col gap-1">
      <span className="text-[11.5px] text-muted">Needs a look</span>
      <div className="flex flex-wrap gap-1">
        {shown.map((problem) => (
          <button key={problem.id} type="button" onClick={() => onReveal(problem.id)} className={pill}>
            <TaskGlyph kind={problemGlyph(section.nodes.find((n) => n.id === problem.id)?.status)} small />
            <span className="min-w-0 truncate">
              {problem.label} · {problem.why}
            </span>
          </button>
        ))}
        {hidden > 0 ? (
          <button type="button" aria-expanded={all} onClick={() => setAll(!all)} className={`${pill} text-muted`}>
            {all ? "Show fewer" : `+${hidden} more`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The plan at a glance: counts, time, a segment strip and the tasks in trouble. It replaces the
 * old "3 of 6 done" line. The strip is a summary only; the counts line and the tree say the same
 * in words and glyphs.
 */
export function PlanOverview({ section, now, onReveal, compact = false }: Props) {
  const overview = planOverview(section);
  const time = timeLine(section, now);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5 tabular-nums">
        <div data-counts className="text-[12.5px] text-muted">
          {countsLine(overview)}
        </div>
        {time ? (
          <div data-time className="text-[11.5px] text-muted">
            {time}
          </div>
        ) : null}
      </div>
      {overview.segments.length > 0 ? (
        <div data-strip role="img" aria-label={stripLabel(overview)} className={`flex h-1.5 gap-0.5 ${compact ? "max-w-sm" : ""}`}>
          {overview.segments.map((segment) => (
            <span
              key={segment.id}
              data-status={segment.status}
              {...(segment.status === "pending" ? { "data-track": "" } : {})}
              className={`min-w-px flex-1 rounded-full transition-colors duration-150 ease-out motion-reduce:transition-none ${SEGMENT_CLASS[segment.status]}`}
            />
          ))}
        </div>
      ) : null}
      {overview.problems.length > 0 ? <Problems section={section} problems={overview.problems} onReveal={onReveal} /> : null}
    </div>
  );
}
