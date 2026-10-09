import { Check } from "../../../shared/ui/icons";
import type { StatusAction, StatusCard as StatusCardData, StatusKind } from "../model/statusCard";
import { TaskGlyph, type GlyphKind } from "./TaskGlyph";

type Props = {
  card: StatusCardData;
  onAction?: (action: StatusAction, card: StatusCardData) => void;
};

const ACTION_LABELS: Record<StatusAction, string> = {
  "answer-in-session": "Answer in session",
  "remind-later": "Remind me in 10m",
  "see-issues": "See the open issues",
  "open-reviewer": "Open reviewer",
  "keep-waiting": "Keep waiting",
  "stop-after-task": "Stop after this task",
  "open-session": "Open session",
  "review-decisions": "Review decisions",
};

const PRIMARY: ReadonlySet<StatusAction> = new Set(["answer-in-session"]);
const SOLID: ReadonlySet<StatusAction> = new Set(["see-issues", "open-reviewer"]);

const TONE: Record<StatusKind, string> = {
  "needs-you": "bg-diff-del/14",
  struggling: "bg-skill/12",
  quiet: "bg-skill/12",
  running: "bg-selection-subtle",
  done: "bg-selection-subtle",
  idle: "",
};

const GLYPH: Partial<Record<StatusKind, GlyphKind>> = {
  "needs-you": "ask",
  struggling: "struggling",
  quiet: "quiet",
  done: "done",
};

const BUTTON =
  "min-h-6 rounded-[7px] px-2.5 py-1 text-[11.5px] whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent";

export function actionLabel(action: StatusAction, card: StatusCardData): string {
  if (action === "answer-in-session" && card.sessionTitle) return `Answer in ${card.sessionTitle}`;
  return ACTION_LABELS[action];
}

function actionClass(action: StatusAction): string {
  if (PRIMARY.has(action)) return `${BUTTON} bg-diff-del font-semibold text-black/80`;
  if (SOLID.has(action)) return `${BUTTON} bg-selection text-content`;
  return `${BUTTON} text-content/66 hover:bg-selection-subtle`;
}

// The card's dot is the only moving thing in the panel; reduced motion keeps it still.
function RunningDot() {
  return (
    <span className="grid size-4 place-items-center rounded-full bg-accent/22">
      <span className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
    </span>
  );
}

function CardGlyph({ kind }: { kind: StatusKind }) {
  const glyph = GLYPH[kind];
  return (
    <span aria-hidden="true" className="mt-px shrink-0">
      {glyph ? <TaskGlyph kind={glyph} /> : <RunningDot />}
    </span>
  );
}

const OTHERS_GLYPH: Partial<Record<StatusKind, GlyphKind>> = {
  "needs-you": "ask",
  struggling: "struggling",
  quiet: "quiet",
};

function lastWroteAt(since: number): string {
  return new Date(since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function StatusCard({ card, onAction }: Props) {
  if (card.kind === "idle") return <></>;
  const others = card.others;
  const othersGlyph = others ? (OTHERS_GLYPH[others.kind] ?? "running") : undefined;
  return (
    <>
      <div
        data-status-kind={card.kind}
        className={`mx-2 mt-1 mb-2 rounded-[10px] p-2.5 ${TONE[card.kind]}`}
      >
        <div className="flex items-start gap-2">
          <CardGlyph kind={card.kind} />
          <div className="min-w-0 flex-1">
            <div
              role={card.kind === "needs-you" ? "alert" : "status"}
              className="text-[14px] leading-[1.3] font-semibold text-content"
            >
              {card.headline}
            </div>
            {card.detail ? (
              <div className="mt-0.5 text-[12.5px] leading-[1.4] text-content/66 tabular-nums">{card.detail}</div>
            ) : null}
            {card.kind === "quiet" && card.since !== undefined ? (
              <div className="mt-0.5 text-[12.5px] leading-[1.4] text-content/66">
                The reviewer last wrote at {lastWroteAt(card.since)}. It may be running a long test.
              </div>
            ) : null}
            {card.reassurance ? (
              <div className="mt-0.5 flex items-center gap-1 text-[12.5px] leading-[1.4] text-diff-add">
                <Check className="size-3" strokeWidth={2.5} aria-hidden="true" />
                {card.reassurance}
              </div>
            ) : null}
            {card.actions.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {card.actions.map((action) => (
                  <button key={action} type="button" className={actionClass(action)} onClick={() => onAction?.(action, card)}>
                    {actionLabel(action, card)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {others && othersGlyph ? (
        <div className="mx-2 mb-1 flex min-h-6.5 items-center gap-2 rounded-md px-2 text-[12.5px] text-content/66">
          <TaskGlyph kind={othersGlyph} small />
          <span className="min-w-0 flex-1 truncate">{others.text}</span>
        </div>
      ) : null}
    </>
  );
}
