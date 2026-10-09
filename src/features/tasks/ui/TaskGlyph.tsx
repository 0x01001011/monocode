import { Check } from "../../../shared/ui/icons";
import type { BoardStatus } from "../model/taskBoard";

export type GlyphKind =
  | "done"
  | "pending"
  | "running"
  | "ask"
  | "struggling"
  | "quiet"
  | "failed"
  | "blocked"
  | "cancelled"
  | "issues";

const LABELS: Record<GlyphKind, string> = {
  done: "done",
  pending: "not started",
  running: "running",
  ask: "needs you",
  struggling: "struggling",
  quiet: "quiet",
  failed: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
  issues: "review found issues",
};

const STATUS_GLYPH: Record<BoardStatus, GlyphKind> = {
  pending: "pending",
  running: "running",
  done: "done",
  attention: "issues",
  failed: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
};

export function glyphForStatus(status: BoardStatus): GlyphKind {
  return STATUS_GLYPH[status];
}

// Every glyph is a 16px cell so rows line up. Colour ladder: red = stopped and
// needs you, amber = needs a look, accent = running, green = done, gray ring =
// not started. The running dot is static on purpose; only the status card pulses.
const CELL = "grid size-4 shrink-0 place-items-center rounded-full text-[10px] leading-none";
const BOLD_MARK = "font-extrabold";

function Mark({ kind }: { kind: GlyphKind }) {
  switch (kind) {
    case "done":
      return <Check className="size-2.5" strokeWidth={2.5} aria-hidden="true" />;
    case "running":
      return <span className="size-1.5 rounded-full bg-focus" />;
    case "issues":
      return <span className="size-2 rounded-full bg-warning" />;
    case "ask":
      return "?";
    case "struggling":
      return "!";
    case "failed":
      return "×";
    case "blocked":
      return "!";
    case "cancelled":
      return "–";
    default:
      return null;
  }
}

const KIND_CLASS: Record<GlyphKind, string> = {
  done: `${CELL} bg-success/20 text-success`,
  pending: "m-px size-3.5 shrink-0 rounded-full border border-muted",
  running: `${CELL} bg-accent/22`,
  ask: `${CELL} ${BOLD_MARK} rounded-[4px] bg-danger text-[11px] text-background-base`,
  struggling: `${CELL} ${BOLD_MARK} bg-warning text-background-base`,
  quiet: "m-px size-3.5 shrink-0 rounded-full border-[1.5px] border-warning",
  failed: `${CELL} ${BOLD_MARK} bg-danger/5 text-danger`,
  blocked: `${CELL} ${BOLD_MARK} border-[1.5px] border-danger text-danger`,
  cancelled: `${CELL} ${BOLD_MARK} bg-content/8 text-muted`,
  issues: CELL,
};

export function TaskGlyph({ kind, small = false }: { kind: GlyphKind; small?: boolean }) {
  return (
    <span
      role="img"
      aria-label={LABELS[kind]}
      className={`${KIND_CLASS[kind]}${small ? " scale-[0.82]" : ""}`}
    >
      <Mark kind={kind} />
    </span>
  );
}
