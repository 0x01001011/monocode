import { useEffect, useRef, useState } from "react";
import { Check } from "../../../shared/ui/icons";
import type { Session } from "../../sessions/model/session";
import { useTaskBoard } from "../hooks/useTaskBoard";
import { planFilePath } from "../model/planRoot";
import { progressLine } from "../model/progress";
import type { StatusAction, StatusCard, StatusKind, StatusSessionInput } from "../model/statusCard";
import type { BoardNode, BoardNote, BoardSection } from "../model/taskBoard";
import { actionLabel } from "./StatusCard";
import { TaskBoardNotes } from "./TaskBoardNotes";
import { TaskRow } from "./TaskBoardRows";
import { TaskGlyph, type GlyphKind } from "./TaskGlyph";

type Props = {
  projectCwd: string;
  /** The working copy the plan workspaces are read from; defaults to `projectCwd`. */
  planCwd?: string;
  session?: Session;
  sessions: readonly StatusSessionInput[];
  /** False while the tab is hidden or covered: no fast polling and no clock tick. */
  visible?: boolean;
  /** How long a busy session may stay silent before the status card calls it quiet. */
  quietAfterMs?: number;
  onAction?: (action: StatusAction, card: StatusCard) => void;
  onOpenNode?: (node: BoardNode, section: BoardSection) => void;
  onOpenPlan?: (path: string) => void;
  onChangeDecision?: (note: BoardNote) => void;
};

const TICK_MS = 1000;
const FOCUS = "outline-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-focus";
const BUTTON = `min-h-6 rounded-md px-2 text-[11.5px] whitespace-nowrap text-muted hover:bg-selection-subtle ${FOCUS}`;
const HEADERS = ["Status", "Task", "What happened", "Time"];

const HEADER_GLYPH: Record<StatusKind, GlyphKind> = {
  "needs-you": "ask",
  struggling: "struggling",
  quiet: "quiet",
  running: "running",
  done: "done",
  idle: "pending",
};

function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="px-4 pt-3.5 pb-4.5 leading-normal">
      <h2 className="m-0 mb-1.5 text-[14px] font-semibold">Nothing to track yet</h2>
      <p className="m-0 text-[12.5px] text-muted">
        {loading
          ? "Looking for tasks…"
          : "When the agent works through a plan, each task shows up here with its status and time."}
      </p>
    </div>
  );
}

const STRUGGLING_FROM_ROUND = 3;

/** The task the reviewer keeps sending back (fix round 3 or more), the worst first. */
function strugglingNode(plan: BoardSection): BoardNode | undefined {
  return plan.nodes
    .filter((n) => n.status !== "done" && (n.fixRounds ?? 0) >= STRUGGLING_FROM_ROUND)
    .sort((a, b) => (b.fixRounds ?? 0) - (a.fixRounds ?? 0))[0];
}

/** Scrolls a heading to the top of the view and moves focus to it; reduced motion jumps instead. */
function revealHeading(heading: Element | null | undefined) {
  if (!(heading instanceof HTMLElement)) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  heading.scrollIntoView?.({ block: "start", behavior: reduce ? "auto" : "smooth" });
  heading.focus({ preventScroll: true });
}

