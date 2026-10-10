import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "../../../shared/ui/icons";
import type { Gap } from "../model/gaps";
import type { BoardNote } from "../model/taskBoard";

export type NoteGroupId = "deferred" | "gaps" | "decisions";
export type DeferredNote = BoardNote & { parked?: boolean };

type Props = {
  /** Small issues saved for the end, then parked ones (tagged). */
  deferred: readonly DeferredNote[];
  gaps: readonly Gap[];
  decisions: readonly BoardNote[];
  open: Record<NoteGroupId, boolean>;
  onToggle: (id: NoteGroupId) => void;
  /** A gap was pressed: bring its row into view. */
  onReveal: (id: string) => void;
  onChangeDecision?: (note: BoardNote) => void;
};

const FOCUS = "focus-visible:focus-ring-inset";
const ITEM = "flex items-start gap-2 py-1 pr-3 pl-8 text-[12.5px] leading-[1.4]";
const TAG = "text-[11.5px] whitespace-nowrap text-muted";
const DECISIONS_EXPLAINER = "Calls the agent made without stopping to ask. Change any of them by telling the agent.";
const NAME_CHARS = 60;

/** Change-this label; an empty decision has no text to quote. */
function changeLabel(text: string): string {
  const quoted = text.length > NAME_CHARS ? `${text.slice(0, NAME_CHARS).trimEnd()}…` : text;
  return quoted ? `Change this: ${quoted}` : "Change this";
}

function TaskTag({ note }: { note: BoardNote }) {
  return note.taskIndex !== undefined ? <span className={TAG}>Task {note.taskIndex}</span> : null;
}

function Group({ id, title, count, open, onToggle, children }: {
  id: NoteGroupId;
  title: string;
  count: number;
  open: boolean;
  onToggle: (id: NoteGroupId) => void;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section data-group={id}>
      {/* The heading is the disclosure; the status card's buttons scroll to it and focus it. */}
      <h3 className="m-0 text-[12.5px] font-normal">
        <button
          type="button"
          data-notes={id}
          aria-expanded={open}
          onClick={() => onToggle(id)}
          className={`mx-1 flex min-h-6.5 w-[calc(100%-8px)] items-center gap-2 rounded-md pr-2 pl-1.5 text-left hover:bg-selection-subtle ${FOCUS}`}
        >
          <span aria-hidden="true" className="grid w-4 shrink-0 place-items-center text-muted">
            {open ? <ChevronDown className="size-3" strokeWidth={2} /> : <ChevronRight className="size-3" strokeWidth={2} />}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {title}
            <span className="text-muted tabular-nums"> · {count}</span>
          </span>
        </button>
      </h3>
      {open ? children : null}
    </section>
  );
}

/** Deferred, Gaps and Decisions made for you: collapsible groups under the graph. Empty ones are left out. */
export function NoteGroups({ deferred, gaps, decisions, open, onToggle, onReveal, onChangeDecision }: Props) {
  return (
    <div className="flex flex-col">
      <Group id="deferred" title="Deferred" count={deferred.length} open={open.deferred} onToggle={onToggle}>
        <ul role="list" className="m-0 list-none p-0">
          {deferred.map((note, i) => (
            <li key={i} className={ITEM}>
              <span className="min-w-0 flex-1">{note.text}</span>
              {note.parked ? <span className={TAG}>parked</span> : null}
              <TaskTag note={note} />
            </li>
          ))}
        </ul>
      </Group>
      <Group id="gaps" title="Gaps" count={gaps.length} open={open.gaps} onToggle={onToggle}>
        <ul role="list" className="m-0 list-none py-0.5 pr-3 pl-7">
          {gaps.map((gap) => (
            <li key={`${gap.kind}:${gap.nodeId}`} className="flex">
              <button
                type="button"
                onClick={() => onReveal(gap.nodeId)}
                className={`min-h-6 min-w-0 rounded-md px-1 text-left text-[12.5px] leading-[1.4] text-focus hover:bg-selection-subtle hover:underline ${FOCUS}`}
              >
                {gap.label}: {gap.text}
              </button>
            </li>
          ))}
        </ul>
      </Group>
      <Group id="decisions" title="Decisions made for you" count={decisions.length} open={open.decisions} onToggle={onToggle}>
        <p className="m-0 pr-3 pb-1 pl-8 text-[11.5px] leading-[1.45] text-muted">{DECISIONS_EXPLAINER}</p>
        <ul role="list" className="m-0 list-none p-0">
          {decisions.map((note, i) => (
            <li key={i} className={ITEM}>
              <span className="min-w-0 flex-1">{note.text}</span>
              <TaskTag note={note} />
              {onChangeDecision ? (
                <button
                  type="button"
                  aria-label={changeLabel(note.text)}
                  onClick={() => onChangeDecision(note)}
                  className={`-my-0.5 min-h-6 rounded-md px-2 text-[11.5px] whitespace-nowrap text-muted hover:bg-selection-subtle ${FOCUS}`}
                >
                  Change this
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </Group>
    </div>
  );
}
