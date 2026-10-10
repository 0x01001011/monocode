import { useRef, type KeyboardEvent } from "react";
import type { GraphFilter as Filter } from "../model/graph";

type Props = {
  value: Filter;
  counts: Record<Filter, number>;
  onChange: (filter: Filter) => void;
};

const OPTIONS: [Filter, string][] = [
  ["all", "All"],
  ["left", "Left"],
  ["problems", "Problems"],
];

const NEXT: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Which plan rows the graph shows, as a segmented control (`All 9 · Left 4 · Problems 1`).
 * A radiogroup: one tab stop on the chosen option; arrow keys move and choose, wrapping.
 */
export function GraphFilter({ value, counts, onChange }: Props) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = NEXT[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = (index + step + OPTIONS.length) % OPTIONS.length;
    onChange(OPTIONS[next]![0]);
    buttons.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Show" className="flex shrink-0 items-center gap-px rounded-md bg-content/6 p-px">
      {OPTIONS.map(([filter, label], i) => {
        const checked = filter === value;
        return (
          <button
            key={filter}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(filter)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`min-h-6 rounded-[5px] px-1.5 text-[11.5px] whitespace-nowrap tabular-nums focus-visible:focus-ring-inset ${
              checked ? "bg-selection font-semibold text-content" : "text-muted hover:bg-selection-subtle"
            }`}
          >
            {label} <span className={checked ? "" : "text-muted"}>{counts[filter]}</span>
          </button>
        );
      })}
    </div>
  );
}
