import type { tabBadge } from "../model/statusCard";

export type TabBadgeKind = NonNullable<ReturnType<typeof tabBadge>>;

const LABELS: Record<TabBadgeKind, string> = {
  ask: "Tasks, needs you",
  fail: "Tasks, a task is failing review",
  quiet: "Tasks, quiet for a while",
};

/** The Tasks tab's accessible name; the badge itself is decoration. */
export function tasksTabLabel(badge: TabBadgeKind | undefined): string {
  return badge ? LABELS[badge] : "Tasks";
}

const SHAPES: Record<TabBadgeKind, { className: string; mark: string }> = {
  // Red rounded square: the run is stopped and waits for you.
  ask: { className: "rounded-[3px] bg-danger text-background-base", mark: "?" },
  // Amber disc: the reviewer keeps sending a task back.
  fail: { className: "rounded-full bg-warning text-background-base", mark: "!" },
  // Hollow amber ring: no activity for a while.
  quiet: { className: "rounded-full border-[1.5px] border-warning", mark: "" },
};

export function TasksTabBadge({ kind }: { kind: TabBadgeKind }) {
  const { className, mark } = SHAPES[kind];
  return (
    <span
      aria-hidden="true"
      data-tab-badge={kind}
      className={`grid size-3 shrink-0 place-items-center text-[9px] leading-none font-bold ${className}`}
    >
      {mark}
    </span>
  );
}
