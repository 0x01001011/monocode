import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { orchestrator } from "../../orchestration/model/orchestration";
import type { Session } from "../../sessions/model/session";
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
} from "../model/sections";
import { deriveStatusCard, type StatusCard, type StatusSessionInput } from "../model/statusCard";
import type { BoardSection } from "../model/taskBoard";
import { applySnoozes, snoozeVersion, subscribeSnoozes } from "../model/taskSnooze";
import { tauriSddFs } from "../model/tauriSddFs";

export type TaskBoard = {
  sections: BoardSection[];
  plan?: BoardSection;
  statusCard: StatusCard;
  workspaces: SddWorkspaceRef[];
  selectedWorkspace?: string;
  selectWorkspace(slug: string): void;
  loading: boolean;
  /** The plan for this project has been read at least once, so the status card is trustworthy. */
  loaded: boolean;
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
};

type Loaded = { cwd: string; workspaces: SddWorkspaceRef[]; selected?: string; plan?: BoardSection };

const DEFAULT_POLL = { visible: 3000, hiddenBusy: 15000 };
export const DEFAULT_QUIET_AFTER_MS = 5 * 60_000;
/** What a closed panel exposes: only the status card and tab badge are read then. */
const NO_SECTIONS: BoardSection[] = [];

/** Keeps the previous reference while the serialized content is unchanged. */
function useStable<T>(value: T): T {
  const key = JSON.stringify(value);
  return useMemo(() => value, [key]);
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
  // Transcript growth reloads at once only for a panel on screen; a hidden one keeps its cadence.
  const blockCount = visible ? (blocks?.length ?? 0) : 0;
  const anyBusy = sessions.some((s) => s.busy);
  const polling = visible || anyBusy;
  const interval = visible ? pollVisible : pollHidden;

  const [loaded, setLoaded] = useState<Loaded>();
  const [choice, setChoice] = useState<{ cwd: string; slug: string }>();
  const [clock, setClock] = useState(() => nowRef.current());
  const request = useRef(0);
  const wanted = choice?.cwd === planCwd ? choice.slug : undefined;

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
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
      try {
        await load();
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), interval);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [polling, interval, fs, planCwd, wanted, sessionId, blockCount]);

  const selectWorkspace = useCallback(
    (slug: string) => setChoice({ cwd: planCwd, slug }),
    [planCwd],
  );

  const runs = useSyncExternalStore(orchestrator.subscribe, orchestrator.snapshot, orchestrator.snapshot);
  const run = useMemo(() => (sessionId ? orchestrator.run(sessionId) : undefined), [sessionId, runs]);

  const data = loaded?.cwd === planCwd ? loaded : undefined;
  const plan = data?.plan;

  const sections = useStable(
    useMemo(() => {
      if (!visible) return NO_SECTIONS;
      const now = nowRef.current();
      const todos = dropMirroredTodos(blocks ? buildTodoSection(blocks) : undefined, plan);
      return [
        plan,
        buildOrchestrationSection(run, now),
        blocks ? buildAgentSection(blocks, now) : undefined,
        todos,
      ].filter((s): s is BoardSection => s !== undefined);
      // `clock` re-derives times as polls complete.
    }, [visible, plan, run, blocks, clock]),
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
          now: nowRef.current(),
          quietAfterMs,
        }),
      [sessions, sessionId, plan, clock, quietAfterMs, snoozes],
    ),
  );

  const workspaces = useStable(data?.workspaces ?? []);
  const planSection = sections.find((s) => s.source === "sdd");
  return {
    sections,
    ...(planSection ? { plan: planSection } : {}),
    statusCard,
    workspaces,
    ...(data?.selected ? { selectedWorkspace: data.selected } : {}),
    selectWorkspace,
    loading: polling && data === undefined,
    loaded: data !== undefined,
  };
}
