import { createContext, useCallback, useMemo, useRef } from "react";
import type { StatusAction, StatusCard } from "../model/statusCard";
import { changeDecisionText, effectForAction, effectForNode, type TaskActionEffect } from "../model/taskActions";
import type { BoardNode, BoardNote, BoardSection } from "../model/taskBoard";
import { snoozeSession } from "../model/taskSnooze";

/** What the app can do for the Tasks surfaces. The hook owns the mapping; App only supplies these. */
export type TaskActionHost = {
  selectSession(sessionId: string): void | Promise<void>;
  /** Sends `text` to the session as a follow-up. It never interrupts a running turn. */
  queueMessage(sessionId: string, text: string): void | Promise<unknown>;
  /** Puts `text` in the session's composer without sending it. */
  prefillComposer(sessionId: string, text: string): void | Promise<void>;
  openFile(path: string): void;
  /** `range` is a sha or `a..b`. */
  openCommit(range: string): void;
  /** Asks the session's transcript to scroll to a block once it is on screen. */
  scrollToBlock?(sessionId: string, blockId: string): void;
  snooze?(sessionId: string, ms: number): void;
};

export type TaskActions = {
  onAction(action: StatusAction, card: StatusCard): void;
  /** `sessionId` is the board's own session when it is not the focused one (an editor tab). */
  onOpenNode(node: BoardNode, section: BoardSection, sessionId?: string): void;
  onOpenPlan(path: string): void;
  onChangeDecision(note: BoardNote, sessionId?: string): void;
};

/** Lets a board in an editor tab reach the handlers without threading props through the pane tree. */
export const TaskActionsContext = createContext<TaskActions | undefined>(undefined);

function run(host: TaskActionHost, effect: TaskActionEffect): void {
  switch (effect.kind) {
    case "select-session":
      void host.selectSession(effect.sessionId);
      return;
    case "queue-message":
      void host.queueMessage(effect.sessionId, effect.text);
      return;
    case "prefill-composer":
      void host.prefillComposer(effect.sessionId, effect.text);
      return;
    case "snooze":
      (host.snooze ?? snoozeSession)(effect.sessionId, effect.ms);
      return;
    case "open-file":
      host.openFile(effect.path);
      return;
    case "open-commit":
      host.openCommit(effect.range);
      return;
    case "scroll-transcript":
      // The jump is recorded first so the transcript consumes it as soon as it shows.
      host.scrollToBlock?.(effect.sessionId, effect.blockId);
      void host.selectSession(effect.sessionId);
      return;
    case "none":
      return;
  }
}

export function useTaskActions(host: TaskActionHost, ctx: { projectCwd: string; activeSessionId?: string }): TaskActions {
  const latest = useRef({ host, ctx });
  latest.current = { host, ctx };

  const onAction = useCallback((action: StatusAction, card: StatusCard) => {
    const { host, ctx } = latest.current;
    run(host, effectForAction(action, card, { activeSessionId: ctx.activeSessionId }));
  }, []);
  const onOpenNode = useCallback((node: BoardNode, section: BoardSection, sessionId?: string) => {
    const { host, ctx } = latest.current;
    run(host, effectForNode(node, section, { projectCwd: ctx.projectCwd, sessionId: sessionId ?? ctx.activeSessionId }));
  }, []);
  const onOpenPlan = useCallback((path: string) => latest.current.host.openFile(path), []);
  const onChangeDecision = useCallback((note: BoardNote, sessionId?: string) => {
    const { host, ctx } = latest.current;
    const target = sessionId ?? ctx.activeSessionId;
    if (target) run(host, { kind: "prefill-composer", sessionId: target, text: changeDecisionText(note) });
  }, []);

  return useMemo(() => ({ onAction, onOpenNode, onOpenPlan, onChangeDecision }), [onAction, onOpenNode, onOpenPlan, onChangeDecision]);
}
