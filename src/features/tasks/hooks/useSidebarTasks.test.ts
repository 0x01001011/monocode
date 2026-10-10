// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveQuietAfterMinutes } from "../../settings/model/tasksPrefs";
import type { SessionSummary } from "../../sessions/data/sessionStore";
import type { Block, Session } from "../../sessions/model/session";
import { deriveStatusCard, type StatusCard } from "../model/statusCard";
import { statusSessionsFromLoaded, useSidebarTasks } from "./useSidebarTasks";
import { useTaskBoard, type TaskBoard } from "./useTaskBoard";

vi.mock("./useTaskBoard", () => ({ useTaskBoard: vi.fn() }));

const T0 = 1_700_000_000_000;

function board(card: StatusCard): TaskBoard {
  return { sections: [], statusCard: card, flow: [], workspaces: [], selectWorkspace: () => {}, loading: false, loaded: true };
}
const IDLE: StatusCard = { kind: "idle", headline: "", actions: [] };
const RUNNING: StatusCard = { kind: "running", headline: "Working", actions: [] };

function summary(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    cwd: "/proj",
    harness: "codex",
    model: "",
    runtimeMode: "supervised",
    title: `Title ${id}`,
    createdAt: T0 - 10_000,
    updatedAt: T0 - 5_000,
    ...patch,
  };
}

function tool(patch: Partial<Block>): Block {
  return { id: "b", role: "tool", text: "", ...patch } as Block;
}

function active(id: string, over: Record<string, unknown> = {}): Session {
  return { id, cwd: "/proj", title: id, blocks: [], ...over } as unknown as Session;
}

type Input = Parameters<typeof useSidebarTasks>[0];
let container: HTMLDivElement;
let root: Root;
let result: ReturnType<typeof useSidebarTasks> | undefined;

function Probe({ input }: { input: Input }) {
  result = useSidebarTasks(input);
  return null;
}

function base(over: Partial<Input> = {}): Input {
  return {
    cwd: "/proj",
    sessions: [summary("a"), summary("b")],
    busySessionIds: new Set<string>(),
    approvalSessionIds: new Set<string>(),
    activeSessionId: "a",
    visible: false,
    ...over,
  };
}

function render(input: Input) {
  act(() => root.render(createElement(Probe, { input })));
}

function lastInput() {
  const calls = vi.mocked(useTaskBoard).mock.calls;
  return calls[calls.length - 1][0];
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.mocked(useTaskBoard).mockReset().mockReturnValue(board(IDLE));
  container = document.createElement("div");
  root = createRoot(container);
  result = undefined;
});

