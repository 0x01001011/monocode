import { useState } from "react";
import { ChevronDown, ChevronRight } from "../../../shared/ui/icons";
import type { TaskBoard } from "../hooks/useTaskBoard";
import { progressLine } from "../model/progress";
import type { StatusAction, StatusCard as StatusCardData } from "../model/statusCard";
import type { BoardNode, BoardNote, BoardSection } from "../model/taskBoard";
import { StatusCard } from "./StatusCard";
import { TaskGlyph, type GlyphKind } from "./TaskGlyph";
import { TaskTree } from "./TaskTree";

type Props = {
  board: TaskBoard;
  now: number;
  onAction?: (action: StatusAction, card: StatusCardData) => void;
  onOpenNode?: (node: BoardNode, section: BoardSection) => void;
  onOpenAsTab?: () => void;
};

const PREVIEW_NOTES = 3;
const FOCUS = "outline-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent";
const SMALL_BUTTON = `min-h-6 rounded-md px-2 text-[11.5px] text-content/66 hover:bg-selection-subtle ${FOCUS}`;

const LEGEND: [GlyphKind, string][] = [
  ["done", "Done"],
  ["pending", "Not started"],
  ["running", "Running"],
  ["ask", "Needs you: the run is stopped and waits for an answer"],
  ["struggling", "Struggling: the reviewer keeps sending it back"],
  ["quiet", "Quiet: no activity for a while"],
  ["failed", "Failed"],
  ["issues", "Review found issues"],
];

function Legend() {
  return (
    <ul aria-label="Symbol legend" className="m-0 mx-3 mb-1 list-none rounded-md bg-selection-subtle p-2 text-[11.5px] text-content/66">
      {LEGEND.map(([kind, text]) => (
        <li key={kind} className="flex min-h-6 items-center gap-2">
          <TaskGlyph kind={kind} small />
          <span>{text}</span>
        </li>
      ))}
    </ul>
  );
}

