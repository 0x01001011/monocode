import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { statusIconFor } from "../model/prSetModel";
import { fitRail, type RailFit, type RailNodeWidth } from "../model/railFit";
import type { PrEntryLite, PrStackView } from "../model/types";
import { PR_STATUS, PrStatusIcon } from "./PrStatusIcon";

/** Matches `.pr-rail` gap/padding and `.pr-rail-node` gap in index.css. */
const RAIL_GAP = 4;
/** Leaves room inside the clipped rail for the 2px focus ring and 2px offset. */
const RAIL_PAD = 4;
const NODE_GAP = 6;

const FULL: RailFit = { mode: "full", compactNumbers: [] };

type Measured = { key: string; nodes: RailNodeWidth[]; overhead: number };

/** Scrolls the rail so the viewed PR sits in the middle. */
function centerCurrent(ol: HTMLOListElement, current: number) {
  const li = ol.querySelector<HTMLLIElement>(`li[data-rail-node="${current}"]`);
  if (!li) return;
  ol.scrollLeft = li.offsetLeft - (ol.clientWidth - li.offsetWidth) / 2;
}

const width = (el: Element | null | undefined) =>
  el ? el.getBoundingClientRect().width : 0;

/**
 * Widths of each node with and without its title. Only valid in full mode.
 * Null while the rail is not laid out (a `display: none` ancestor measures
 * every box as 0), so nothing is cached and the next resize measures again.
 */
function measure(ol: HTMLOListElement, key: string): Measured | null {
  if (ol.clientWidth === 0) return null;
  const items = [...ol.querySelectorAll<HTMLLIElement>("li[data-rail-node]")];
  const nodes = items.map((li) => {
    const full = width(li);
    const title = width(li.querySelector("[data-rail-title]"));
    return {
      number: Number(li.dataset.railNode),
      full,
      compact: title > 0 ? full - title - NODE_GAP : full,
    };
  });
  if (nodes.some((node) => node.full === 0)) return null;
  const overhead =
    width(ol.querySelector("li[data-rail-terminus]")) +
    RAIL_GAP * items.length +
    RAIL_PAD * 2;
  return { key, nodes, overhead };
}

function nodeLabel(entry: PrEntryLite): string {
  const status = PR_STATUS[statusIconFor(entry.state, entry.isDraft)].label;
  const parts = [`PR ${entry.number}`, entry.title, status];
  if (entry.isNeighbor) parts.push("other chat");
  return parts.join(", ");
}

export type PrStackRailProps = {
  view: PrStackView;
  /** The PR the Inbox is showing. */
  current: number;
  /** Opens another member in the Inbox. */
  onOpenPr: (entry: PrEntryLite) => void;
};

/**
 * Inbox stack rail `main ← #478 ← [#480] ← #482`, ported from the mockup's
 * `railHTML()`/`fitRail()`. When it runs out of room, nodes farthest from
 * the viewed PR drop their titles first; if numbers alone still overflow, it
 * scrolls sideways with faded edges, centered on the viewed PR.
 */
export function PrStackRail({ view, current, onOpenPr }: PrStackRailProps) {
  const olRef = useRef<HTMLOListElement>(null);
  const measured = useRef<Measured | null>(null);
  const [fit, setFit] = useState<RailFit>(FULL);
  const { entries, group } = view;
  const key = entries.map((e) => `${e.number}\u0000${e.title}`).join("\u0001");

  const refit = useCallback(() => {
    const ol = olRef.current;
    if (!ol) return;
    let m = measured.current;
    if (!m || m.key !== key) {
      // Titles can only be measured while they are all drawn.
      if (fit.mode !== "full" || fit.compactNumbers.length > 0) {
        setFit(FULL);
        return;
      }
      m = measure(ol, key);
      if (!m) return;
      measured.current = m;
    }
    const next = fitRail(m.nodes, ol.clientWidth - m.overhead, current);
    const same =
      fit.mode === next.mode &&
      fit.compactNumbers.join() === next.compactNumbers.join();
    if (!same) setFit(next);
    // A resize that keeps the layout still moves the middle.
    else if (next.mode === "scroll") centerCurrent(ol, current);
  }, [current, fit, key]);

  const refitRef = useRef(refit);
  refitRef.current = refit;

  useLayoutEffect(() => {
    refit();
  }, [refit]);

  useEffect(() => {
    const ol = olRef.current;
    if (!ol || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => refitRef.current());
    observer.observe(ol);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const ol = olRef.current;
    if (ol && fit.mode === "scroll") centerCurrent(ol, current);
  }, [current, fit]);

  const open = (event: MouseEvent<HTMLAnchorElement>, entry: PrEntryLite) => {
    // The webview never navigates; the Inbox opens the PR instead.
    event.preventDefault();
    if (entry.number !== current) onOpenPr(entry);
  };

  const compact = new Set(fit.compactNumbers);
  return (
    <nav aria-label="Stack, base to tip" className="pr-rail-nav">
      <ol ref={olRef} className="pr-rail" data-mode={fit.mode}>
        <li data-rail-terminus="">
          <span className="pr-rail-trunk">{group.baseRef || "main"}</span>
        </li>
        {entries.map((entry) => {
          const isCurrent = entry.number === current;
          const status = statusIconFor(entry.state, entry.isDraft);
          return (
            <li key={entry.number} data-rail-node={entry.number}>
              <span className="pr-rail-arrow" aria-hidden="true">
                ←
              </span>
              <a
                href={entry.url}
                // WebKit (and so the macOS webview) skips plain links on Tab
                // unless the user turned on Safari's "highlight each item".
                tabIndex={0}
                className="pr-rail-node"
                data-pr={entry.number}
                data-state={status}
                data-other={entry.isNeighbor ? "true" : undefined}
                aria-current={isCurrent ? "step" : undefined}
                aria-label={nodeLabel(entry)}
                title={`#${entry.number} ${entry.title}`}
                onClick={(event) => open(event, entry)}
              >
                <PrStatusIcon
                  state={entry.state}
                  isDraft={entry.isDraft}
                  checks={entry.checks}
                  decorative
                />
                <span className="pr-rail-n">#{entry.number}</span>
                {compact.has(entry.number) ? null : (
                  <span className="pr-rail-ttl" data-rail-title="">
                    {entry.title}
                  </span>
                )}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
