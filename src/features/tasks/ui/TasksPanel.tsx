import { useEffect, useLayoutEffect, useReducer, useRef, useState, type RefObject } from "react";
import { MoreHorizontal } from "../../../shared/ui/icons";
import type { TaskBoard } from "../hooks/useTaskBoard";
import { buildGraph, type GraphFilter as Filter, type GraphRow } from "../model/graph";
import { planOverview } from "../model/overview";
import { shipReadiness } from "../model/ship";
import { strugglingNode, type StatusAction, type StatusCard as StatusCardData } from "../model/statusCard";
import { planSummaryMarkdown } from "../model/summary";
import type { BoardNode, BoardNote, BoardSection } from "../model/taskBoard";
import { FlowStrip } from "./FlowStrip";
import { GraphFilter } from "./GraphFilter";
import { NoteGroups, type NoteGroupId } from "./NoteGroups";
import { PlanOverview } from "./PlanOverview";
import { ShipNode } from "./ShipNode";
import { StatusCard } from "./StatusCard";
import { TaskGlyph, type GlyphKind } from "./TaskGlyph";
import { TaskGraph } from "./TaskGraph";
import { glyphFor, TaskTree } from "./TaskTree";
import type { TreeReveal } from "./treeFocus";

type Props = {
  board: TaskBoard;
  now: number;
  onAction?: (action: StatusAction, card: StatusCardData) => void;
  onOpenNode?: (node: BoardNode, section: BoardSection) => void;
  /** Opens a spec or plan file; `path` is relative to the plan root, as the ledger wrote it. */
  onOpenFile?: (path: string) => void;
  /** "Change this" on a decision the agent made. */
  onChangeDecision?: (note: BoardNote) => void;
  /** Copies text (a summary or a sha); defaults to the system clipboard. */
  onCopy?: (text: string) => void | Promise<void>;
};

/** A status card button the plan answers itself; a new `token` is a new ask. */
type CardRequest = { action: "see-issues" | "review-decisions"; token: number };

const FOCUS = "focus-visible:focus-ring-inset";
const SMALL_BUTTON = `min-h-6 rounded-md px-2 text-[11.5px] text-muted hover:bg-selection-subtle ${FOCUS}`;
const SHIP_ID = "ship";
const COPIED_MS = 2000;
const COPIED = "Copied";

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
const KEYS = "On a row: o opens, c copies the commit, n jumps to now";

const isActive = (node: BoardNode) => node.status === "running" || node.status === "attention";

/** Scrolls a heading to the top of the view and moves focus to it; reduced motion jumps instead. */
function revealHeading(heading: Element | null | undefined) {
  if (!(heading instanceof HTMLElement)) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  heading.scrollIntoView?.({ block: "start", behavior: reduce ? "auto" : "smooth" });
  heading.focus({ preventScroll: true });
}

/** Whether `ref` is on screen; true until an observer says otherwise, and always without one. */
function useInView(ref: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setInView(last.isIntersecting);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return inView;
}

/** Copies through `onCopy` (else the clipboard) and says how it went for two seconds. */
function useCopy(onCopy: Props["onCopy"]) {
  const [notice, setNotice] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = (text: string) => {
    setNotice(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(""), COPIED_MS);
  };
  const copy = (text: string) => {
    try {
      const result = onCopy ? onCopy(text) : navigator.clipboard.writeText(text);
      if (result instanceof Promise) result.then(() => show(COPIED), () => show("Could not copy"));
      else show(COPIED);
    } catch {
      show("Could not copy");
    }
  };
  return { notice, copy };
}

function Legend() {
  return (
    <div className="mx-3 mb-1 rounded-md bg-selection-subtle p-2 text-[11.5px] text-muted">
      <ul aria-label="Symbol legend" role="list" className="m-0 list-none p-0">
        {LEGEND.map(([kind, text]) => (
          <li key={kind} className="flex min-h-6 items-center gap-2">
            <TaskGlyph kind={kind} small />
            <span>{text}</span>
          </li>
        ))}
        <li className="flex min-h-6 items-center pt-1">{KEYS}</li>
      </ul>
    </div>
  );
}

type PlanBlockProps = Pick<Props, "board" | "now" | "onOpenNode" | "onOpenFile" | "onChangeDecision" | "onCopy"> & {
  plan: BoardSection;
  filter: Filter;
  onFilter: (filter: Filter) => void;
  request?: CardRequest;
};

