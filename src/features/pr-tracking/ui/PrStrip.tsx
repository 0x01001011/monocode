import type { StripBar } from "../model/prSetModel";
import { PR_STATUS } from "./PrStatusIcon";

/**
 * One bar per PR, base on the left (`stripBars` order). Shape repeats the
 * meaning: tall = this chat's current PR, short = merged, hollow = draft,
 * hairline = someone else's. Decorative: the owner's label carries the text.
 */
export function PrStrip({ bars }: { bars: StripBar[] }) {
  if (bars.length === 0) return null;
  return (
    <span className="pr-strip" aria-hidden="true">
      {bars.map((bar, index) => (
        <i
          // Numbers can repeat across repos; the order is stable per render.
          key={`${index}:${bar.number}`}
          data-kind={bar.kind}
          data-status={bar.status}
          className={PR_STATUS[bar.status].color}
        />
      ))}
    </span>
  );
}
