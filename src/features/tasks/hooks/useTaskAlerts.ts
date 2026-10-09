import { useEffect, useRef } from "react";
import { notifyTaskAlert, type TaskAlertTarget } from "../../notifications/model/notifications";
import type { StatusCard } from "../model/statusCard";
import { taskAlertsBetween } from "../model/taskAlerts";

type Options = {
  findSession(sessionId: string): TaskAlertTarget | undefined;
  activeSessionId?: string;
  notify?: typeof notifyTaskAlert;
};

/**
 * Sends an OS notification when the status card enters struggling, quiet or a finished plan.
 * The first card seen only sets the baseline, so reopening the app never replays an old state.
 */
export function useTaskAlerts(card: StatusCard, options: Options): void {
  const previous = useRef<StatusCard | undefined>(undefined);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const before = previous.current;
    previous.current = card;
    if (before === undefined) return;
    const { findSession, activeSessionId, notify = notifyTaskAlert } = latest.current;
    for (const alert of taskAlertsBetween(before, card)) {
      const sessionId = card.sessionId ?? activeSessionId;
      const target = sessionId ? findSession(sessionId) : undefined;
      if (!target) continue;
      void notify(target, alert, target.id === activeSessionId);
    }
  }, [card]);
}