function NoteSection({ title, notes, open, onToggle, explainer }: {
  title: string;
  notes: (BoardNote & { parked?: boolean })[];
  open: boolean;
  onToggle: () => void;
  explainer?: string;
}) {
  const [all, setAll] = useState(false);
  if (notes.length === 0) return null;
  const shown = all ? notes : notes.slice(0, PREVIEW_NOTES);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${title}, ${notes.length}`}
        onClick={onToggle}
        className={`mx-1 flex min-h-6.5 w-[calc(100%-8px)] items-center gap-2 rounded-md pr-2 pl-1.5 text-left text-[12.5px] hover:bg-selection-subtle ${FOCUS}`}
      >
        <span aria-hidden="true" className="grid w-3 shrink-0 place-items-center text-content/66">
          {open ? <ChevronDown className="size-3" strokeWidth={2} /> : <ChevronRight className="size-3" strokeWidth={2} />}
        </span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span aria-hidden="true" className="text-[11.5px] text-content/66 tabular-nums">
          {notes.length}
        </span>
      </button>
      {open ? (
        <>
          {explainer ? <div className="pr-3 pb-1.5 pl-8 text-[11.5px] leading-[1.45] text-content/55">{explainer}</div> : null}
          <ul className="m-0 list-none p-0">
            {shown.map((note, i) => (
              <li key={i} className="flex gap-2 py-1 pr-3 pl-8 text-[12.5px] leading-[1.4]">
                <span className="min-w-0 flex-1">{note.text}</span>
                {note.parked ? <span className="text-[11.5px] whitespace-nowrap text-content/55">parked</span> : null}
                {note.taskIndex !== undefined ? (
                  <span className="text-[11.5px] whitespace-nowrap text-content/55">Task {note.taskIndex}</span>
                ) : null}
              </li>
            ))}
          </ul>
          {notes.length > PREVIEW_NOTES ? (
            <div className="pb-1.5 pl-8">
              <button type="button" onClick={() => setAll(!all)} className={`${SMALL_BUTTON} text-accent`}>
                {all ? "Show fewer" : `Show all ${notes.length}`}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function PlanBlock({ board, plan, now, onOpenNode, onOpenAsTab }: Pick<Props, "board" | "now" | "onOpenNode" | "onOpenAsTab"> & { plan: BoardSection }) {
  const [legend, setLegend] = useState(false);
  const [decisionsOpen, setDecisionsOpen] = useState<boolean>();
  const [minorsOpen, setMinorsOpen] = useState(false);
  // The running task opens by itself (and the next one when it starts); a user toggle wins.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const finished = plan.total > 0 && plan.done >= plan.total;
  const final = plan.finalReview;
  const nodes = final && final.status !== "pending" ? [...plan.nodes, final] : plan.nodes;
  const runningId = nodes.find((n) => n.status === "running" || n.status === "attention")?.id;
  const isExpanded = (id: string) => toggled.get(id) ?? id === runningId;
  const expandedIds = new Set([...toggled].filter(([, open]) => open).map(([id]) => id));
  if (runningId !== undefined && isExpanded(runningId)) expandedIds.add(runningId);
  const onToggle = (id: string) => setToggled((prev) => new Map(prev).set(id, !isExpanded(id)));
  const smallIssues = [
    ...(plan.minors ?? []),
    ...(plan.parked ?? []).map((n) => ({ ...n, parked: true })),
  ];
  return (
    <>
      <div className="flex items-center gap-1.5 pt-2 pr-2 pl-3">
        {board.workspaces.length > 1 ? (
          <select
            aria-label="Plan"
            value={board.selectedWorkspace}
            onChange={(e) => board.selectWorkspace(e.target.value)}
            className={`min-h-6 min-w-0 flex-1 rounded-md bg-transparent text-[12.5px] font-semibold ${FOCUS}`}
          >
            {board.workspaces.map((w) => (
              <option key={w.slug} value={w.slug}>
                {w.slug}
              </option>
            ))}
          </select>
        ) : (
          <span title={plan.title} className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
            {plan.title}
          </span>
        )}
        <button type="button" aria-label="What the symbols mean" aria-expanded={legend} onClick={() => setLegend(!legend)} className={`${SMALL_BUTTON} min-w-6`}>
          ?
        </button>
        <button type="button" onClick={onOpenAsTab} className={`${SMALL_BUTTON} whitespace-nowrap`}>
          Open as tab
        </button>
      </div>
      <div className="px-3 pb-1.5 text-[11.5px] text-content/66 tabular-nums">{progressLine(plan, now)}</div>
      {legend ? <Legend /> : null}
      <TaskTree
        nodes={nodes}
        label="Plan tasks"
        now={now}
        onOpen={(node) => onOpenNode?.(node, plan)}
        expandedIds={expandedIds}
        onToggle={onToggle}
      />
      {final?.status === "pending" ? (
        <div className="pt-1.5 pl-8 text-[11.5px] text-content/55">Then one last review of the whole branch.</div>
      ) : null}
      <div className="mt-2.5">
        <NoteSection
          title="Decisions made for you"
          notes={plan.decisions ?? []}
          open={decisionsOpen ?? !finished}
          onToggle={() => setDecisionsOpen(!(decisionsOpen ?? !finished))}
        />
        <NoteSection
          title="Small issues saved for the end"
          notes={smallIssues}
          open={minorsOpen}
          onToggle={() => setMinorsOpen(!minorsOpen)}
          explainer="Small things the reviewer noticed. They are saved and handled together near the end."
        />
      </div>
    </>
  );
}

function SectionBlock({ section, label, now, onOpenNode }: { section: BoardSection; label: string; now: number; onOpenNode: Props["onOpenNode"] }) {
  return (
    <div>
      <div className="px-3 pt-2.5 pb-0.5 text-[11.5px] text-content/55 tabular-nums">
        {label}
        {section.source === "agents" ? "" : ` · ${section.done} of ${section.total}`}
      </div>
      <TaskTree nodes={section.nodes} label={label} now={now} onOpen={(node) => onOpenNode?.(node, section)} />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="px-4 pt-3.5 pb-4.5 leading-normal">
      <h3 className="m-0 mb-1.5 text-[14px] font-semibold">Nothing to track yet</h3>
      <p className="m-0 mb-2.5 text-[12.5px] text-content/66">
        When the agent works through a plan or hands work to other agents, each task shows up here with its status and time.
      </p>
      <ul className="m-0 pl-4 text-[12.5px] text-content/66">
        <li>Plans run with superpowers</li>
        <li>Todo lists the agent writes</li>
        <li>Subagents and orchestration workers</li>
      </ul>
    </div>
  );
}

export function TasksPanel({ board, now, onAction, onOpenNode, onOpenAsTab }: Props) {
  const plan = board.plan;
  const rest = board.sections.filter((s) => s !== plan);
  const agents = rest.filter((s) => s.source === "agents");
  const others = rest.filter((s) => s.source !== "agents");

  // Hide actions the plan cannot back: no decisions means nothing to review.
  const raw = board.statusCard;
  const card =
    raw.actions.includes("review-decisions") && !plan?.decisions?.length
      ? { ...raw, actions: raw.actions.filter((a) => a !== "review-decisions") }
      : raw;

  // The notes these two buttons point at live in the full tab, so they open it.
  const handleAction: typeof onAction = (action, target) => {
    if (action === "see-issues" || action === "review-decisions") onOpenAsTab?.();
    else onAction?.(action, target);
  };

  const empty = board.sections.length === 0 && card.kind === "idle";
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto pt-0.5 pb-3.5">
      <StatusCard card={card} onAction={handleAction} />
      {board.planFilesUnavailable ? (
        <div className="px-4 pt-1 text-[11.5px] text-content/66">Plan files are not available for remote projects yet.</div>
      ) : null}
      {plan ? <PlanBlock board={board} plan={plan} now={now} onOpenNode={onOpenNode} onOpenAsTab={onOpenAsTab} /> : null}
      {agents.map((section) => (
        <SectionBlock key={section.id} section={section} label="Other agents here" now={now} onOpenNode={onOpenNode} />
      ))}
      {others.map((section) => (
        <SectionBlock key={section.id} section={section} label={section.title} now={now} onOpenNode={onOpenNode} />
      ))}
      {empty && board.loading ? <div className="px-4 pt-3.5 text-[12.5px] text-content/66">Looking for tasks…</div> : null}
      {empty && !board.loading ? <EmptyState /> : null}
    </div>
  );
}
