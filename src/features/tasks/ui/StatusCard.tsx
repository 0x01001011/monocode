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
  "needs-you": "bg-danger/14",
  struggling: "bg-warning/12",
  quiet: "bg-warning/12",
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

// The ring is chosen per button: the primary one is a solid red fill, where an inset blue ring would
// vanish (about 1:1), so it draws the ring outside on the card instead.
const BUTTON = "min-h-6 rounded-[7px] px-2.5 py-1 text-[11.5px]";

export function actionLabel(action: StatusAction, card: StatusCardData): string {
  if (action === "answer-in-session" && card.sessionTitle) return `Answer in ${card.sessionTitle}`;
  return ACTION_LABELS[action];
}

function actionClass(action: StatusAction): string {
  // "Answer in <title>" carries a session title of any length: it wraps inside the card.
  if (PRIMARY.has(action)) return `${BUTTON} max-w-full text-left break-words bg-danger font-semibold text-background-base focus-visible:focus-ring`;
  if (SOLID.has(action)) return `${BUTTON} whitespace-nowrap bg-selection text-content focus-visible:focus-ring-inset`;
  return `${BUTTON} whitespace-nowrap text-muted hover:bg-selection-subtle focus-visible:focus-ring-inset`;
}

// The card's dot is the only moving thing in the panel; reduced motion keeps it still.
function RunningDot() {
  return (
    <span className="grid size-4 place-items-center rounded-full bg-accent/22">
      <span className="size-1.5 rounded-full bg-focus motion-safe:animate-pulse" />
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

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
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
            {/* Remounted per kind, so a change of state is announced as new. */}
            <div
              key={card.kind}
              role={card.kind === "needs-you" ? "alert" : "status"}
              className="text-[14px] leading-[1.3] font-semibold text-content"
            >
              {card.headline}
            </div>
            {card.detail || (card.kind === "quiet" && card.since !== undefined) ? (
              <div className="mt-0.5 text-[12.5px] leading-[1.4] text-muted tabular-nums">
                {[card.detail, card.kind === "quiet" && card.since !== undefined ? `Last activity at ${clockTime(card.since)}.` : undefined]
                  .filter(Boolean)
                  .join(" ")}
              </div>
            ) : null}
            {card.reassurance ? (
              <div className="mt-0.5 flex items-center gap-1 text-[12.5px] leading-[1.4] text-success">
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
        <div className="mx-2 mb-1 flex min-h-6.5 items-center gap-2 rounded-md px-2 text-[12.5px] text-muted">
          <TaskGlyph kind={othersGlyph} small />
          <span className="min-w-0 flex-1 truncate">{others.text}</span>
        </div>
      ) : null}
    </>
  );
}
