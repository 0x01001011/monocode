import type { FlowPhase } from "../model/flow";
import { glyphForStatus, TaskGlyph } from "./TaskGlyph";

type Props = {
  phases: readonly FlowPhase[];
  /** Opens a phase's file (Spec and Plan). A phase without a `path` is plain text. */
  onOpenPath?: (path: string) => void;
};

const FOCUS = "outline-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-focus";

/** Needs a look first (what is moving or stuck), then what is next. Otherwise nothing is current. */
function currentIndex(phases: readonly FlowPhase[]): number {
  const active = phases.findIndex((p) => p.status === "running" || p.status === "attention" || p.status === "failed" || p.status === "blocked");
  return active >= 0 ? active : phases.findIndex((p) => p.status === "pending");
}

/**
 * Where the superpowers flow stands, as one wrapping line: `Spec › Plan › Build › Check`.
 * The glyph comes first on screen but after the label in the document, so a screen reader
 * says "Build, running, 3 of 6" and the glyph's own label is the only status word.
 */
export function FlowStrip({ phases, onOpenPath }: Props) {
  if (phases.length === 0) return null;
  const current = currentIndex(phases);
  return (
    <ol aria-label="Superpowers flow" className="m-0 flex list-none flex-wrap items-center gap-x-1.5 p-0 text-[11.5px] text-muted tabular-nums">
      {phases.map((phase, i) => {
        const here = i === current;
        const weight = here ? "font-semibold" : "";
        const glyph = (
          <span className="order-first inline-flex">
            <TaskGlyph kind={glyphForStatus(phase.status)} small />
          </span>
        );
        const path = phase.path;
        return (
          <li key={phase.id} {...(here ? { "aria-current": "step" as const } : {})} className="flex min-w-0 items-start gap-1.5">
            {path !== undefined && onOpenPath ? (
              <button
                type="button"
                title={path}
                onClick={() => onOpenPath(path)}
                className={`inline-flex min-h-6 shrink-0 items-center gap-1 rounded-md px-1 text-focus hover:bg-selection-subtle ${weight} ${FOCUS}`}
              >
                {phase.label}
                {glyph}
              </button>
            ) : (
              <span className={`inline-flex min-h-6 shrink-0 items-center gap-1 px-1 text-content ${weight}`}>
                {phase.label}
                {glyph}
              </span>
            )}
            {/* The separator ends the detail's last line, so a wrapped detail never strands it. */}
            {phase.detail || i < phases.length - 1 ? (
              <span className="min-w-0 py-1 leading-4">
                {phase.detail}
                {i < phases.length - 1 ? (
                  <span aria-hidden="true" className={phase.detail ? "ml-1.5" : ""}>
                    ›
                  </span>
                ) : null}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
