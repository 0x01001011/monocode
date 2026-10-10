import type { ReactElement } from "react";
import type { GraphRow, LaneCell } from "../model/graph";
import type { BoardStatus } from "../model/taskBoard";

/**
 * One row of the commit graph, drawn from its lane cells (see the top of model/graph.ts for
 * what each cell means). Lines are neutral strokes from the muted wrapper; only the node carries
 * status colour, and the row beside it always says the status in words.
 */
type Props = {
  cells: LaneCell[];
  status: BoardStatus;
  kind: GraphRow["kind"];
  now: boolean;
  /** The previous and next rows' cells; a node only draws half lines toward lanes that go on. */
  above?: LaneCell[];
  below?: LaneCell[];
};

const LANE = 12;
const STROKE = 1.5;
const center = (column: number) => column * LANE + LANE / 2;

const lineProps = { stroke: "currentColor", strokeWidth: STROKE } as const;

/** Solid dot = done, ring = not started, ringed dot = running, hollow = review found issues, diamond = Ship. */
function NodeShape({ status, kind }: { status: BoardStatus; kind: GraphRow["kind"] }): ReactElement {
  if (kind === "ship") {
    const points = "0,-4.5 4.5,0 0,4.5 -4.5,0";
    if (status === "done") return <polygon data-node points={points} className="fill-success" />;
    const tone = status === "pending" ? undefined : "stroke-warning";
    return (
      <polygon
        data-node
        points={points}
        className={`fill-background-base ${tone ?? ""}`}
        stroke={tone ? undefined : "currentColor"}
        strokeWidth={STROKE}
      />
    );
  }
  switch (status) {
    case "done":
      return <circle data-node r={3.5} className="fill-success" />;
    case "running":
      return (
        <g data-node>
          <circle r={4.5} className="fill-background-base stroke-focus" strokeWidth={STROKE} />
          <circle r={2} className="fill-focus" />
        </g>
      );
    case "attention":
      return <circle data-node r={3.5} className="fill-background-base stroke-warning" strokeWidth={2} />;
    case "failed":
      return <circle data-node r={3.5} className="fill-danger" />;
    case "blocked":
      return <circle data-node r={3.5} className="fill-background-base stroke-danger" strokeWidth={2} />;
    case "cancelled":
      return <circle data-node r={3} className="fill-current" />;
    default:
      return <circle data-node r={3.5} className="fill-background-base" stroke="currentColor" strokeWidth={STROKE} />;
  }
}

/** A quarter curve in the top half of the row, from the top edge at `from` into mid-height at `to`. */
function Curve({ from, to, width }: { from: number; to: number; width: number }) {
  return (
    <svg x={0} y={0} width={width} height="50%" viewBox={`0 0 ${width} 10`} preserveAspectRatio="none" overflow="visible">
      <path
        data-curve
        d={`M ${center(from)} 0 Q ${center(from)} 10 ${center(to)} 10`}
        fill="none"
        vectorEffect="non-scaling-stroke"
        {...lineProps}
      />
    </svg>
  );
}

export function GraphGutter({ cells, status, kind, now, above, below }: Props) {
  const width = cells.length * LANE;
  const parts: ReactElement[] = [];
  cells.forEach((cell, c) => {
    const x = center(c);
    const key = (part: string) => `${part}-${c}`;
    switch (cell) {
      case "line":
        parts.push(<line key={key("line")} data-line="full" x1={x} x2={x} y1="0" y2="100%" {...lineProps} />);
        break;
      case "dashed":
        parts.push(
          <line key={key("dashed")} data-line="full" x1={x} x2={x} y1="0" y2="100%" strokeDasharray="3 3" {...lineProps} />,
        );
        break;
      case "merge":
        parts.push(<Curve key={key("merge")} from={c} to={0} width={width} />);
        break;
      case "node":
      case "fork": {
        if (cell === "fork") parts.push(<Curve key={key("fork")} from={0} to={c} width={width} />);
        else if (above !== undefined && (above[c] ?? "none") !== "none") {
          parts.push(<line key={key("above")} data-line="above" x1={x} x2={x} y1="0" y2="50%" {...lineProps} />);
        }
        const next = below?.[c] ?? "none";
        if (next !== "none" && next !== "fork") {
          parts.push(<line key={key("below")} data-line="below" x1={x} x2={x} y1="50%" y2="100%" {...lineProps} />);
        }
        break;
      }
      default:
        break;
    }
  });
  // Nodes go last so they sit on top of the lines through them.
  const nodeColumn = kind === "step" || kind === "hidden" ? -1 : cells.findIndex((cell) => cell === "node" || cell === "fork");
  if (nodeColumn >= 0) {
    const shape = <NodeShape status={status} kind={kind} />;
    parts.push(
      <svg key="node" x={center(nodeColumn)} y="50%" overflow="visible">
        {now ? <g className="motion-safe:animate-pulse">{shape}</g> : shape}
      </svg>,
    );
  }
  return (
    <span className="flex shrink-0 self-stretch text-muted">
      <svg data-gutter aria-hidden="true" focusable="false" width={width} height="100%" overflow="visible" className="block">
        {parts}
      </svg>
    </span>
  );
}
