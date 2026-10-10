import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { orchestrator } from "../../orchestration/model/orchestration";
import { sameProjectPath } from "../../projects/model/recents";
import type { Block, Session } from "../../sessions/model/session";
import { deriveFlow, type FlowPhase } from "../model/flow";
import { gapsFor, type Gap } from "../model/gaps";
import { shipReadiness, type Ship } from "../model/ship";
import { buildSddSection } from "../model/sddBoard";
import {
  findSddWorkspaces,
  loadSddSnapshot,
  type SddFs,
  type SddWorkspaceRef,
} from "../model/sddWorkspace";
import {
  buildAgentSection,
  buildOrchestrationSection,
  buildTodoSection,
  dropMirroredTodos,
  isSddStageAgent,
} from "../model/sections";
import { deriveStatusCard, type StatusCard, type StatusSessionInput } from "../model/statusCard";
import type { BoardSection } from "../model/taskBoard";
import { applySnoozes, snoozeVersion, subscribeSnoozes } from "../model/taskSnooze";
import { tauriSddFs } from "../model/tauriSddFs";
import { lastTestRun, type TestRun } from "../model/testRuns";

export type TaskBoard = {
  sections: BoardSection[];
  plan?: BoardSection;
  statusCard: StatusCard;
  /** Spec, plan, build, check: empty without a plan or while the panel is hidden. */
  flow: FlowPhase[];
  /** The newest test run in the session; absent when none ran (or while the panel is hidden). */
  testRun?: TestRun;
  /** Whether the branch can ship; absent without a plan or while the panel is hidden. */
  ship?: Ship;
  /** What the plan is missing (no commit, parked at close, unticked steps, no final review). */
  gaps: Gap[];
  workspaces: SddWorkspaceRef[];
  selectedWorkspace?: string;
  selectWorkspace(slug: string): void;
  loading: boolean;
  /** The plan for this project has been read at least once, so the status card is trustworthy. */
  loaded: boolean;
  /** Plan files cannot be read here (a remote project); the transcript sections still show. */
  planFilesUnavailable?: boolean;
};

type Input = {
  projectCwd: string;
  /**
   * Where the plan workspaces live: the session's working copy (its worktree), which the
   * SDD controller writes into. Defaults to `projectCwd`.
   */
  planCwd?: string;
  activeSession?: Session;
  sessions: readonly StatusSessionInput[];
  visible: boolean;
  /** How long a busy session may stay silent before the card calls it quiet. */
  quietAfterMs?: number;
  now?: () => number;
  fs?: SddFs;
  pollMs?: { visible: number; hiddenBusy: number };
  /**
   * The status card is read while hidden (the sidebar's tab badge and alerts), so busy
   * sessions keep the slow hidden poll going. Default true; a board tab passes false.
   */
  needsStatusWhenHidden?: boolean;
  /** False when the plan files are out of reach (a remote project): no fs reads at all. */
  readPlan?: boolean;
};

type Loaded = { cwd: string; workspaces: SddWorkspaceRef[]; selected?: string; plan?: BoardSection };

const DEFAULT_POLL = { visible: 3000, hiddenBusy: 15000 };
export const DEFAULT_QUIET_AFTER_MS = 5 * 60_000;
/** What a closed panel exposes: only the status card and tab badge are read then. */
const NO_SECTIONS: BoardSection[] = [];
const NO_FLOW: FlowPhase[] = [];
const NO_GAPS: Gap[] = [];

/** Keeps the previous reference while the serialized content is unchanged. */
function useStable<T>(value: T): T {
  const key = JSON.stringify(value);
  return useMemo(() => value, [key]);
}

/** Tool calls that have finished (they carry an end time). */
function completedTools(blocks: readonly Block[] | undefined): number {
  let count = 0;
  for (const block of blocks ?? []) if (block.role === "tool" && block.toolEndedAt !== undefined) count++;
  return count;
}

/**
 * Subagents working right now: the transcript's own running agents, plus the plan's
 * running implementer and reviewer stages (the plan section leaves those agents out of
 * the agents section, so nothing is counted twice). The final review's stages are not
 * counted: they show in Check as "final review running".
 */
