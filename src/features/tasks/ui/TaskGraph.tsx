import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement } from "react";
import { Copy, ExternalLink } from "../../../shared/ui/icons";
import type { Graph, GraphRow, RefTone } from "../model/graph";
import type { BoardTarget } from "../model/taskBoard";
import { GraphGutter } from "./GraphGutter";
import { TaskGlyph, glyphForStatus, glyphLabel, type GlyphKind } from "./TaskGlyph";
import { glyphFor } from "./TaskTree";
import { useFocusKeptInTree, useTreeReveal, type TreeReveal } from "./treeFocus";

type Props = {
  graph: Graph;
  label: string;
  /** Asks the parent to open or close a row; the parent rebuilds the graph. */
  onToggle: (id: string) => void;
  onOpen: (row: GraphRow) => void;
  onOpenCommit: (row: GraphRow, sha: string) => void;
  onCopySha: (sha: string) => void;
  /** Panel-side request: a new `token` opens the way to row `id`, scrolls it into view and focuses it. */
  reveal?: TreeReveal;
  /** The rows the parent holds open. Without it a row reads open while its children show. */
  expandedIds?: ReadonlySet<string>;
};

const MAX_REFS = 2;

const REF_TONE: Record<RefTone, string> = {
  warn: "bg-warning/12 text-warning",
  danger: "bg-danger/12 text-danger",
  ok: "bg-success/12 text-success",
  muted: "bg-content/8 text-muted",
  now: "bg-accent/22 text-focus",
};
const PILL = "rounded-full px-1.5 text-[11px] leading-4 whitespace-nowrap";
const ICON_BUTTON =
  "grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-content/10 hover:text-content focus-visible:focus-ring-inset";

const TARGET_LABEL: Record<BoardTarget["kind"], string> = {
  report: "Open report",
  brief: "Open brief",
  review: "Open review",
  transcript: "Open transcript",
  session: "Open session",
  commit: "Open commit",
};

/** A child row id the graph is not showing yet: `<task>:stage:N`, `<task>:step:N` or `<task>:merge`. */
const CHILD_ID = /^(.+):(?:stage:\d+|step:\d+|merge)$/;
const STAGE_ID = /:stage:(\d+)$/;

/**
 * While the row is hovered or focus is inside its actions, the actions take the place of the
 * meta, refs and NOW pill, so the title truncates instead of being covered. A focused row alone
 * keeps its normal look (keyboard users have `o` and `c`).
 */
// Tailwind only builds class names it finds spelled out whole, so every variant below stays a
// complete literal; never assemble a variant prefix with a template string.
const GIVES_WAY = "group-hover/row:hidden group-has-[[data-actions]:focus-within]/row:hidden";
const TITLE_YIELDS = "group-hover/row:min-w-0 group-has-[[data-actions]:focus-within]/row:min-w-0";
const ACTIONS =
  "pointer-events-none flex max-w-0 shrink-0 items-center gap-px overflow-hidden opacity-0 " +
  "group-hover/row:pointer-events-auto group-hover/row:max-w-none group-hover/row:opacity-100 " +
  "group-has-[[data-actions]:focus-within]/row:pointer-events-auto " +
  "group-has-[[data-actions]:focus-within]/row:max-w-none " +
  "group-has-[[data-actions]:focus-within]/row:opacity-100";

const levelOf = (row: GraphRow) => (row.kind === "stage" || row.kind === "step" ? 2 : 1);

function glyphOf(row: GraphRow): GlyphKind {
  return row.node ? glyphFor(row.node) : glyphForStatus(row.status);
}

/** Ship reads as ready or not; "review found issues" is the wrong words for it. */
function glyphText(row: GraphRow): string | undefined {
  if (row.kind === "ship") return row.status === "done" ? "ready" : row.status === "pending" ? "not started" : "not ready";
  if (row.kind === "step" && row.status === "pending") return "not ticked";
  return undefined;
}

