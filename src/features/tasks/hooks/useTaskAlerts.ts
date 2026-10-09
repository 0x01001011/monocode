import { useEffect, useRef } from "react";
import { notifyTaskAlert, type TaskAlertTarget } from "../../notifications/model/notifications";
import type { StatusCard } from "../model/statusCard";
import { taskAlertsBetween } from "../model/taskAlerts";

type Options = {
  /** False until the first plan load for the project has finished; the card is not trustworthy before. */
  ready: boolean;
  /** A new value starts over: the previous card belonged to another project. */
  projectCwd: string;
  findSession(sessionId: string): TaskAlertTarget | undefined;
  activeSessionId?: string;
  notify?: typeof notifyTaskAlert;
};

/**
 * Sends an OS notification when the status card enters struggling, quiet or a finished plan.
 * The first card seen once the board is ready only sets the baseline, so opening the app, a
 * project or the tab never replays an old state. A board that is not ready starts over.
 */
export function useTaskAlerts(card: StatusCard, options: Options): void {
  const previous = useRef<{ card: StatusCard; projectCwd: string } | undefined>(undefined);
  const latest = useRef(options);
  latest.current = options;

  const { ready, projectCwd } = options;
  useEffect(() => {
    const before = previous.current;
    if (!ready) {
      previous.current = undefined;
      return;
    }
    previous.current = { card, projectCwd };
    if (before === undefined || before.projectCwd !== projectCwd) return;
    const { findSession, activeSessionId, notify = notifyTaskAlert } = latest.current;
    for (const alert of taskAlertsBetween(before.card, card)) {
      const sessionId = card.sessionId ?? activeSessionId;
      const target = sessionId ? findSession(sessionId) : undefined;
      if (!target) continue;
      void notify(target, alert, target.id === activeSessionId);
    }
  }, [card, ready, projectCwd]);
}
