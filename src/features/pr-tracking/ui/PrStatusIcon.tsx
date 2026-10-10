import {
  Clock,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type IconComponent,
} from "../../../shared/ui/icons";
import { statusIconFor, type StatusIcon } from "../model/prSetModel";
import type { Checks, PrState } from "../model/types";

/**
 * GitHub's status vocabulary. Each state has its own glyph, so the hue only
 * repeats what the shape already says. Draft is neutral ink, as on GitHub.
 */
export const PR_STATUS: Record<
  StatusIcon,
  { Icon: IconComponent; color: string; label: string }
> = {
  open: { Icon: GitPullRequest, color: "text-pr-open", label: "Open" },
  draft: { Icon: GitPullRequestDraft, color: "text-content/55", label: "Draft" },
  merged: { Icon: GitMerge, color: "text-pr-merged", label: "Merged" },
  closed: {
    Icon: GitPullRequestClosed,
    color: "text-pr-closed",
    label: "Closed",
  },
};

export function PrStatusIcon({
  state,
  isDraft,
  checks,
  size = 14,
  stale = false,
  decorative = false,
}: {
  state: PrState;
  isDraft: boolean;
  /** Folded into the tooltip of an open PR, e.g. "Open, checks failing". */
  checks?: Checks;
  size?: number;
  /** Snapshot is old: add a clock. Contrast stays full. */
  stale?: boolean;
  /** Hide from assistive tech when a neighbour already names the status. */
  decorative?: boolean;
}) {
  const status = statusIconFor(state, isDraft);
  const { Icon, color, label } = PR_STATUS[status];
  const title =
    status === "open" && checks && checks !== "none"
      ? `${label}, checks ${checks}`
      : label;
  return (
    <span
      className="pr-status"
      data-status={status}
      title={stale ? `${title}, status may be out of date` : title}
      {...(decorative
        ? { "aria-hidden": true }
        : {
            role: "img",
            "aria-label": stale ? `${title}, checks stale` : title,
          })}
    >
      <Icon aria-hidden="true" size={size} className={color} />
      {stale ? (
        <span className="pr-stale" data-pr-stale="true" aria-hidden="true">
          <Clock size={12} />
        </span>
      ) : null}
    </span>
  );
}
