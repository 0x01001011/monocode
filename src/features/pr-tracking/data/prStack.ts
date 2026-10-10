import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { PR_SET_CHANGED_EVENT, type PrStackView } from "../model/types";

let warned = false;

type Answer = { ok: true; value: PrStackView | null } | { ok: false };

async function askStack(repo: string, number: number): Promise<Answer> {
  if (!repo.trim() || !Number.isInteger(number) || number <= 0)
    return { ok: true, value: null };
  try {
    const value = await invoke<PrStackView | null>("pr_stack_for", {
      repo,
      number,
    });
    return { ok: true, value: value ?? null };
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn("[pr-tracking] pr_stack_for failed", error);
    }
    return { ok: false };
  }
}

/**
 * The stack holding `repo#number` from stored snapshots, or null when the PR
 * is in no stack, has no snapshot yet, or the lookup failed. Never throws.
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