afterEach(() => {
  localStorage.clear();
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useSidebarTasks", () => {
  it("passes the project, visibility and active session to the board", () => {
    const session = active("a");
    render(base({ visible: true, activeSession: session }));
    const input = lastInput();
    expect(input.projectCwd).toBe("/proj");
    expect(input.visible).toBe(true);
    expect(input.activeSession).toBe(session);
    expect(result?.board.statusCard.kind).toBe("idle");
  });

  it("reads the plan from the active session's working copy, else the project", () => {
    render(base({ activeSession: active("a", { worktreeCwd: "/wt/mc-1" }) }));
    expect(lastInput().planCwd).toBe("/wt/mc-1");
    expect(lastInput().projectCwd).toBe("/proj");
    render(base({ activeSession: active("a") }));
    expect(lastInput().planCwd).toBe("/proj");
    render(base({ activeSession: active("a", { cwd: "/elsewhere", worktreeCwd: "/wt/x" }) }));
    expect(lastInput().planCwd).toBe("/proj");
  });

  it("reads the quiet threshold from the setting, five minutes by default", () => {
    render(base());
    expect(lastInput().quietAfterMs).toBe(5 * 60_000);
    act(() => saveQuietAfterMinutes(2));
    expect(lastInput().quietAfterMs).toBe(2 * 60_000);
  });

  it("builds one status input per session from the busy and approval sets", () => {
    render(base({ busySessionIds: new Set(["a"]), approvalSessionIds: new Set(["b"]) }));
    expect(lastInput().sessions).toEqual([
      { id: "a", title: "Title a", busy: true, needsInput: false, lastActivityAt: T0 - 5_000, workCwd: "/proj" },
      { id: "b", title: "Title b", busy: false, needsInput: true, lastActivityAt: T0 - 5_000, workCwd: "/proj" },
    ]);
  });

  it("gives each session its working copy so the plan's owners can be found", () => {
    render(base({ sessions: [summary("a", { worktreeCwd: "/wt/mc-1" }), summary("b")] }));
    expect(lastInput().sessions.map((s) => s.workCwd)).toEqual(["/wt/mc-1", "/proj"]);
  });

  it("skips hidden sessions", () => {
    render(base({ sessions: [summary("a"), summary("h", { sidebarHidden: true })] }));
    expect(lastInput().sessions.map((s) => s.id)).toEqual(["a"]);
  });

  it("takes the active session's newest tool time; a session that is not loaded keeps updatedAt", () => {
    const blocks = [
      tool({ toolStartedAt: T0 - 90_000, toolEndedAt: T0 - 80_000 }),
      tool({ toolStartedAt: T0 - 3_000 }),
    ];
    render(base({ activeSession: active("a", { blocks }) }));
    const [a, b] = lastInput().sessions;
    expect(a.lastActivityAt).toBe(T0 - 3_000);
    expect(b.lastActivityAt).toBe(T0 - 5_000);
  });

  it("a loaded session's activity comes from its blocks, never from the persisted updatedAt", () => {
    const blocks = [tool({ toolStartedAt: T0 - 90_000, toolEndedAt: T0 - 80_000 })];
    render(base({ activeSession: active("a", { blocks }) }));
    expect(lastInput().sessions[0].lastActivityAt).toBe(T0 - 80_000);
  });

  it("a busy background session with an old updatedAt but a recent tool time is not quiet", () => {
    const MIN = 60_000;
    const background = active("b", { busy: true, blocks: [tool({ toolStartedAt: T0 - 30_000 })] });
    render(
      base({
        sessions: [summary("a"), summary("b", { updatedAt: T0 - 60 * MIN })],
        busySessionIds: new Set(["b"]),
        activeSession: active("a"),
        loadedSessions: [active("a"), background],
      }),
    );
    const inputs = lastInput().sessions;
    expect(inputs[1].lastActivityAt).toBe(T0 - 30_000);
    expect(deriveStatusCard({ sessions: inputs, activeSessionId: "a", now: T0, quietAfterMs: 5 * MIN }).kind).not.toBe("quiet");
  });

  it("quotes the first line of the pending question for the active session only", () => {
    const pendingQuestion = {
      requestId: 1,
      questions: [{ id: "q", prompt: "  Which   database?\nPostgres or SQLite", multiSelect: false, allowCustom: false, options: [] }],
    };
    render(
      base({
        approvalSessionIds: new Set(["a", "b"]),
        activeSession: active("a", { pendingQuestion }),
      }),
    );
    const [a, b] = lastInput().sessions;
    expect(a.question).toBe("Which database?");
    expect(b).not.toHaveProperty("question");
    expect(a).not.toHaveProperty("askedAt");
  });

  it("omits the question when none is pending", () => {
    render(base({ activeSession: active("a") }));
    expect(lastInput().sessions[0]).not.toHaveProperty("question");
  });

  it("keeps the same session inputs while nothing relevant changes", () => {
    const input = base();
    render(input);
    const first = lastInput().sessions;
    render({ ...input });
    expect(lastInput().sessions).toBe(first);
  });

  describe("running", () => {
    it("is true while a session is busy", () => {
      render(base({ visible: true, busySessionIds: new Set(["a"]) }));
      expect(result?.running).toBe(true);
    });

    it("is true while the board itself is running even if no session is busy", () => {
      vi.mocked(useTaskBoard).mockReturnValue(board(RUNNING));
      render(base({ visible: true }));
      expect(result?.running).toBe(true);
    });

    it("is false when nothing is running", () => {
      render(base({ visible: true }));
      expect(result?.running).toBe(false);
    });
  });

  describe("remote project", () => {
    it("reads no plan files and sends no sessions, but still builds the transcript sections", () => {
      render(
        base({
          remote: true,
          visible: true,
          busySessionIds: new Set(["a"]),
          approvalSessionIds: new Set(["b"]),
          activeSession: active("a"),
        }),
      );
      const input = lastInput();
      expect(input.visible).toBe(true);
      expect(input.readPlan).toBe(false);
      expect(input.sessions).toEqual([]);
      expect(result?.running).toBe(false);
    });
  });
});

