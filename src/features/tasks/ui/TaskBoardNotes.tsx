import { useId } from "react";
import type { BoardNote } from "../model/taskBoard";

type Props = {
  onChangeDecision?: (note: BoardNote) => void;
  decisions: readonly BoardNote[];
  /** Small issues; parked ones are marked as such. */
  issues: readonly (BoardNote & { parked?: boolean })[];
};

const DECISIONS_EXPLAINER = "Calls the agent made without stopping to ask. Change any of them by telling the agent.";
const ISSUES_EXPLAINER = "Things the reviewer chose not to block on. The final review decides which to fix.";
const NAME_CHARS = 60;
const FOCUS = "outline-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-focus";

function Source({ note }: { note: BoardNote }) {
  return (
    <span className="w-12 shrink-0 text-[11.5px] whitespace-nowrap text-muted">
      {note.taskIndex !== undefined ? `Task ${note.taskIndex}` : ""}
    </span>
  );
}

/** Change-this label; an empty decision has no text to quote. */
function changeLabel(text: string): string {
  const quoted = text.length > NAME_CHARS ? `${text.slice(0, NAME_CHARS).trimEnd()}…` : text;
  return quoted ? `Change this: ${quoted}` : "Change this";
}

/** Headings carry `data-notes` for the card buttons that scroll to them; ids are per instance (a split shows two boards). */
export function TaskBoardNotes({ decisions, issues, onChangeDecision }: Props) {
  const decisionsId = useId();
  const issuesId = useId();
  return (
    <div className="px-3 pt-4 pb-4">
      {decisions.length > 0 ? (
        <section aria-labelledby={decisionsId} className="mb-4">
          <h3 id={decisionsId} data-notes="decisions" tabIndex={-1} className={`m-0 text-[12.5px] font-semibold ${FOCUS}`}>
            Decisions made for you · {decisions.length}
          </h3>
          <p className="m-0 mb-1 text-[11.5px] leading-[1.45] text-muted">{DECISIONS_EXPLAINER}</p>
          <ol className="m-0 list-none p-0">
            {decisions.map((note, i) => (
              <li key={i} className="flex items-start gap-2 py-1 text-[12.5px] leading-[1.4]">
                <Source note={note} />
                <span className="min-w-0 flex-1">{note.text}</span>
                <button
                  type="button"
                  aria-label={changeLabel(note.text)}
                  onClick={() => onChangeDecision?.(note)}
                  className={`min-h-6 rounded-md px-2 text-[11.5px] whitespace-nowrap text-muted hover:bg-selection-subtle ${FOCUS}`}
                >
                  Change this
                </button>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {issues.length > 0 ? (
        <section aria-labelledby={issuesId}>
          <h3 id={issuesId} data-notes="issues" tabIndex={-1} className={`m-0 text-[12.5px] font-semibold ${FOCUS}`}>
            Small issues saved for the end · {issues.length}
          </h3>
          <p className="m-0 mb-1 text-[11.5px] leading-[1.45] text-muted">{ISSUES_EXPLAINER}</p>
          <ol className="m-0 list-none p-0">
            {issues.map((note, i) => (
              <li key={i} className="flex items-start gap-2 py-1 text-[12.5px] leading-[1.4]">
                <Source note={note} />
                <span className="min-w-0 flex-1">{note.text}</span>
                {note.parked ? <span className="text-[11.5px] whitespace-nowrap text-muted">parked</span> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
