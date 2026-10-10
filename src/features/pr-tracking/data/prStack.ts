import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { PR_SET_CHANGED_EVENT, type PrStackView } from "../model/types";

let warned = false;

function warnOnce(error: unknown) {
  if (warned) return;
  warned = true;
  console.warn("[pr-tracking] pr_stack_for failed", error);
}

type Answer = { ok: true; value: PrStackView | null } | { ok: false };

/** Null (no snapshot) or a view with array `entries` and `group.members`. */
function isStackPayload(value: unknown): value is PrStackView | null {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const view = value as { entries?: unknown; group?: { members?: unknown } };
  return Array.isArray(view.entries) && Array.isArray(view.group?.members);
}

async function askStack(repo: string, number: number): Promise<Answer> {
  if (!repo.trim() || !Number.isInteger(number) || number <= 0)
    return { ok: true, value: null };
  try {
    const value = await invoke<unknown>("pr_stack_for", { repo, number });
    if (!isStackPayload(value)) {
      warnOnce(new Error("unexpected payload shape"));
      return { ok: false };
    }
    return { ok: true, value };
  } catch (error) {
    warnOnce(error);
    return { ok: false };
  }
}

/**
 * The PR's stack view from stored snapshots (a single-member group when it
 * stacks with nothing), or null when it has no snapshot yet or the lookup
 * failed. Never throws.
 */
export async function getPrStack(
  repo: string,
  number: number,
): Promise<PrStackView | null> {
  const answer = await askStack(repo, number);
  return answer.ok ? answer.value : null;
}

type Held = { key: string; value: PrStackView | null };

/**
 * `getPrStack` kept fresh: refetched on every `pr-set-changed`, whatever
 * chats it names, since a stack spans chats. Null until the first answer and
 * whenever the PR has no stack; a failed refetch keeps the last answer.
 */
export function usePrStack(
  repo: string | null | undefined,
  number: number | null | undefined,
): PrStackView | null {
  const key =
    repo?.trim() && number ? `${repo.trim().toLowerCase()}#${number}` : "";
  const [held, setHeld] = useState<Held>({ key: "", value: null });

  useEffect(() => {
    if (!key || !repo || !number) return;
    let alive = true;
    let serial = 0;
    const load = () => {
      const mine = ++serial;
      void askStack(repo, number).then((answer) => {
        if (!alive || mine !== serial || !answer.ok) return;
        setHeld((current) =>
          current.key === key &&
          JSON.stringify(current.value) === JSON.stringify(answer.value)
            ? current
            : { key, value: answer.value },
        );
      });
    };
    load();
    let unlisten: (() => void) | null = null;
    listen(PR_SET_CHANGED_EVENT, load)
      .then((stop) => {
        if (alive) unlisten = stop;
        else stop();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [key, repo, number]);

  return held.key === key ? held.value : null;
}