describe("statusSessionsFromLoaded", () => {
  const loaded = (id: string, over: Record<string, unknown> = {}): Session => active(id, over);

  it("keeps this project's visible sessions and reads busy and waiting from them", () => {
    const sessions = [
      loaded("a", { busy: true }),
      loaded("b", { pendingQuestion: { requestId: 1, questions: [] } }),
      loaded("other", { cwd: "/elsewhere" }),
      loaded("hidden", { sidebarHidden: true }),
      loaded("temp", { ephemeral: true }),
    ];
    expect(statusSessionsFromLoaded(sessions, "/proj", "a")).toEqual([
      { id: "a", title: "a", busy: true, needsInput: false, workCwd: "/proj" },
      { id: "b", title: "b", busy: false, needsInput: true, workCwd: "/proj" },
    ]);
  });

  it("marks a worker's lead as busy and takes tool times from each session's own blocks", () => {
    const sessions = [
      loaded("lead"),
      loaded("worker", { busy: true, orchestrationLeadId: "lead", sidebarHidden: true, blocks: [] }),
      loaded("a", { blocks: [tool({ toolEndedAt: T0 - 2_000 })] }),
    ];
    const [lead, a] = statusSessionsFromLoaded(sessions, "/proj", "lead");
    expect(lead.busy).toBe(true);
    expect(a.lastActivityAt).toBe(T0 - 2_000);
  });

  describe("quiet detection from loaded sessions", () => {
    const MIN = 60_000;
    const user = (patch: Partial<Block>): Block => ({ id: "u", role: "user", text: "go", ...patch }) as Block;
    const only = (session: Session) => statusSessionsFromLoaded([session], "/proj", session.id);
    const quiet = (inputs: ReturnType<typeof only>) =>
      deriveStatusCard({ sessions: inputs, activeSessionId: "a", now: T0, quietAfterMs: 5 * MIN }).kind === "quiet";

    it("a new turn start after an old tool call is activity, so a busy session is not quiet", () => {
      const blocks = [tool({ toolStartedAt: T0 - 20 * MIN, toolEndedAt: T0 - 19 * MIN }), user({ startedAt: T0 - MIN })];
      const inputs = only(loaded("a", { busy: true, blocks }));
      expect(inputs[0].lastActivityAt).toBe(T0 - MIN);
      expect(quiet(inputs)).toBe(false);
    });

    it("a message that joined a running turn counts through sentAt", () => {
      const blocks = [tool({ toolEndedAt: T0 - 20 * MIN }), user({ sentAt: T0 - 2 * MIN })];
      expect(only(loaded("a", { busy: true, blocks }))[0].lastActivityAt).toBe(T0 - 2 * MIN);
    });

    it("streaming text as the newest block leaves activity unknown, never quiet", () => {
      const blocks = [
        tool({ toolStartedAt: T0 - 20 * MIN, toolEndedAt: T0 - 19 * MIN }),
        { id: "t", role: "assistant", text: "thinking out loud", streaming: true } as Block,
      ];
      const inputs = only(loaded("a", { busy: true, blocks }));
      expect(inputs[0].lastActivityAt).toBeUndefined();
      expect(quiet(inputs)).toBe(false);
    });

    it("an in-progress tool with an old start is quiet after the threshold", () => {
      const blocks = [
        tool({ toolStartedAt: T0 - 20 * MIN, toolEndedAt: T0 - 19 * MIN }),
        tool({ id: "b2", toolStartedAt: T0 - 9 * MIN, streaming: true }),
      ];
      const inputs = only(loaded("a", { busy: true, blocks }));
      expect(inputs[0].lastActivityAt).toBe(T0 - 9 * MIN);
      expect(quiet(inputs)).toBe(true);
    });
  });
});