/** "Task 3, done, fixed in 1 round, 8m": title (with its number when the title lacks it), status, refs, meta. */
function accessibleName(row: GraphRow, status: string | undefined): string {
  const numbered = row.index !== undefined && !new RegExp(`^Task ${row.index}\\b`).test(row.title);
  const parts = [numbered ? `Task ${row.index}, ${row.title}` : row.title];
  if (status !== undefined) parts.push(status);
  if (row.now) parts.push("now");
  for (const ref of row.refs.slice(0, MAX_REFS)) parts.push(ref.text);
  if (row.meta !== undefined) parts.push(row.meta);
  return parts.join(", ");
}

const stop = (event: MouseEvent, run: () => void) => {
  event.stopPropagation();
  run();
};

export function TaskGraph({ graph, label, onToggle, onOpen, onOpenCommit, onCopySha, reveal, expandedIds }: Props) {
  const { rows } = graph;
  const [active, setActive] = useState<{ id: string; parentId?: string }>();
  const items = useRef(new Map<string, HTMLElement>());

  // One pass per render: lookups by id and each row's place among its siblings.
  const byId = new Map<string, GraphRow>();
  for (const row of rows) byId.set(row.id, row);
  const hasChildren = new Set<string>();
  const siblings = new Map<string | undefined, number>();
  const position = new Map<string, number>();
  for (const row of rows) {
    const parent = row.parentId !== undefined && byId.has(row.parentId) ? row.parentId : undefined;
    if (parent !== undefined) hasChildren.add(parent);
    const n = (siblings.get(parent) ?? 0) + 1;
    siblings.set(parent, n);
    position.set(row.id, n);
  }
  const isOpen = (row: GraphRow) => row.expandable && (expandedIds ? expandedIds.has(row.id) : hasChildren.has(row.id));

  let tabId = active?.id;
  if (tabId !== undefined && !byId.has(tabId)) tabId = active?.parentId !== undefined && byId.has(active.parentId) ? active.parentId : undefined;
  tabId ??= rows[0]?.id;

  const setActiveId = (id: string) => setActive({ id, parentId: byId.get(id)?.parentId });
  const focusRow = (row: GraphRow | undefined) => {
    if (!row) return;
    setActiveId(row.id);
    items.current.get(row.id)?.focus();
  };

  const treeRef = useRef<HTMLUListElement>(null);
  const keepFocus = useFocusKeptInTree(treeRef, items, tabId);
  useTreeReveal({
    reveal,
    items,
    setActiveId,
    closedAncestors: (id) => {
      if (byId.has(id)) return [];
      const parent = byId.get(CHILD_ID.exec(id)?.[1] ?? "");
      return parent?.expandable && !isOpen(parent) ? [parent.id] : undefined;
    },
    toggle: onToggle,
  });

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>, row: GraphRow, index: number) => {
    if (event.target !== event.currentTarget) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.key) {
      case "ArrowDown":
        focusRow(rows[Math.min(index + 1, rows.length - 1)]);
        break;
      case "ArrowUp":
        focusRow(rows[Math.max(index - 1, 0)]);
        break;
      case "Home":
        focusRow(rows[0]);
        break;
      case "End":
        focusRow(rows[rows.length - 1]);
        break;
      case "ArrowRight":
        if (!row.expandable) break;
        if (!isOpen(row)) onToggle(row.id);
        else focusRow(rows[index + 1]?.parentId === row.id ? rows[index + 1] : undefined);
        break;
      case "ArrowLeft":
        if (row.expandable && isOpen(row)) onToggle(row.id);
        else focusRow(row.parentId === undefined ? undefined : byId.get(row.parentId));
        break;
      case "Enter":
        if (row.node) onOpen(row);
        else if (row.expandable) onToggle(row.id);
        break;
      // The letter keys only claim the event when they do something.
      case "o":
        if (!row.node?.target) return;
        onOpen(row);
        break;
      case "c": {
        const sha = row.shas[row.shas.length - 1];
        if (sha === undefined) return;
        onCopySha(sha);
        break;
      }
      case "n": {
        const now = rows.find((r) => r.now);
        if (!now) return;
        focusRow(now);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  const shaLink = (row: GraphRow, sha: string, tabIndex: number, extra = "") => (
    <button
      key={`open-${sha}`}
      type="button"
      data-sha={sha}
      tabIndex={tabIndex}
      aria-label={`Open commit ${sha}`}
      onClick={(e) => stop(e, () => onOpenCommit(row, sha))}
      className={`min-h-6 shrink-0 rounded-md px-1 font-mono text-[11px] text-focus hover:underline focus-visible:focus-ring-inset ${extra}`}
    >
      {sha}
    </button>
  );
  const copyButton = (sha: string, tabIndex: number, extra = "") => (
    <button
      key={`copy-${sha}`}
      type="button"
      tabIndex={tabIndex}
      aria-label={`Copy ${sha}`}
      title={`Copy ${sha}`}
      onClick={(e) => stop(e, () => onCopySha(sha))}
      className={`${ICON_BUTTON} ${extra}`}
    >
      <Copy className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
    </button>
  );

  const renderRow = (row: GraphRow, index: number): ReactElement => {
    const hidden = row.kind === "hidden";
    const isStep = row.kind === "step";
    const isStage = row.kind === "stage";
    const open = isOpen(row);
    const glyph = glyphOf(row);
    const statusText = hidden ? undefined : (glyphText(row) ?? glyphLabel(glyph));
    const running = row.status === "running" && !isStep;
    const titleTone = hidden
      ? "text-muted"
      : running
        ? "font-semibold text-content"
        : row.status === "pending"
          ? "text-muted"
          : "text-content/85";
    // Ship's own actions arrive with its node; every other row offers its target and commits.
    const target = row.kind === "ship" ? undefined : row.node?.target;
    const actionTab = row.id === tabId ? 0 : -1;
    const actions: ReactElement[] = [];
    if (target) {
      const name = TARGET_LABEL[target.kind];
      actions.push(
        <button
          key="open"
          type="button"
          tabIndex={actionTab}
          aria-label={name}
          title={name}
          onClick={(e) => stop(e, () => onOpen(row))}
          className={ICON_BUTTON}
        >
          <ExternalLink className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>,
      );
    }
    row.shas.forEach((sha, i) => {
      // Below 340 px a range offers only its last commit, so the actions fit beside the title.
      const narrow = i < row.shas.length - 1 ? "@max-[340px]:hidden" : "";
      // A stage shows its commit links on the row itself; only the copy buttons wait for hover.
      if (!isStage) actions.push(shaLink(row, sha, actionTab, narrow));
      actions.push(copyButton(sha, actionTab, narrow));
    });
    const givesWay = actions.length > 0 ? GIVES_WAY : "";
    const stageKind =
      isStage && row.parentId !== undefined
        ? byId.get(row.parentId)?.node?.stages?.[Number(STAGE_ID.exec(row.id)?.[1] ?? -1)]?.kind
        : undefined;
    const hollow = stageKind === "review" || stageKind === "final-review";
    const above = rows[index - 1]?.cells;
    const below = rows[index + 1]?.cells;
    const onRowClick = () => {
      if (row.expandable) onToggle(row.id);
      else if (row.node) onOpen(row);
    };
    const level = levelOf(row);
    const parent = level === 2 && row.parentId !== undefined && byId.has(row.parentId) ? row.parentId : undefined;
    return (
      <li
        key={row.id}
        ref={(el) => {
          if (el) items.current.set(row.id, el);
          else items.current.delete(row.id);
        }}
        data-row-id={row.id}
        role="treeitem"
        aria-level={level}
        aria-posinset={position.get(row.id)}
        aria-setsize={siblings.get(parent)}
        aria-expanded={row.expandable ? open : undefined}
        aria-label={hidden ? row.title : accessibleName(row, statusText)}
        tabIndex={row.id === tabId ? 0 : -1}
        onKeyDown={(e) => onKeyDown(e, row, index)}
        onFocus={(e) => {
          if (e.target === e.currentTarget) setActiveId(row.id);
        }}
        // The li draws no ring itself; its row does, inset so the tab's scroll frame cannot clip it.
        // A named group: an outer `group` (the sidebar has some) must not open every row's actions.
        className="group/row list-none outline-none [&:focus-visible>[data-row]]:focus-ring-inset"
      >
        <div
          data-row
          onClick={onRowClick}
          className={`mx-1 grid grid-rows-[1fr] rounded-md hover:bg-selection-subtle ${
            level === 2 ? "motion-safe:transition-[grid-template-rows] motion-safe:duration-150 motion-safe:ease-out motion-safe:starting:grid-rows-[0fr]" : ""
          } ${row.expandable || row.node ? "cursor-pointer" : ""} ${running ? "bg-accent/11" : glyph === "struggling" ? "bg-warning/6" : ""} ${
            hidden ? "text-muted" : ""
          }`}
        >
          <div className="flex min-h-0 gap-2 overflow-hidden pr-2 pl-1.5 text-[12.5px]">
            <GraphGutter
              cells={row.cells}
              status={row.status}
              kind={row.kind}
              now={row.now}
              hollow={hollow}
              above={above}
              below={below}
            />
            <div className={`flex min-w-0 flex-1 gap-2 ${isStep ? "min-h-6 items-start py-1" : `items-center py-0.5 ${level === 2 ? "min-h-6" : "min-h-6.5"}`}`}>
              {hidden ? null : (
                <TaskGlyph kind={glyph} small={level === 2} label={glyphText(row)} />
              )}
              {row.index !== undefined ? (
                <span className="w-3 shrink-0 text-right text-[11.5px] text-muted tabular-nums">{row.index}</span>
              ) : null}
              <span
                title={row.title}
                // At least 64 px of title beside the refs; it may give that up only while the actions show.
                className={`min-w-16 flex-1 ${actions.length > 0 ? TITLE_YIELDS : ""} ${
                  isStep ? "line-clamp-2 leading-4 break-words" : "truncate"
                } ${titleTone}`}
              >
                {row.title}
              </span>
              {row.now ? (
                <span data-now-pill className={`${PILL} shrink-0 font-semibold ${REF_TONE.now} ${givesWay}`}>
                  NOW
                </span>
              ) : null}
              {row.refs.slice(0, MAX_REFS).map((ref, i) => (
                <span
                  key={`${ref.tone}:${ref.text}:${i}`}
                  data-ref
                  title={ref.text}
                  // Refs shrink before the title does, and a narrow tab keeps only the first.
                  className={`${PILL} max-w-[45%] min-w-0 truncate ${REF_TONE[ref.tone]} ${i > 0 ? "@max-[300px]:hidden" : ""} ${givesWay}`}
                >
                  {ref.text}
                </span>
              ))}
              {isStage ? row.shas.map((sha) => shaLink(row, sha, actionTab)) : null}
              {row.meta !== undefined ? (
                <span
                  data-meta
                  className={`shrink-0 text-[11.5px] whitespace-nowrap tabular-nums ${running ? "text-content" : "text-muted"} ${givesWay}`}
                >
                  {row.meta}
                </span>
              ) : null}
              {actions.length > 0 ? (
                // In flow and zero-width until shown; the buttons stay focusable, so Tab from the
                // focused row walks into them and focus inside opens them.
                <span
                  data-actions
                  className={ACTIONS}
                >
                  {actions}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </li>
    );
  };

  return (
    <ul ref={treeRef} role="tree" aria-label={label} className="@container m-0 list-none p-0" {...keepFocus}>
      {rows.map(renderRow)}
    </ul>
  );
}
