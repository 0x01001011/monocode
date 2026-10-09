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
      return <span className="size-1.5 rounded-full bg-accent" />;
    case "issues":
      return <span className="size-2 rounded-full bg-skill" />;
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
  done: `${CELL} bg-diff-add/20 text-diff-add`,
  pending: "m-px size-3.5 shrink-0 rounded-full border border-content/45",
  running: `${CELL} bg-accent/22`,
  ask: `${CELL} ${BOLD_MARK} rounded-[4px] bg-diff-del text-[11px] text-black/80`,
  struggling: `${CELL} ${BOLD_MARK} bg-skill/22 text-skill`,
  quiet: "m-px size-3.5 shrink-0 rounded-full border-[1.5px] border-skill",
  failed: `${CELL} ${BOLD_MARK} bg-diff-del/22 text-diff-del-fg`,
  blocked: `${CELL} ${BOLD_MARK} border-[1.5px] border-diff-del text-diff-del-fg`,
  cancelled: `${CELL} ${BOLD_MARK} bg-content/8 text-content/55`,
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
