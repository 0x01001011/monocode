import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { ChevronDown, ChevronRight } from "../../../shared/ui/icons";
import { formatDuration } from "../model/duration";
import type { BoardNode, BoardStage } from "../model/taskBoard";
import { TaskGlyph, glyphForStatus, type GlyphKind } from "./TaskGlyph";

type Props = {
  nodes: BoardNode[];
  label: string;
  now: number;
  onOpen?: (node: BoardNode) => void;
  expandedIds?: ReadonlySet<string>;
  onToggle?: (id: string) => void;
};

const STRUGGLING_FROM_ROUND = 3;
const MAX_FIX_ROUNDS = 5;
const NO_DURATION = "—";

type Entry = { node: BoardNode; parentId?: string; depth: number; openable: boolean };

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

// Stages come first (they are the running task's own steps), then real children.
function childrenOf(node: BoardNode): { node: BoardNode; openable: boolean }[] {
  return [
    ...(node.stages ?? []).map((stage, i) => ({ node: stageNode(node, stage, i), openable: false })),
    ...(node.children ?? []).map((child) => ({ node: child, openable: true })),
  ];
}

// Only content the sidebar renders earns a chevron; `steps` belong to the full tab.
function canExpand(node: BoardNode): boolean {
  return Boolean(node.summary || node.stages?.length || node.children?.length);
}

function parentIndex(nodes: BoardNode[], parentId?: string, out = new Map<string, string | undefined>()) {
  for (const node of nodes) {
    out.set(node.id, parentId);
    parentIndex(childrenOf(node).map((c) => c.node), node.id, out);
  }
  return out;
}

function glyphFor(node: BoardNode): GlyphKind {
  if (node.status === "attention" && (node.fixRounds ?? 0) >= STRUGGLING_FROM_ROUND) return "struggling";
  return glyphForStatus(node.status);
}

function durationLabel(node: BoardNode, now: number): string | undefined {
  if (node.status === "pending") return undefined;
  if (node.startedAt === undefined) return NO_DURATION;
  if (node.status === "running") return formatDuration(now - node.startedAt, true);
  return formatDuration(node.endedAt === undefined ? undefined : node.endedAt - node.startedAt, false);
}

function flatten(
  nodes: { node: BoardNode; openable: boolean }[],
  expanded: (id: string) => boolean,
  parentId: string | undefined,
  depth: number,
  out: Entry[],
): Entry[] {
  for (const { node, openable } of nodes) {
    out.push({ node, parentId, depth, openable });
    if (canExpand(node) && expanded(node.id)) flatten(childrenOf(node), expanded, node.id, depth + 1, out);
  }
  return out;
}

export function TaskTree({ nodes, label, now, onOpen, expandedIds, onToggle }: Props) {
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

  const visible = flatten(nodes.map((node) => ({ node, openable: true })), expanded, undefined, 0, []);
  const visibleIds = new Set(visible.map((e) => e.node.id));
  let tabId: string | undefined = activeId;
  if (tabId !== undefined && !visibleIds.has(tabId)) {
    const parents = parentIndex(nodes);
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

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>, entry: Entry) => {
    if (event.target !== event.currentTarget) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = visible.indexOf(entry);
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
        else focusEntry(visible.find((e) => e.node.id === entry.parentId));
        break;
      case "Enter":
        if (entry.openable) onOpen?.(node);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const renderRows = (
    items: { node: BoardNode; openable: boolean }[],
    parentId: string | undefined,
    depth: number,
  ): ReactElement[] =>
    items.map(({ node, openable }) => {
      const entry = visible.find((e) => e.node.id === node.id) ?? { node, parentId, depth, openable };
      const isExpandable = canExpand(node);
      const isOpen = isExpandable && expanded(node.id);
      const glyph = glyphFor(node);
      const duration = durationLabel(node, now);
      const running = node.status === "running";
      const warn = glyph === "struggling";
      const titleTone = running
        ? "font-semibold text-content"
        : node.status === "pending"
          ? "text-content/55"
          : "text-content/85";
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
          className="list-none outline-none [&:focus-visible>[data-row]]:outline-2 [&:focus-visible>[data-row]]:-outline-offset-1 [&:focus-visible>[data-row]]:outline-accent"
        >
          <div
            data-row
            onClick={() => (isExpandable ? toggle(node.id) : openable && onOpen?.(node))}
            className={`mx-1 flex items-center gap-2 rounded-md py-0.5 pr-2 pl-1.5 text-[12.5px] hover:bg-selection-subtle ${
              depth > 0 ? "min-h-6" : "min-h-6.5"
            } ${running ? "bg-accent/11" : warn ? "bg-skill/11" : ""}`}
          >
            <span data-chevron={isExpandable ? "" : undefined} aria-hidden="true" className="grid w-3 shrink-0 place-items-center text-content/66">
              {isExpandable ? (
                isOpen ? <ChevronDown className="size-3" strokeWidth={2} /> : <ChevronRight className="size-3" strokeWidth={2} />
              ) : null}
            </span>
            <TaskGlyph kind={glyph} small={depth > 0} />
            {node.index !== undefined ? (
              <span className="w-3 shrink-0 text-right text-[11.5px] text-content/55 tabular-nums">{node.index}</span>
            ) : null}
            <span title={node.title} className={`min-w-0 flex-1 truncate ${titleTone}`}>
              {node.title}
            </span>
            {(node.fixRounds ?? 0) >= STRUGGLING_FROM_ROUND ? (
              <span className="text-[11.5px] whitespace-nowrap text-skill">
                fix {node.fixRounds} of {MAX_FIX_ROUNDS}
              </span>
            ) : null}
            {duration !== undefined ? (
              <span
                data-duration
                className={`text-[11.5px] tabular-nums ${running ? "text-content" : "text-content/66"}`}
              >
                {duration}
              </span>
            ) : null}
          </div>
          {isOpen ? (
            <>
              {node.summary ? (
                <div className="pr-3 pb-1.5 pl-[46px] text-[11.5px] leading-[1.45] text-content/55">{node.summary}</div>
              ) : null}
              {childrenOf(node).length > 0 ? (
                <ul role="group" className="pl-5">
                  {renderRows(childrenOf(node), node.id, depth + 1)}
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
      {renderRows(nodes.map((node) => ({ node, openable: true })), undefined, 0)}
    </ul>
  );
}
