import type { TaskActionHost } from "./useTaskActions";

/** What the app supplies; `buildTaskActionHost` turns it into the Tasks action host. */
export type TaskActionHostDeps = {
  selectSession(sessionId: string): void | Promise<void>;
  isBusy(sessionId: string): boolean;
  /** True when the session's harness can take a steer into its running turn. */
  canSteer(sessionId: string): boolean;
  /** Sends a follow-up with an explicit behavior; never an interrupt. */
  submit(sessionId: string, text: string, options: { followUpBehavior: "steer" | "queue" }): unknown;
  isMono(sessionId: string): boolean;
  /** Records a draft for the session's composer; it inserts text and never sends. */
  requestComposerPrefill(sessionId: string, text: string): void;
  scheduleReminder(sessionIds: string[], dueAt: number): void | Promise<unknown>;
  openFile(path: string, options?: { exact: true }): void;
  /** `sha` is the range's end; `subject` the range as written. */
  openCommit(sha: string, subject: string): void;
  scrollToBlock(sessionId: string, blockId: string): void;
};

const isAbsolute = (path: string): boolean => /^(\/|[A-Za-z]:[\\/])/.test(path);

/** The Tasks surfaces' host, built from plain app functions so the glue is testable without App. */
export function buildTaskActionHost(deps: TaskActionHostDeps): TaskActionHost {
  return {
    selectSession: (sessionId) => deps.selectSession(sessionId),
    isBusy: (sessionId) => deps.isBusy(sessionId),
    // The stop request must reach the running turn: a steerable harness gets it as a steer,
    // any other harness queues it (the user's "steer" setting would be refused there).
    queueMessage: async (sessionId, text) => {
      await deps.submit(sessionId, text, { followUpBehavior: deps.canSteer(sessionId) ? "steer" : "queue" });
    },
    // A Mono has its own composer, so it is only selected (the hook selects after this).
    prefillComposer: (sessionId, text) => {
      if (!deps.isMono(sessionId)) deps.requestComposerPrefill(sessionId, text);
    },
    remind: (sessionId, dueAt) => deps.scheduleReminder([sessionId], dueAt),
    openFile: (path) => deps.openFile(path, isAbsolute(path) ? { exact: true } : undefined),
    openCommit: (range) => deps.openCommit(range.split("..").pop() ?? range, range),
    scrollToBlock: (sessionId, blockId) => deps.scrollToBlock(sessionId, blockId),
  };
}