/** The whole plan as a table: every task, the final review, then decisions and small issues. */
export function TaskBoardView({ projectCwd, planCwd = projectCwd, session, sessions, visible = true, quietAfterMs, onAction, onOpenNode, onOpenPlan, onChangeDecision }: Props) {
  // Nothing reads a hidden board tab (the sidebar owns the badge and alerts), so it never polls hidden.
  const board = useTaskBoard({
    projectCwd,
    planCwd,
    ...(session ? { activeSession: session } : {}),
    sessions,
    visible,
    needsStatusWhenHidden: false,
    ...(quietAfterMs !== undefined ? { quietAfterMs } : {}),
  });
  const card = board.statusCard;
  const plan = board.plan;
  const notesRef = useRef<HTMLDivElement>(null);
  const [reveal, setReveal] = useState<{ id: string; token: number }>();
  const running = visible && (sessions.some((s) => s.busy) || (card.kind !== "idle" && card.kind !== "done"));

  // The tab owns its clock so a tick re-renders only this view; it ticks only while it is shown and work runs.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [running]);

  if (!plan) {
    return (
      <div className="h-full overflow-auto">
        <EmptyState loading={board.loading} />
      </div>
    );
  }

  const final = plan.finalReview;
  const rows = final ? [...plan.nodes, final] : plan.nodes;
  const parkedFor = new Set((plan.parked ?? []).flatMap((n) => (n.taskIndex !== undefined ? [n.taskIndex] : [])));
  // Hide actions the plan cannot back: no decisions means nothing to review.
  const actions = card.actions.filter((a) => a !== "review-decisions" || (plan.decisions?.length ?? 0) > 0);
  // These two buttons point at the notes below the table, so they bring them into view.
  const handleAction = (action: StatusAction, target: StatusCard) => {
    if (action === "see-issues" || action === "review-decisions") {
      // The open findings of a struggling task live in its row, not in the small issues.
      const stuck = action === "see-issues" ? strugglingNode(plan) : undefined;
      if (stuck) {
        setReveal((prev) => ({ id: stuck.id, token: (prev?.token ?? 0) + 1 }));
        return;
      }
      const notes = notesRef.current;
      const wanted = action === "review-decisions" ? ["decisions"] : ["issues", "decisions"];
      const heading = wanted.map((name) => notes?.querySelector(`[data-notes="${name}"]`)).find(Boolean);
      revealHeading(heading ?? notes);
      return;
    }
    onAction?.(action, target);
  };
  const issues = [...(plan.minors ?? []), ...(plan.parked ?? []).map((n) => ({ ...n, parked: true }))];

  return (
    <div className="h-full overflow-auto">
      <header className="flex items-start gap-2.5 px-4 pt-3.5 pb-2.5">
        {card.kind !== "idle" ? (
          <span className="mt-0.5 shrink-0">
            <TaskGlyph kind={HEADER_GLYPH[card.kind]} />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-[14px] leading-[1.3] font-semibold text-content">
            {/* Remounted per kind, so an alert that replaces a status is announced. */}
            <span key={card.kind} role={card.kind === "needs-you" ? "alert" : undefined}>
              {card.headline || plan.title}
            </span>
            {card.reassurance ? (
              <>
                {" · "}
                <span className="inline-flex items-center gap-1 font-normal text-success">
                  <Check className="size-3" strokeWidth={2.5} aria-hidden="true" />
                  {card.reassurance}
                </span>
              </>
            ) : null}
          </h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted tabular-nums">
            {board.workspaces.length > 1 ? (
              <select
                aria-label="Plan"
                value={board.selectedWorkspace}
                onChange={(e) => board.selectWorkspace(e.target.value)}
                className={`min-h-6 rounded-md bg-transparent text-[11.5px] ${FOCUS}`}
              >
                {board.workspaces.map((w) => (
                  <option key={w.slug} value={w.slug}>
                    {w.slug}
                  </option>
                ))}
              </select>
            ) : null}
            <span>
              {board.workspaces.length > 1 ? "" : `${plan.title} · `}
              {progressLine(plan, now)}
            </span>
          </div>
          {actions.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {actions.map((action) => (
                <button key={action} type="button" onClick={() => handleAction(action, card)} className={BUTTON}>
                  {actionLabel(action, card)}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {plan.planPath ? (
          <button
            type="button"
            title={plan.planPath}
            onClick={() => plan.planPath && onOpenPlan?.(planFilePath(planCwd, plan.planPath))}
            className={`${BUTTON} shrink-0 bg-selection text-content`}
          >
            Open plan
          </button>
        ) : null}
      </header>
      <table aria-label="Plan tasks" className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-stroke text-[11.5px] text-muted">
            {HEADERS.map((name, i) => (
              <th
                key={name}
                scope="col"
                className={`py-1.5 font-normal ${i === 0 ? "w-11 pl-3" : "pr-3"} ${i === HEADERS.length - 1 ? "w-24 text-right" : ""}`}
              >
                {i === 0 ? <span className="sr-only">{name}</span> : name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((node) => (
            <TaskRow
              key={node.id}
              node={node}
              section={plan}
              now={now}
              hasParked={node.index !== undefined && parkedFor.has(node.index)}
              onOpenNode={onOpenNode}
              {...(reveal?.id === node.id ? { revealToken: reveal.token } : {})}
            />
          ))}
        </tbody>
      </table>
      <div ref={notesRef} tabIndex={-1} className="outline-none">
        <TaskBoardNotes decisions={plan.decisions ?? []} issues={issues} onChangeDecision={onChangeDecision} />
      </div>
    </div>
  );
}