function PlanBlock({ board, plan, now, filter, onFilter, request, onOpenNode, onOpenFile, onChangeDecision, onCopy }: PlanBlockProps) {
  const [legend, setLegend] = useState(false);
  const [menu, setMenu] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState<Partial<Record<NoteGroupId, boolean>>>({});
  // A problem, gap or ship item asks the graph to open that row and focus it; a new token is a new ask.
  const [reveal, setReveal] = useState<TreeReveal>();
  // The running task opens by itself (and the next one when it starts), Ship once every task is
  // done; a user toggle wins.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const sentinel = useRef<HTMLDivElement>(null);
  const headerInView = useInView(sentinel);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuItem = useRef<HTMLButtonElement>(null);
  const groupsRef = useRef<HTMLDivElement>(null);
  const { notice, copy } = useCopy(onCopy);

  const finished = plan.total > 0 && plan.done >= plan.total;
  const final = plan.finalReview;
  const nowNode = plan.nodes.find(isActive) ?? (final && isActive(final) ? final : undefined);
  const isExpanded = (id: string) => toggled.get(id) ?? (id === nowNode?.id || (id === SHIP_ID && finished));
  const expandedIds = new Set([...toggled].filter(([, open]) => open).map(([id]) => id));
  for (const id of [nowNode?.id, SHIP_ID]) if (id !== undefined && isExpanded(id)) expandedIds.add(id);

  const ship = board.ship ?? shipReadiness(plan, board.testRun);
  const workers = board.sections
    .filter((s) => s.source === "agents" || s.source === "orchestration")
    .flatMap((s) => s.nodes.filter((n) => n.status === "running"));
  const graph = buildGraph({ section: plan, gaps: board.gaps, ship, expanded: expandedIds, filter, now, workers });
  const overview = planOverview(plan);
  const deferred = [...(plan.minors ?? []), ...(plan.parked ?? []).map((n) => ({ ...n, parked: true }))];
  const decisions = plan.decisions ?? [];
  const groupCounts: Record<NoteGroupId, number> = { deferred: deferred.length, gaps: board.gaps.length, decisions: decisions.length };
  const groupOpen = (id: NoteGroupId) => groupsOpen[id] ?? (id === "decisions" && !finished);

  const onToggle = (id: string) => setToggled((prev) => new Map(prev).set(id, !isExpanded(id)));
  // Opens the row the user asked about, so the reason is on screen when focus lands on it. A row
  // the filter hides (folded into a hidden row) brings every row back first.
  const onReveal = (id: string) => {
    if (filter !== "all" && !graph.rows.some((r) => r.id === id)) onFilter("all");
    setToggled((prev) => new Map(prev).set(id, true));
    setReveal((prev) => ({ id, token: (prev?.token ?? 0) + 1 }));
  };
  // A ship item points at a row only when the plan has it (a plan without a final review has no row for it).
  const rowIds = new Set([...plan.nodes.map((n) => n.id), ...(final ? [final.id] : [])]);
  const shipShown = {
    ...ship,
    items: ship.items.map(({ nodeId, ...item }) => (nodeId !== undefined && rowIds.has(nodeId) ? { ...item, nodeId } : item)),
  };

  const sectionOf = (node: BoardNode) => board.sections.find((s) => s.nodes.includes(node)) ?? plan;
  const onOpenRow = (row: GraphRow) => {
    if (row.node) onOpenNode?.(row.node, sectionOf(row.node));
  };
  // A stage row has no node of its own: its commit belongs to its task (or the final review).
  const onOpenCommit = (row: GraphRow, sha: string) => {
    const node = row.node ?? graph.rows.find((r) => r.id === row.parentId)?.node ?? final;
    if (node) onOpenNode?.({ ...node, target: { kind: "commit", ref: sha } }, sectionOf(node));
  };
  const copySummary = () => copy(planSummaryMarkdown(plan, ship, board.gaps));

  const closeMenu = () => {
    setMenu(false);
    menuButton.current?.focus();
  };
  useLayoutEffect(() => {
    if (menu) menuItem.current?.focus();
  }, [menu]);
  // A press anywhere outside the menu and its button closes it.
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (menuRef.current?.contains(target) || menuButton.current?.contains(target)) return;
      setMenu(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menu]);

  // The status card's See the open issues and Review decisions are answered here.
  const lastRequest = useRef(request?.token);
  useLayoutEffect(() => {
    if (!request || request.token === lastRequest.current) return;
    lastRequest.current = request.token;
    const stuck = request.action === "see-issues" ? strugglingNode(plan) : undefined;
    if (stuck) {
      onReveal(stuck.id);
      return;
    }
    // The open issues are the deferred items, then the gaps; decisions are not issues.
    const order: NoteGroupId[] = request.action === "review-decisions" ? ["decisions"] : ["deferred", "gaps"];
    const group = order.find((id) => groupCounts[id] > 0);
    if (!group) {
      const problem = request.action === "see-issues" ? overview.problems[0] : undefined;
      if (problem) onReveal(problem.id);
      return;
    }
    setGroupsOpen((prev) => ({ ...prev, [group]: true }));
    revealHeading(groupsRef.current?.querySelector(`[data-notes="${group}"]`));
    // Only a new token asks; a re-render with the same request must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.token]);

  // From the plan, not the visible rows, so a filter never empties it; steps only, no ticking time.
  const nowSteps = nowNode?.steps ?? [];
  const barText = [
    nowNode ? (nowNode.index !== undefined ? `Task ${nowNode.index}` : nowNode.title) : plan.title,
    ...(nowSteps.length > 0 ? [`${nowSteps.filter((step) => step.done).length}/${nowSteps.length}`] : []),
    ...(overview.left > 0 ? [`${overview.left} left`] : []),
  ].join(" · ");

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-2 pr-2 pl-3">
        {board.workspaces.length > 1 ? (
          <select
            aria-label="Plan"
            value={board.selectedWorkspace}
            onChange={(e) => board.selectWorkspace(e.target.value)}
            className={`h-6 min-w-0 flex-1 basis-24 rounded-md bg-transparent text-[12.5px] font-semibold ${FOCUS}`}
          >
            {board.workspaces.map((w) => (
              <option key={w.slug} value={w.slug}>
                {w.slug}
              </option>
            ))}
          </select>
        ) : (
          <span title={plan.title} className="min-w-0 flex-1 basis-24 truncate text-[12.5px] font-semibold">
            {plan.title}
          </span>
        )}
        {/* Under 300 px the group dissolves: the menu and legend buttons stay beside the plan picker
            and the filter takes a line of its own, so two-digit counts never push the tab sideways. */}
        <div className="ml-auto flex shrink-0 items-center gap-1 @max-[300px]:contents">
          <div className="flex @max-[300px]:order-last @max-[300px]:basis-full">
            <GraphFilter value={filter} counts={graph.counts} onChange={onFilter} />
          </div>
          <button
            ref={menuButton}
            type="button"
            aria-label="More plan actions"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
            className={`${SMALL_BUTTON} grid min-w-6 place-items-center px-0`}
          >
            <MoreHorizontal className="size-3.5" strokeWidth={2} aria-hidden="true" />
          </button>
          <button type="button" aria-label="What the symbols mean" aria-expanded={legend} onClick={() => setLegend(!legend)} className={`${SMALL_BUTTON} min-w-6`}>
            ?
          </button>
        </div>
      </div>
      {menu ? (
        // In flow under the header, so the sidebar's scroller can never clip it.
        <div
          ref={menuRef}
          role="menu"
          aria-label="Plan actions"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            closeMenu();
          }}
          onBlur={(e) => {
            const to = e.relatedTarget as Node | null;
            if (to && !e.currentTarget.contains(to) && to !== menuButton.current) setMenu(false);
          }}
          className="mx-3 mt-1 flex flex-col rounded-md bg-selection-subtle p-0.5"
        >
          <button
            ref={menuItem}
            type="button"
            role="menuitem"
            onClick={() => {
              copySummary();
              closeMenu();
            }}
            className={`min-h-6 rounded-[5px] px-2 text-left text-[12.5px] text-content hover:bg-selection ${FOCUS}`}
          >
            Copy summary
          </button>
        </div>
      ) : null}
      {/* Said, not drawn: a line appearing here would push the whole tab down for two seconds. */}
      <div aria-live="polite" className="sr-only">
        {notice}
      </div>
      {legend ? <Legend /> : null}
      {board.flow.length > 0 ? (
        <div className="px-2 pt-1">
          <FlowStrip phases={board.flow} {...(onOpenFile ? { onOpenPath: onOpenFile } : {})} />
        </div>
      ) : null}
      <div className="px-3 pt-1.5 pb-2">
        <PlanOverview section={plan} now={now} onReveal={onReveal} />
      </div>
      <div ref={sentinel} aria-hidden="true" className="h-px" />
      {headerInView ? null : (
        // Takes no room in the flow (-mb-7), so showing it never moves the rows under it.
        <div
          data-sticky-bar
          className="sticky top-0 z-[1] -mb-7 flex h-7 items-center gap-2 border-b border-stroke bg-background-base pr-2 pl-3 text-[12px]"
        >
          <TaskGlyph kind={nowNode ? glyphFor(nowNode) : finished ? "done" : "pending"} small />
          <span data-bar-text className="min-w-0 flex-1 truncate tabular-nums">
            {barText}
          </span>
          {nowNode ? (
            <button type="button" onClick={() => onReveal(nowNode.id)} className={`${SMALL_BUTTON} shrink-0 text-focus`}>
              Jump to now
            </button>
          ) : null}
        </div>
      )}
      <TaskGraph
        graph={graph}
        label="Plan tasks"
        onToggle={onToggle}
        onOpen={onOpenRow}
        onOpenCommit={onOpenCommit}
        onCopySha={copy}
        expandedIds={expandedIds}
        {...(reveal ? { reveal } : {})}
      />
      <ShipNode
        ship={shipShown}
        tasks={plan.total}
        {...(plan.steps ? { steps: plan.steps.total } : {})}
        open={isExpanded(SHIP_ID)}
        onToggle={() => onToggle(SHIP_ID)}
        onReveal={onReveal}
        onCopySummary={copySummary}
        copied={notice === COPIED}
      />
      <div ref={groupsRef} className="mt-2">
        <NoteGroups
          deferred={deferred}
          gaps={board.gaps}
          decisions={decisions}
          open={{ deferred: groupOpen("deferred"), gaps: groupOpen("gaps"), decisions: groupOpen("decisions") }}
          onToggle={(id) => setGroupsOpen((prev) => ({ ...prev, [id]: !groupOpen(id) }))}
          onReveal={onReveal}
          {...(onChangeDecision ? { onChangeDecision } : {})}
        />
      </div>
    </>
  );
}

