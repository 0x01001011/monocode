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
import { tauriSddFs } from "../model/tauriSddFs";

export type TaskBoard = {
  sections: BoardSection[];
  plan?: BoardSection;
  statusCard: StatusCard;
  workspaces: SddWorkspaceRef[];
  selectedWorkspace?: string;
  selectWorkspace(slug: string): void;
  loading: boolean;
};

type Input = {
  projectCwd: string;
  activeSession?: Session;
  sessions: readonly StatusSessionInput[];
  visible: boolean;
  now?: () => number;
  fs?: SddFs;
  pollMs?: { visible: number; hiddenBusy: number };
};

type Loaded = { cwd: string; workspaces: SddWorkspaceRef[]; selected?: string; plan?: BoardSection };

const DEFAULT_POLL = { visible: 3000, hiddenBusy: 15000 };
const QUIET_AFTER_MS = 5 * 60_000;

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
  const fs = input.fs ?? tauriSddFs;
  const pollVisible = input.pollMs?.visible ?? DEFAULT_POLL.visible;
  const pollHidden = input.pollMs?.hiddenBusy ?? DEFAULT_POLL.hiddenBusy;
  const nowRef = useRef(input.now ?? Date.now);
  nowRef.current = input.now ?? Date.now;

  const sessionId = activeSession?.id;
  const blocks = activeSession?.blocks;
  const blockCount = blocks?.length ?? 0;
  const anyBusy = sessions.some((s) => s.busy);
  const polling = visible || anyBusy;
  const interval = visible ? pollVisible : pollHidden;

  const [loaded, setLoaded] = useState<Loaded>();
  const [choice, setChoice] = useState<{ cwd: string; slug: string }>();
  const [clock, setClock] = useState(() => nowRef.current());
  const request = useRef(0);
  const wanted = choice?.cwd === projectCwd ? choice.slug : undefined;

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const id = ++request.current;
      const next = await loadPlan(fs, projectCwd, wanted, nowRef.current());
      // A newer load, a cwd/session change or an unmount makes this result stale.
      if (cancelled || id !== request.current) return;
      setLoaded((prev) => {
        const result: Loaded = { cwd: projectCwd, ...next };
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
  }, [polling, interval, fs, projectCwd, wanted, sessionId, blockCount]);

  const selectWorkspace = useCallback(
    (slug: string) => setChoice({ cwd: projectCwd, slug }),
    [projectCwd],
  );

  const runs = useSyncExternalStore(orchestrator.subscribe, orchestrator.snapshot, orchestrator.snapshot);
  const run = useMemo(() => (sessionId ? orchestrator.run(sessionId) : undefined), [sessionId, runs]);

  const data = loaded?.cwd === projectCwd ? loaded : undefined;
  const plan = data?.plan;

  const sections = useStable(
    useMemo(() => {
      const now = nowRef.current();
      const todos = dropMirroredTodos(blocks ? buildTodoSection(blocks) : undefined, plan);
      return [
        plan,
        buildOrchestrationSection(run, now),
        blocks ? buildAgentSection(blocks, now) : undefined,
        todos,
      ].filter((s): s is BoardSection => s !== undefined);
      // `clock` re-derives times as polls complete.
    }, [plan, run, blocks, clock]),
  );

  const statusCard = useStable(
    useMemo(
      () =>
        deriveStatusCard({
          sessions: [...sessions],
          ...(sessionId ? { activeSessionId: sessionId } : {}),
          ...(plan ? { plan } : {}),
          now: nowRef.current(),
          quietAfterMs: QUIET_AFTER_MS,
        }),
      [sessions, sessionId, plan, clock],
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
  };
}
