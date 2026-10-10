import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { ChevronDown, ChevronRight } from "../../../shared/ui/icons";
import { durationLabel } from "../model/nodeLabels";
import type { BoardNode, BoardStage, BoardStep } from "../model/taskBoard";
import { TaskGlyph, glyphForStatus, type GlyphKind } from "./TaskGlyph";

export { durationLabel };

type Props = {
  nodes: BoardNode[];
  label: string;
  now: number;
  onOpen?: (node: BoardNode) => void;
  expandedIds?: ReadonlySet<string>;
  onToggle?: (id: string) => void;
  /** Panel-side request (see TasksPanel): a new `token` expands to row `id`, scrolls it into view and focuses it. */
  reveal?: { id: string; token: number };
};

const STRUGGLING_FROM_ROUND = 3;
const MAX_FIX_ROUNDS = 5;

// Only tasks open; stage and step rows are read-only leaves.
type RowKind = "task" | "stage" | "step";
type Child = { node: BoardNode; kind: RowKind };
type Kids = { all: Child[]; stages: Child[]; steps: Child[]; tasks: Child[] };
type Entry = { node: BoardNode; parentId?: string; depth: number; kind: RowKind; index: number };
type KidsOf = (node: BoardNode) => Kids;

// A reveal that has not found its row by then is dropped, so a late render cannot steal focus.
const REVEAL_WINDOW_MS = 500;

function stageNode(parent: BoardNode, stage: BoardStage, index: number): BoardNode {
  return {
    id: `${parent.id}:stage:${index}`,
    title: stage.label,
    status: stage.status,
    startedAt: stage.startedAt,
    endedAt: stage.endedAt,
    summary: stage.verdict,
  };
}

function stepNode(parent: BoardNode, step: BoardStep, index: number): BoardNode {
  return { id: `${parent.id}:step:${index}`, title: step.text, status: step.done ? "done" : "pending" };
}

const tickedCount = (steps: BoardStep[]): number => steps.filter((step) => step.done).length;

// Stages come first (they are the running task's own steps), then the plan's steps, then real
// children. Built once per node per render so ids stay stable and nothing is rebuilt per row.
function childLister(): KidsOf {
  const cache = new Map<BoardNode, Kids>();
  return (node) => {
    let kids = cache.get(node);
    if (!kids) {
      const stages = (node.stages ?? []).map((stage, i): Child => ({ node: stageNode(node, stage, i), kind: "stage" }));
      const steps = (node.steps ?? []).map((step, i): Child => ({ node: stepNode(node, step, i), kind: "step" }));
      const tasks = (node.children ?? []).map((child): Child => ({ node: child, kind: "task" }));
      kids = { all: [...stages, ...steps, ...tasks], stages, steps, tasks };
      cache.set(node, kids);
    }
    return kids;
  };
}

function canExpand(node: BoardNode): boolean {
  return Boolean(node.summary || node.stages?.length || node.steps?.length || node.children?.length);
}

function parentIndex(
  nodes: BoardNode[],
  kidsOf: KidsOf,
  parentId?: string,
  out = new Map<string, string | undefined>(),
) {
  for (const node of nodes) {
    out.set(node.id, parentId);
    parentIndex(kidsOf(node).all.map((c) => c.node), kidsOf, node.id, out);
  }
  return out;
}

export function glyphFor(node: BoardNode): GlyphKind {
  if (node.status === "attention" && (node.fixRounds ?? 0) >= STRUGGLING_FROM_ROUND) return "struggling";
  return glyphForStatus(node.status);
}

function flatten(
  nodes: Child[],
  kidsOf: KidsOf,
  expanded: (id: string) => boolean,
  parentId: string | undefined,
  depth: number,
  out: Entry[],
): Entry[] {
  for (const { node, kind } of nodes) {
    out.push({ node, parentId, depth, kind, index: out.length });
    if (canExpand(node) && expanded(node.id)) flatten(kidsOf(node).all, kidsOf, expanded, node.id, depth + 1, out);
  }
  return out;
}

// A pending task previews its step count; a started one that is not done shows how many are ticked.
function stepsMeta(node: BoardNode): ReactElement | null {
  const total = node.steps?.length ?? 0;
  if (total === 0 || node.status === "done") return null;
  if (node.status === "pending") {
    return (
      <span data-meta="steps" className="text-[11.5px] whitespace-nowrap text-muted">
        {total} {total === 1 ? "step" : "steps"}
      </span>
    );
  }
  const ticked = tickedCount(node.steps ?? []);
  return (
    <span data-meta="progress" className="text-[11.5px] whitespace-nowrap text-muted tabular-nums">
      <span aria-hidden="true">
        {ticked}/{total}
      </span>
      <span className="sr-only">
        {ticked} of {total} steps ticked
      </span>
    </span>
  );
}

