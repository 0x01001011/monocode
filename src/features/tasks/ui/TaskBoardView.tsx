import { useEffect, useState } from "react";
import { Check } from "../../../shared/ui/icons";
import type { Session } from "../../sessions/model/session";
import { useTaskBoard } from "../hooks/useTaskBoard";
import { progressLine } from "../model/progress";
import type { StatusAction, StatusCard, StatusKind, StatusSessionInput } from "../model/statusCard";
import type { BoardNode, BoardNote, BoardSection } from "../model/taskBoard";
import { actionLabel } from "./StatusCard";
import { TaskBoardNotes } from "./TaskBoardNotes";
import { TaskRow } from "./TaskBoardRows";
import { TaskGlyph, type GlyphKind } from "./TaskGlyph";

type Props = {
  projectCwd: string;
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
const FOCUS = "outline-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent";
const BUTTON = `min-h-6 rounded-md px-2 text-[11.5px] whitespace-nowrap text-content/66 hover:bg-selection-subtle ${FOCUS}`;
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
      <p className="m-0 text-[12.5px] text-content/66">
        {loading
          ? "Looking for tasks…"
          : "When the agent works through a plan, each task shows up here with its status and time."}
      </p>
    </div>
  );
}

/** The whole plan as a table: every task, the final review, then decisions and small issues. */
export function TaskBoardView({ projectCwd, session, sessions, visible = true, quietAfterMs, onAction, onOpenNode, onOpenPlan, onChangeDecision }: Props) {
  const board = useTaskBoard({ projectCwd, ...(session ? { activeSession: session } : {}), sessions, visible, ...(quietAfterMs !== undefined ? { quietAfterMs } : {}) });
  const card = board.statusCard;
  const plan = board.plan;
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
            <span role={card.kind === "needs-you" ? "alert" : undefined}>{card.headline || plan.title}</span>
            {card.reassurance ? (
              <>
                {" · "}
                <span className="inline-flex items-center gap-1 font-normal text-diff-add">
                  <Check className="size-3" strokeWidth={2.5} aria-hidden="true" />
                  {card.reassurance}
                </span>
              </>
            ) : null}
          </h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-content/66 tabular-nums">
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
                <button key={action} type="button" onClick={() => onAction?.(action, card)} className={BUTTON}>
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
            onClick={() => plan.planPath && onOpenPlan?.(plan.planPath)}
            className={`${BUTTON} shrink-0 bg-selection text-content`}
          >
            Open plan
          </button>
        ) : null}
      </header>
      <table aria-label="Plan tasks" className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-stroke text-[11.5px] text-content/66">
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
            />
          ))}
        </tbody>
      </table>
      <TaskBoardNotes decisions={plan.decisions ?? []} issues={issues} onChangeDecision={onChangeDecision} />
    </div>
  );
}
