import { useEffect, useId, useState } from "react";
import { gitIsAncestor } from "../../../platform/tauri/fs";
import { ChevronDown } from "../../../shared/ui/icons";
import {
  baseCandidates,
  suggestBase,
  type BaseOption,
  type BaseSuggestion,
} from "../model/baseSuggestion";
import type { PrSetView } from "../model/types";

/**
 * Whether `ref`, a PR's head branch, is an ancestor of HEAD in `cwd`. Tries
 * the local branch, then `<remote>/<ref>` for a branch never checked out here.
 */
async function headContains(
  cwd: string,
  ref: string,
  remote: string | null | undefined,
): Promise<boolean> {
  try {
    return await gitIsAncestor(cwd, ref, "HEAD");
  } catch (error) {
    if (!remote) throw error;
    return gitIsAncestor(cwd, `${remote}/${ref}`, "HEAD");
  }
}

/**
 * The suggested base for a PR from the checkout's branch, recomputed when
 * the branch, its HEAD commit or the chat's open PR branches change. Null
 * until the first answer, and while `view` is null (nothing to suggest).
 */
export function useBaseSuggestion({
  view,
  cwd,
  headBranch,
  head,
  defaultBase,
  remote,
}: {
  view: PrSetView | null;
  cwd: string;
  headBranch: string | null | undefined;
  head: string | null | undefined;
  defaultBase: string | null | undefined;
  remote: string | null | undefined;
}): BaseSuggestion | null {
  const [result, setResult] = useState<{
    key: string;
    suggestion: BaseSuggestion;
  } | null>(null);
  const candidates = view && headBranch ? baseCandidates(view, headBranch) : [];
  const signature = candidates
    .map(
      (e) => `${e.snapshot.number}:${e.snapshot.headRef}:${e.snapshot.headOid}`,
    )
    .join(",");
  const key =
    view && headBranch && defaultBase
      ? [
          cwd,
          headBranch,
          head ?? "",
          defaultBase,
          remote ?? "",
          signature,
        ].join("\n")
      : null;

  useEffect(() => {
    if (!key || !view || !headBranch || !defaultBase) return;
    let cancelled = false;
    void suggestBase(view, headBranch, defaultBase, (ref) =>
      headContains(cwd, ref, remote),
    ).then((suggestion) => {
      if (!cancelled) setResult({ key, suggestion });
    });
    return () => {
      cancelled = true;
    };
    // `key` carries every input that changes the answer.
  }, [key]);

  return result && result.key === key ? result.suggestion : null;
}

/**
 * The Create PR "Base" field (mockup `.base-field`): a visible label, the
 * chosen base as `#482 · mc/tasks-panel-keyboard`, and a `Stacked` tag when
 * the choice stacks on one of the chat's PRs. A native select under the
 * value takes clicks and keys.
 */
export function PrBaseField({
  value,
  options,
  disabled = false,
  onChange,
}: {
  value: string;
  options: BaseOption[];
  disabled?: boolean;
  onChange: (ref: string) => void;
}) {
  const id = useId();
  const chosen = options.find((o) => o.ref === value) ?? {
    ref: value,
    label: value,
    stacked: false,
  };
  const listed = options.some((o) => o.ref === value)
    ? options
    : [chosen, ...options];
  return (
    <div className="pr-base-field" data-pr-base-field="">
      <label htmlFor={id}>Base</label>
      <span className="pr-base-select" title={chosen.label}>
        <span className="pr-base-value" aria-hidden="true">
          {chosen.label}
        </span>
        {chosen.stacked ? (
          <span className="pr-tag" aria-hidden="true">
            Stacked
          </span>
        ) : null}
        <ChevronDown
          aria-hidden="true"
          className="ml-auto size-3 shrink-0 text-ink-muted"
          strokeWidth={2}
        />
        <select
          id={id}
          value={chosen.ref}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {listed.map((option) => (
            <option key={option.ref} value={option.ref}>
              {option.stacked ? `${option.label}, Stacked` : option.label}
            </option>
          ))}
        </select>
      </span>
    </div>
  );
}