function SectionBlock({ section, label, now, onOpenNode }: { section: BoardSection; label: string; now: number; onOpenNode: Props["onOpenNode"] }) {
  return (
    <div>
      <div className="px-3 pt-2.5 pb-0.5 text-[11.5px] text-muted tabular-nums">
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
      <p className="m-0 mb-2.5 text-[12.5px] text-muted">
        When the agent works through a plan or hands work to other agents, each task shows up here with its status and time.
      </p>
      <ul className="m-0 pl-4 text-[12.5px] text-muted">
        <li>Plans run with superpowers</li>
        <li>Todo lists the agent writes</li>
        <li>Subagents and orchestration workers</li>
      </ul>
    </div>
  );
}

/**
 * The Tasks tab: status card, then the plan as one view (pipeline header, filter, commit graph,
 * Ship checklist and note groups), then the other sections as trees.
 */
export function TasksPanel({ board, now, onAction, onOpenNode, onOpenFile, onChangeDecision, onCopy }: Props) {
  const plan = board.plan;
  const rest = board.sections.filter((s) => s !== plan);
  const agents = rest.filter((s) => s.source === "agents");
  const others = rest.filter((s) => s.source !== "agents");

  // The filter is kept per plan for the session.
  const filters = useRef(new Map<string, Filter>());
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const planKey = board.selectedWorkspace ?? plan?.id ?? "";
  const filter = filters.current.get(planKey) ?? "all";
  const setFilter = (next: Filter) => {
    filters.current.set(planKey, next);
    rerender();
  };

  const [request, setRequest] = useState<CardRequest>();

  // Hide actions the plan cannot back: no decisions means nothing to review.
  const raw = board.statusCard;
  const card =
    raw.actions.includes("review-decisions") && !plan?.decisions?.length
      ? { ...raw, actions: raw.actions.filter((a) => a !== "review-decisions") }
      : raw;

  // The notes these two buttons point at are the plan's own groups, so the plan answers them.
  const handleAction: typeof onAction = (action, target) => {
    if (action === "see-issues" || action === "review-decisions") {
      setRequest((prev) => ({ action, token: (prev?.token ?? 0) + 1 }));
    } else {
      onAction?.(action, target);
    }
  };

  const empty = board.sections.length === 0 && card.kind === "idle";
  return (
    // scroll-pt-8: a row or heading scrolled into view lands below the 28 px sticky bar, not under it.
    <div className="@container flex min-h-0 flex-1 scroll-pt-8 flex-col overflow-auto pt-0.5 pb-3.5">
      <StatusCard card={card} onAction={handleAction} />
      {board.planFilesUnavailable ? (
        <div className="px-4 pt-1 text-[11.5px] text-muted">Plan files are not available for remote projects yet.</div>
      ) : null}
      {plan ? (
        <PlanBlock
          // Another plan starts with its own toggles, groups and menu.
          key={planKey}
          board={board}
          plan={plan}
          now={now}
          filter={filter}
          onFilter={setFilter}
          {...(request ? { request } : {})}
          onOpenNode={onOpenNode}
          onOpenFile={onOpenFile}
          onChangeDecision={onChangeDecision}
          onCopy={onCopy}
        />
      ) : null}
      {agents.map((section) => (
        <SectionBlock key={section.id} section={section} label="Other agents here" now={now} onOpenNode={onOpenNode} />
      ))}
      {others.map((section) => (
        <SectionBlock key={section.id} section={section} label={section.title} now={now} onOpenNode={onOpenNode} />
      ))}
      {empty && board.loading ? <div className="px-4 pt-3.5 text-[12.5px] text-muted">Looking for tasks…</div> : null}
      {empty && !board.loading ? <EmptyState /> : null}
    </div>
  );
}