function countSubagentsRunning(sections: readonly BoardSection[], plan: BoardSection): number {
  const agents = sections.find((s) => s.source === "agents")?.nodes.filter((n) => n.status === "running").length ?? 0;
  const stages = plan.nodes.reduce(
    (sum, node) => sum + (node.stages?.filter((stage) => stage.status === "running").length ?? 0),
    0,
  );
  return agents + stages;
}

/** One load: workspace list, then the selected (else newest) workspace. Never rejects. */
async function loadPlan(
  fs: SddFs,
  cwd: string,
  wanted: string | undefined,
  now: number,
): Promise<Omit<Loaded, "cwd">> {
  try {
    const workspaces = await findSddWorkspaces(fs, cwd);
    const ref = workspaces.find((w) => w.slug === wanted) ?? workspaces[0];
    if (!ref) return { workspaces };
    const section = buildSddSection(await loadSddSnapshot(fs, ref), now);
    return { workspaces, selected: ref.slug, ...(section.nodes.length ? { plan: section } : {}) };
  } catch {
    return { workspaces: [] };
  }
}

export function useTaskBoard(input: Input): TaskBoard {
  const { projectCwd, activeSession, sessions, visible } = input;
  const planCwd = input.planCwd ?? projectCwd;
  const fs = input.fs ?? tauriSddFs;
  const pollVisible = input.pollMs?.visible ?? DEFAULT_POLL.visible;
  const pollHidden = input.pollMs?.hiddenBusy ?? DEFAULT_POLL.hiddenBusy;
  const quietAfterMs = input.quietAfterMs ?? DEFAULT_QUIET_AFTER_MS;
  const nowRef = useRef(input.now ?? Date.now);
  nowRef.current = input.now ?? Date.now;

  const sessionId = activeSession?.id;
  const blocks = activeSession?.blocks;
  // A completed tool call reloads at once, only for a panel on screen; a hidden one keeps its cadence.
  const toolsDone = visible ? completedTools(blocks) : 0;
  const anyBusy = sessions.some((s) => s.busy);
  const readPlan = input.readPlan ?? true;
  const polling = readPlan && (visible || (anyBusy && (input.needsStatusWhenHidden ?? true)));
  const interval = visible ? pollVisible : pollHidden;
  const intervalRef = useRef(interval);
  intervalRef.current = interval;

  const [loaded, setLoaded] = useState<Loaded>();
  // Another plan root drops the old result at once, even with polling off, so coming
  // back to it never reads as loaded before a fresh read.
  if (loaded && loaded.cwd !== planCwd) setLoaded(undefined);
  const [choice, setChoice] = useState<{ cwd: string; slug: string }>();
  const [clock, setClock] = useState(() => nowRef.current());
  const request = useRef(0);
  const wanted = choice?.cwd === planCwd ? choice.slug : undefined;

  // Asks the running poll loop for a fresh load: at once when idle, else one follow-up
  // after the load in flight settles. Never cancels a load. Unset while not polling.
  const kick = useRef<(() => void) | undefined>(undefined);
  // These run before the poll effect, so a change that also restarts the loop finds no
  // loop to kick (React runs every cleanup first) and adds no load of its own.
  const seenTools = useRef({ key: "", count: 0 });
  useEffect(() => {
    const key = `${sessionId ?? ""}|${visible}`;
    const seen = seenTools.current;
    seenTools.current = { key, count: toolsDone };
    if (seen.key === key && toolsDone > seen.count) kick.current?.();
  }, [sessionId, visible, toolsDone]);
  // Opening the panel refreshes at once; closing it keeps the current schedule.
  useEffect(() => {
    if (visible) kick.current?.();
  }, [visible]);

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let queued = false;
    const load = async () => {
      const id = ++request.current;
      const next = await loadPlan(fs, planCwd, wanted, nowRef.current());
      // A newer load, a cwd/session change or an unmount makes this result stale.
      if (cancelled || id !== request.current) return;
      setLoaded((prev) => {
        const result: Loaded = { cwd: planCwd, ...next };
        return prev && JSON.stringify(prev) === JSON.stringify(result) ? prev : result;
      });
      setClock(nowRef.current());
    };
    // The next poll starts only after this one settles, so a slow load is never starved.
    const poll = async () => {
      inFlight = true;
      try {
        await load();
      } finally {
        inFlight = false;
        if (!cancelled) {
          if (queued) {
            queued = false;
            void poll();
          } else {
            timer = setTimeout(() => void poll(), intervalRef.current);
          }
        }
      }
    };
    kick.current = () => {
      if (inFlight) {
        queued = true;
        return;
      }
      clearTimeout(timer);
      void poll();
    };
    void poll();
    return () => {
      cancelled = true;
      kick.current = undefined;
      clearTimeout(timer);
    };
  }, [polling, fs, planCwd, wanted, sessionId]);

  const selectWorkspace = useCallback(
    (slug: string) => setChoice({ cwd: planCwd, slug }),
    [planCwd],
  );

  const runs = useSyncExternalStore(orchestrator.subscribe, orchestrator.snapshot, orchestrator.snapshot);
  const run = useMemo(() => (sessionId ? orchestrator.run(sessionId) : undefined), [sessionId, runs]);

  const data = loaded?.cwd === planCwd ? loaded : undefined;
  const plan = data?.plan;
  const slug = data?.selected;

  // Only sessions working in the plan root can run the plan; the active one is not assumed.
  const planOwnerIds = useStable(
    sessions.filter((s) => s.workCwd !== undefined && sameProjectPath(s.workCwd, planCwd)).map((s) => s.id),
  );

  const ownsPlan = sessionId !== undefined && planOwnerIds.includes(sessionId);

  const sections = useStable(
    useMemo(() => {
      if (!visible) return NO_SECTIONS;
      const now = nowRef.current();
      const todos = dropMirroredTodos(blocks ? buildTodoSection(blocks) : undefined, plan);
      return [
        plan,
        buildOrchestrationSection(run, now),
        // The plan's own implementers and reviewers already show as its stages.
        blocks ? buildAgentSection(blocks, now, plan && slug ? (b) => isSddStageAgent(b, slug, ownsPlan) : undefined) : undefined,
        todos,
      ].filter((s): s is BoardSection => s !== undefined);
      // `clock` re-derives times as polls complete.
    }, [visible, plan, slug, ownsPlan, run, blocks, clock]),
  );

  // A snooze changes the card at once, without waiting for the next poll.
  const snoozes = useSyncExternalStore(subscribeSnoozes, snoozeVersion, snoozeVersion);
  const statusCard = useStable(
    useMemo(
      () =>
        deriveStatusCard({
          sessions: [...applySnoozes(sessions, nowRef.current())],
          ...(sessionId ? { activeSessionId: sessionId } : {}),
          ...(plan ? { plan } : {}),
          planOwnerIds,
          now: nowRef.current(),
          quietAfterMs,
        }),
      [sessions, sessionId, plan, planOwnerIds, clock, quietAfterMs, snoozes],
    ),
  );

  const workspaces = useStable(data?.workspaces ?? []);
  const planSection = sections.find((s) => s.source === "sdd");
  // The last test run feeds both Check and Ship; `clock` keeps its age current as polls complete.
  const testRun = useStable(useMemo(() => (visible ? lastTestRun(blocks) : undefined), [visible, blocks, clock]));
  const gaps = useStable(useMemo(() => (visible && planSection ? gapsFor(planSection) : NO_GAPS), [visible, planSection]));
  const ship = useStable(
    useMemo(() => (visible && planSection ? shipReadiness(planSection, testRun) : undefined), [visible, planSection, testRun]),
  );
  const flow = useStable(
    useMemo(
      () =>
        visible && planSection
          ? deriveFlow({
              plan: planSection,
              ...(ship ? { ship } : {}),
              ...(blocks ? { blocks } : {}),
              subagentsRunning: countSubagentsRunning(sections, planSection),
              now: nowRef.current(),
              planRoot: planCwd,
            })
          : NO_FLOW,
      // `clock` re-derives the age of the last test run as polls complete.
      [visible, planSection, sections, blocks, clock, planCwd, ship],
    ),
  );
  return {
    sections,
    ...(planSection ? { plan: planSection } : {}),
    statusCard,
    flow,
    ...(testRun ? { testRun } : {}),
    ...(ship ? { ship } : {}),
    gaps,
    workspaces,
    ...(data?.selected ? { selectedWorkspace: data.selected } : {}),
    selectWorkspace,
    loading: polling && data === undefined,
    loaded: data !== undefined,
    ...(readPlan ? {} : { planFilesUnavailable: true }),
  };
}
