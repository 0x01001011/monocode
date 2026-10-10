import { useId, type Ref } from "react";
import { ChevronDown, ChevronRight } from "../../../shared/ui/icons";
import type { Ship, ShipItem } from "../model/ship";
import { TaskGlyph, type GlyphKind } from "./TaskGlyph";

type Props = {
  ship: Ship;
  /** Plan totals for the ready line. */
  tasks: number;
  steps?: number;
  open: boolean;
  onToggle: () => void;
  /** The checklist toggle, so the graph's Ship row can hand focus to it. */
  toggleRef?: Ref<HTMLButtonElement>;
  /** An unmet item was pressed: bring its row into view. */
  onReveal: (id: string) => void;
  onCopySummary: () => void;
  /** The summary was just copied: the button says so for a moment. */
  copied?: boolean;
};

const FOCUS = "focus-visible:focus-ring-inset";
const ROW = "flex min-h-6 items-center gap-2 text-[12.5px]";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Each item says its state in words as well as colour. */
function glyphOf(item: ShipItem): [GlyphKind, string] {
  if (item.met === true) return ["done", "done"];
  if (item.met === "unknown") return ["pending", "unknown"];
  return ["issues", "not met"];
}

/**
 * The Ship checklist under the graph's terminal node (the row says the verdict, this says how far
 * along it is): every task done, a clean final review,
 * passing tests, no gaps. An unmet item with a row is a button that reveals that row.
 * Deferred items are counted but never block.
 */
export function ShipNode({ ship, tasks, steps, open, onToggle, toggleRef, onReveal, onCopySummary, copied = false }: Props) {
  const listId = useId();
  const met = ship.items.filter((i) => i.met === true).length;
  const totals = ["Ready to ship", plural(tasks, "task", "tasks"), ...(steps !== undefined ? [plural(steps, "step", "steps")] : []), plural(ship.commits, "commit", "commits")];
  return (
    <div data-ship className="pt-0.5">
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={onToggle}
        className={`mx-1 flex min-h-6 w-[calc(100%-8px)] items-center gap-2 rounded-md pr-2 pl-1.5 text-left text-[12.5px] hover:bg-selection-subtle ${FOCUS}`}
      >
        <span aria-hidden="true" className="grid w-4 shrink-0 place-items-center text-muted">
          {open ? <ChevronDown className="size-3" strokeWidth={2} /> : <ChevronRight className="size-3" strokeWidth={2} />}
        </span>
        <span className="min-w-0 flex-1 truncate text-content tabular-nums">
          Ship checklist · {met} of {ship.items.length} met
        </span>
      </button>
      {open ? (
        <div id={listId} className="pt-0.5 pr-3 pb-1 pl-8">
          <ul role="list" aria-label="Before ship" className="m-0 list-none p-0">
            {ship.items.map((item) => {
              const [kind, label] = glyphOf(item);
              const nodeId = item.met !== true ? item.nodeId : undefined;
              return (
                <li key={item.id} className={ROW}>
                  <TaskGlyph kind={kind} small label={label} />
                  {nodeId !== undefined ? (
                    <button
                      type="button"
                      onClick={() => onReveal(nodeId)}
                      className={`-mx-1 min-h-6 min-w-0 truncate rounded-md px-1 text-left text-focus hover:bg-selection-subtle hover:underline ${FOCUS}`}
                    >
                      {item.text}
                    </button>
                  ) : (
                    <span className={`min-w-0 ${item.met === true ? "text-muted" : "text-content"}`}>{item.text}</span>
                  )}
                </li>
              );
            })}
          </ul>
          {ship.deferred > 0 ? (
            <div className="pt-0.5 text-[11.5px] text-muted">{ship.deferred} deferred (not blocking)</div>
          ) : null}
          {ship.ready ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1">
              <span className="text-[11.5px] text-muted tabular-nums">{totals.join(" · ")}</span>
              <button
                type="button"
                onClick={onCopySummary}
                className={`min-h-6 rounded-md bg-selection px-2 text-[11.5px] text-content hover:bg-selection-subtle ${FOCUS}`}
              >
                {copied ? "Copied" : "Copy summary"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
