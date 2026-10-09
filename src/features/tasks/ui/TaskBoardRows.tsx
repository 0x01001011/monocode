import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight } from "../../../shared/ui/icons";
import { whatHappened, type ChainTone } from "../model/happened";
import type { BoardNode, BoardSection, BoardTarget } from "../model/taskBoard";
import { TaskGlyph } from "./TaskGlyph";
import { durationLabel, glyphFor } from "./TaskTree";

export type OpenNode = (node: BoardNode, section: BoardSection) => void;

type RowProps = {
  node: BoardNode;
  section: BoardSection;
  now: number;
  /** Parked notes name this task, so its path counts as unusual. */
  hasParked: boolean;
  onOpenNode?: OpenNode;
  /** Changes each time the board asks this row to open its detail and come into view. */
  revealToken?: number;
};

const FOCUS = "outline-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-focus";
const LINK = `min-h-6 rounded-md px-1.5 text-[11.5px] text-focus hover:bg-selection-subtle ${FOCUS}`;
const COLUMNS = 4;

/** The button label for each kind of target a node can open; commits have their own button. */
const OPEN_LABEL: Partial<Record<BoardTarget["kind"], string>> = {
  report: "Open report",
  brief: "Open brief",
  review: "Open review",
  transcript: "Open transcript",
  session: "Open session",
};

const TONE: Record<ChainTone, string> = {
  plain: "text-content/85",
  warn: "text-warning",
  run: "text-focus",
};

const taskName = (node: BoardNode): string => (node.index !== undefined ? `Task ${node.index}` : node.title);
const hasDetail = (node: BoardNode): boolean =>
  Boolean(node.commits || node.models || node.steps?.length || (node.target && OPEN_LABEL[node.target.kind]));

function Happened({ node, hasParked }: { node: BoardNode; hasParked: boolean }) {
  const what = whatHappened(node, hasParked);
  if (what.kind === "none") return null;
  if (what.kind === "phrase") return <span className="text-content/85">{what.text}</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-0.5">
      {what.steps.map((step, i) => (
        <span key={i} className="flex items-center gap-x-0.5">
          {i > 0 ? (
            <span aria-hidden="true" className="text-muted">
              {" → "}
            </span>
          ) : null}
          <span className={TONE[step.tone]}>{step.text}</span>
        </span>
      ))}
    </span>
  );
}

function StepMark({ done }: { done: boolean }) {
  return done ? (
    <span role="img" aria-label="done" className="grid size-3.5 shrink-0 place-items-center rounded-[3px] bg-success/20 text-success">
      <Check className="size-2.5" strokeWidth={2.5} aria-hidden="true" />
    </span>
  ) : (
    <span role="img" aria-label="not ticked" className="size-3.5 shrink-0 rounded-[3px] border border-muted" />
  );
}

function Detail({ node, section, id, onOpenNode }: Pick<RowProps, "node" | "section" | "onOpenNode"> & { id: string }) {
  const openLabel = node.target ? OPEN_LABEL[node.target.kind] : undefined;
  return (
    <tr id={id} data-detail={node.id}>
      <td colSpan={COLUMNS} className="pr-3 pb-2 pl-[44px]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
          {node.commits ? (
            <span className="flex items-center gap-1">
              Commits
              <button
                type="button"
                onClick={() => onOpenNode?.({ ...node, target: { kind: "commit", ref: node.commits ?? "" } }, section)}
                className={`${LINK} font-mono`}
              >
                {node.commits}
              </button>
            </span>
          ) : null}
          {node.models ? <span>{node.models}</span> : null}
          {openLabel ? (
            <button type="button" onClick={() => onOpenNode?.(node, section)} className={LINK}>
              {openLabel}
            </button>
          ) : null}
        </div>
        {node.steps?.length ? (
          <div className="mt-1.5">
            <div className="text-[11.5px] text-muted">
              Plan steps · {node.steps.filter((step) => step.done).length} of {node.steps.length}
            </div>
            <ul aria-label={`Plan steps for ${taskName(node)}`} className="m-0 list-none p-0">
              {node.steps.map((step, i) => (
                <li key={i} className="flex min-h-6 items-center gap-2 text-[12.5px] text-content/85">
                  <StepMark done={step.done} />
                  <span className="min-w-0 flex-1">{step.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </td>
    </tr>
  );
}

export function TaskRow({ node, section, now, hasParked, onOpenNode, revealToken }: RowProps) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const expandable = hasDetail(node);
  const rowRef = useRef<HTMLTableRowElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (revealToken === undefined) return;
    if (expandable) setOpen(true);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    rowRef.current?.scrollIntoView?.({ block: "start", behavior: reduce ? "auto" : "smooth" });
    toggleRef.current?.focus({ preventScroll: true });
    // Only a new request reveals the row again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealToken]);
  const running = node.status === "running";
  const pending = node.status === "pending";
  const glyph = glyphFor(node);
  const duration = durationLabel(node, now);
  const label = node.index !== undefined ? `${node.index} · ${node.title}` : node.title;
  return (
    <>
      <tr ref={rowRef} data-node={node.id} className={`align-top ${running ? "bg-accent/11" : glyph === "struggling" ? "bg-warning/6" : ""}`}>
        <td className="w-11 py-1.5 pl-3">
          <TaskGlyph kind={glyph} />
        </td>
        <th scope="row" className={`py-1.5 pr-3 text-left text-[12.5px] ${running ? "font-semibold text-content" : pending ? "font-normal text-muted" : "font-normal text-content/85"}`}>
          <span className="flex items-start gap-1">
            {expandable ? (
              <button
                ref={toggleRef}
                type="button"
                aria-expanded={open}
                aria-controls={open ? detailId : undefined}
                aria-label={`Show details for ${taskName(node)}`}
                onClick={() => setOpen(!open)}
                className={`-my-0.5 grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-selection-subtle ${FOCUS}`}
              >
                {open ? <ChevronDown className="size-3" strokeWidth={2} /> : <ChevronRight className="size-3" strokeWidth={2} />}
              </button>
            ) : (
              <span aria-hidden="true" className="size-6 shrink-0" />
            )}
            <span className="min-w-0 pt-px">{label}</span>
          </span>
        </th>
        <td className="py-1.5 pr-3 text-[12.5px] leading-[1.4]">
          <Happened node={node} hasParked={hasParked} />
        </td>
        <td className={`py-1.5 pr-3 text-right text-[11.5px] whitespace-nowrap tabular-nums ${running ? "text-content" : "text-muted"}`}>
          {duration}
        </td>
      </tr>
      {open && expandable ? <Detail node={node} section={section} id={detailId} onOpenNode={onOpenNode} /> : null}
    </>
  );
}