export function TaskTree({ nodes, label, now, onOpen, expandedIds, onToggle, reveal }: Props) {
  const [internal, setInternal] = useState<ReadonlySet<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string>();
  const refs = useRef(new Map<string, HTMLLIElement>());

  const expanded = (id: string) => (expandedIds ?? internal).has(id);
  const toggle = (id: string) => {
    if (expandedIds === undefined) {
      setInternal((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      });
    }
    onToggle?.(id);
  };

  const kidsOf = childLister();
  const roots = nodes.map((node): Child => ({ node, kind: "task" }));
  const visible = flatten(roots, kidsOf, expanded, undefined, 0, []);
  const visibleIds = new Set(visible.map((e) => e.node.id));
  // One lookup per render instead of a scan per row; the first entry for an id wins.
  const entryById = new Map<string, Entry>();
  for (const entry of visible) if (!entryById.has(entry.node.id)) entryById.set(entry.node.id, entry);
  let tabId: string | undefined = activeId;
  if (tabId !== undefined && !visibleIds.has(tabId)) {
    const parents = parentIndex(nodes, kidsOf);
    while (tabId !== undefined && !visibleIds.has(tabId)) tabId = parents.get(tabId);
  }
  tabId ??= visible[0]?.node.id;

  // When a collapse removes the focused row, keep focus inside the tree on the ancestor.
  const treeRef = useRef<HTMLUListElement>(null);
  const focusInside = useRef(false);
  useLayoutEffect(() => {
    if (!focusInside.current || tabId === undefined) return;
    if (treeRef.current?.contains(document.activeElement)) return;
    refs.current.get(tabId)?.focus();
  });

  const focusEntry = (entry: Entry | undefined) => {
    if (!entry) return;
    setActiveId(entry.node.id);
    refs.current.get(entry.node.id)?.focus();
  };

  // A reveal asks for ancestors to open, which renders later (a controlled parent updates on its
  // own schedule), so the row is found again after the render that shows it.
  const pendingReveal = useRef<string | undefined>(undefined);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastToken = useRef(reveal?.token);
  const showRow = (id: string): boolean => {
    const item = refs.current.get(id);
    if (!item) return false;
    setActiveId(id);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    // Scroll the row itself: the item also contains its children, which can be far taller.
    (item.firstElementChild as HTMLElement | null)?.scrollIntoView?.({
      block: "nearest",
      behavior: reduce ? "auto" : "smooth",
    });
    item.focus({ preventScroll: true });
    return true;
  };
  useLayoutEffect(() => {
    const id = pendingReveal.current;
    if (id !== undefined && showRow(id)) {
      pendingReveal.current = undefined;
      clearTimeout(revealTimer.current);
    }
  });
  useLayoutEffect(() => {
    if (reveal === undefined || reveal.token === lastToken.current) return;
    lastToken.current = reveal.token;
    const parents = parentIndex(nodes, kidsOf);
    if (!parents.has(reveal.id)) return;
    const closed: string[] = [];
    for (let id = parents.get(reveal.id); id !== undefined; id = parents.get(id)) {
      if (!expanded(id)) closed.push(id);
    }
    if (closed.length === 0) {
      showRow(reveal.id);
      return;
    }
    pendingReveal.current = reveal.id;
    clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(() => {
      pendingReveal.current = undefined;
    }, REVEAL_WINDOW_MS);
    for (const id of closed) toggle(id);
    // Only a new token reveals; a re-render with the same request must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.token]);
  useEffect(() => () => clearTimeout(revealTimer.current), []);

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>, entry: Entry) => {
    if (event.target !== event.currentTarget) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const { index } = entry;
    const { node } = entry;
    const isExpandable = canExpand(node);
    switch (event.key) {
      case "ArrowDown":
        focusEntry(visible[Math.min(index + 1, visible.length - 1)]);
        break;
      case "ArrowUp":
        focusEntry(visible[Math.max(index - 1, 0)]);
        break;
      case "Home":
        focusEntry(visible[0]);
        break;
      case "End":
        focusEntry(visible[visible.length - 1]);
        break;
      case "ArrowRight":
        if (!isExpandable) break;
        if (!expanded(node.id)) toggle(node.id);
        else focusEntry(visible[index + 1]?.parentId === node.id ? visible[index + 1] : undefined);
        break;
      case "ArrowLeft":
        if (isExpandable && expanded(node.id)) toggle(node.id);
        else focusEntry(entry.parentId === undefined ? undefined : entryById.get(entry.parentId));
        break;
      case "Enter":
        if (entry.kind === "task") onOpen?.(node);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const renderRows = (items: Child[], parentId: string | undefined, depth: number): ReactElement[] =>
    items.map(({ node, kind }) => {
      const entry = entryById.get(node.id) ?? { node, parentId, depth, kind, index: -1 };
      const isStep = kind === "step";
      const openable = kind === "task";
      const isExpandable = canExpand(node);
      const isOpen = isExpandable && expanded(node.id);
      const glyph = glyphFor(node);
      // A step has no clock of its own; it is either ticked or not.
      const duration = isStep ? undefined : durationLabel(node, now);
      const running = node.status === "running";
      const warn = glyph === "struggling";
      const titleTone = running
        ? "font-semibold text-content"
        : node.status === "pending"
          ? "text-muted"
          : "text-content/85";
      const kids = isOpen ? kidsOf(node) : undefined;
      return (
        <li
          key={node.id}
          ref={(el) => {
            if (el) refs.current.set(node.id, el);
            else refs.current.delete(node.id);
          }}
          role="treeitem"
          tabIndex={node.id === tabId ? 0 : -1}
          aria-expanded={isExpandable ? isOpen : undefined}
          onKeyDown={(e) => onKeyDown(e, entry)}
          onFocus={(e) => {
            if (e.target === e.currentTarget) setActiveId(node.id);
          }}
          // The li itself draws no ring; its row does, inset so the tree's scroll frame cannot clip it.
          className="list-none outline-none [&:focus-visible>[data-row]]:focus-ring-inset"
        >
          <div
            data-row
            onClick={() => (isExpandable ? toggle(node.id) : openable && onOpen?.(node))}
            className={`mx-1 flex gap-2 rounded-md pr-2 pl-1.5 text-[12.5px] hover:bg-selection-subtle ${
              isStep ? "min-h-6 items-start py-1" : `items-center py-0.5 ${depth > 0 ? "min-h-6" : "min-h-6.5"}`
            } ${isExpandable || openable ? "cursor-pointer" : ""} ${running ? "bg-accent/11" : warn ? "bg-warning/6" : ""}`}
          >
            <span data-chevron={isExpandable ? "" : undefined} aria-hidden="true" className="grid w-3 shrink-0 place-items-center text-muted">
              {isExpandable ? (
                isOpen ? <ChevronDown className="size-3" strokeWidth={2} /> : <ChevronRight className="size-3" strokeWidth={2} />
              ) : null}
            </span>
            <TaskGlyph kind={glyph} small={depth > 0} label={isStep && node.status === "pending" ? "not ticked" : undefined} />
            {node.index !== undefined ? (
              <span className="w-3 shrink-0 text-right text-[11.5px] text-muted tabular-nums">{node.index}</span>
            ) : null}
            <span
              title={node.title}
              className={`min-w-0 flex-1 ${isStep ? "line-clamp-2 leading-4 break-words" : "truncate"} ${titleTone}`}
            >
              {node.title}
            </span>
            {(node.fixRounds ?? 0) >= STRUGGLING_FROM_ROUND ? (
              <span className="text-[11.5px] whitespace-nowrap text-warning">
                fix {Math.min(node.fixRounds ?? 0, MAX_FIX_ROUNDS)} of {MAX_FIX_ROUNDS}
              </span>
            ) : null}
            {node.status === "blocked" ? (
              <span data-tag="blocked" className="text-[11.5px] whitespace-nowrap text-warning">
                blocked
              </span>
            ) : null}
            {stepsMeta(node)}
            {duration !== undefined ? (
              <span
                data-duration
                className={`text-[11.5px] tabular-nums ${running ? "text-content" : "text-muted"}`}
              >
                {duration}
              </span>
            ) : null}
          </div>
          {kids ? (
            <>
              {node.summary ? (
                <div className="pr-3 pb-1.5 pl-[46px] text-[11.5px] leading-[1.45] text-muted">{node.summary}</div>
              ) : null}
              {kids.stages.length > 0 ? (
                <ul role="group" className="pl-5">
                  {renderRows(kids.stages, node.id, depth + 1)}
                </ul>
              ) : null}
              {kids.steps.length > 0 ? (
                <ul
                  role="group"
                  aria-label={`Steps, ${tickedCount(node.steps ?? [])} of ${kids.steps.length} ticked`}
                  className="pl-5"
                >
                  <li aria-hidden="true" className="list-none pt-0.5 pb-px pl-[30px] text-[11.5px] text-muted">
                    Steps {tickedCount(node.steps ?? [])} of {kids.steps.length}
                  </li>
                  {renderRows(kids.steps, node.id, depth + 1)}
                </ul>
              ) : null}
              {kids.tasks.length > 0 ? (
                <ul role="group" className="pl-5">
                  {renderRows(kids.tasks, node.id, depth + 1)}
                </ul>
              ) : null}
            </>
          ) : null}
        </li>
      );
    });

  return (
    <ul
      ref={treeRef}
      role="tree"
      aria-label={label}
      className="m-0 list-none p-0"
      onFocus={() => {
        focusInside.current = true;
      }}
      onBlur={(e) => {
        // A removed row may blur with no target; only a real move out ends "inside".
        if (e.target.isConnected && !treeRef.current?.contains(e.relatedTarget as Node | null)) {
          focusInside.current = false;
        }
      }}
    >
      {renderRows(roots, undefined, 0)}
    </ul>
  );
}
