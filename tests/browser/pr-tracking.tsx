import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { usePrSet, usePrSummaries } from "../../src/features/pr-tracking/data/prTracking";
import { PR_SET_CHANGED_EVENT, type PrSetView } from "../../src/features/pr-tracking/model/types";
import { PrChip } from "../../src/features/pr-tracking/ui/PrChip";
import { PrInboxStack } from "../../src/features/pr-tracking/ui/PrInboxStack";
import { PrSection } from "../../src/features/pr-tracking/ui/PrSection";
import { PrSidebarSlot } from "../../src/features/pr-tracking/ui/PrSidebarGlyph";
import { CwdPicker } from "../../src/features/projects/ui/CwdPicker";
import { ContextMeter } from "../../src/features/sessions/ui/ContextMeter";
import { seedProjectBranches } from "../../src/features/source-control/hooks/useProjectBranches";
import { BranchPicker } from "../../src/features/source-control/ui/BranchPicker";
import { WorkspaceIdentity } from "../../src/features/workspace/ui/WorkspacePicker";
import { IS_MAC } from "../../src/platform/tauri/platform";
import { GitBranch } from "../../src/shared/ui/icons";
import "../../src/styles/index.css";
import {
  BRANCH,
  CWD,
  FIXTURES,
  NEIGHBOR_SESSION,
  NEIGHBOR_TITLE,
  RAILS,
  SESSION,
  SESSION_TITLE,
  neighborView,
  stackFor,
  summaryOf,
  type FixtureName,
} from "./pr-tracking.fixtures";

/**
 * Browser harness for chat PR tracking. Renders the real components (chip,
 * card, sidebar glyph, Changes-panel section, Inbox rail and health line)
 * against fixture payloads served through Tauri's own `mockIPC`, so the real
 * `invoke` / `listen` data layer, store and hooks run unchanged.
 *
 * Query: `?fixture=<name>` (see `FIXTURES`), `?theme=light`, `?w=<px>` the
 * composer header row width, `?pw=<px>` the Changes panel width (default
 * min(w, 480)), `?iw=<px>` the Inbox column width (default 640).
 */

const params = new URLSearchParams(location.search);
const fixtureName = (params.get("fixture") ?? "stack") as FixtureName;
const makeFixture = FIXTURES[fixtureName] ?? FIXTURES.stack;
const w = Number(params.get("w") ?? 900);
const pw = Number(params.get("pw") ?? Math.min(w, 480));
const iw = Number(params.get("iw") ?? 640);

const root = document.documentElement;
root.classList.toggle("theme-light", params.get("theme") === "light");
root.classList.toggle("is-mac", IS_MAC);

const NOW = Date.now();
const views = new Map<string, PrSetView>([
  [SESSION, makeFixture(NOW)],
  [NEIGHBOR_SESSION, neighborView(NOW)],
]);

const calls: { cmd: string; args: unknown }[] = [];

mockIPC(
  (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "pr_session_set":
        return views.get(String(a.sessionId)) ?? null;
      case "pr_summaries": {
        const out: Record<string, unknown> = {};
        for (const [id, v] of views) {
          const summary = summaryOf(v, Date.now());
          if (summary) out[id] = summary;
        }
        return out;
      }
      case "pr_stack_for":
        return stackFor(String(a.repo), Number(a.number));
      case "pr_dismiss": {
        const v = views.get(String(a.sessionId));
        if (v) {
          views.set(String(a.sessionId), {
            ...v,
            entries: v.entries.map((e) =>
              e.snapshot.repo === a.repo && e.snapshot.number === a.number
                ? { ...e, dismissed: Boolean(a.dismissed) }
                : e,
            ),
          });
        }
        return null;
      }
      case "pr_refresh":
        // The tracker answers a refresh with an event once it has polled.
        setTimeout(
          () => void emit(PR_SET_CHANGED_EVENT, { sessionIds: [a.sessionId] }),
          0,
        );
        return null;
      case "git_branches":
        return {
          current: BRANCH,
          detached: false,
          branches: [
            { name: BRANCH, current: true, remote: "origin" },
            { name: "main", current: false, remote: "origin" },
          ],
        };
      default:
        return null;
    }
  },
  { shouldMockEvents: true },
);

seedProjectBranches(CWD, {
  current: BRANCH,
  detached: false,
  branches: [{ name: BRANCH, current: true, remote: "origin" }],
});

const noop = () => undefined;

function Composer({ width }: { width: number }) {
  return (
    <div
      id="composer"
      className="rounded-lg border border-content/10 bg-background-base"
      // The header row is `width` wide inside the 1px frame.
      style={{ width: width + 2 }}
    >
      <div
        id="composer-head"
        className="composer-head flex min-w-0 items-center gap-2.5 overflow-hidden px-3 pt-2.5"
      >
        <CwdPicker cwd={CWD} recents={[]} enabled onCwdChange={noop} />
        <WorkspaceIdentity worktree />
        <BranchPicker cwd={CWD} branch={BRANCH} enabled onChange={noop} />
        <PrChip sessionId={SESSION} sessionTitle={SESSION_TITLE} active />
        <div className="ml-auto flex shrink-0 items-center" data-audit-skip="">
          <ContextMeter usage={{ used: 84_000, window: 200_000 }} />
        </div>
      </div>
      <div className="px-3 pt-2 pb-3 text-[13px] text-muted">
        Ask for follow-up changes
      </div>
    </div>
  );
}

function SidebarRow({
  id,
  sessionId,
  title,
  branch,
  selected,
}: {
  id: string;
  sessionId: string;
  title: string;
  branch: string;
  selected?: boolean;
}) {
  // Mirrors the session row in Sidebar.tsx: title line, then the git line
  // with the work-item slot on the right.
  return (
    <div
      id={id}
      className={`group relative rounded-lg px-2.5 py-2 ${selected ? "bg-selection" : ""}`}
    >
      <span className="relative flex min-w-0 items-center gap-1.5">
        <span className="line-clamp-1 text-[13px] font-semibold leading-snug text-content">
          {title}
        </span>
      </span>
      <span className="relative mt-1 flex items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-muted">
          <GitBranch className="size-3 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 truncate">{branch}</span>
        </span>
        <span className="relative flex shrink-0 items-center gap-px">
          <PrSidebarSlot sessionId={sessionId} badge={null} />
        </span>
      </span>
    </div>
  );
}

/** Marks the page ready once the real store has answered. */
function Ready() {
  const set = usePrSet(SESSION);
  const summaries = usePrSummaries();
  const loaded = !!set && Object.keys(summaries).length > 0;
  const emptyFixture = !!set && set.entries.length === 0;
  useEffect(() => {
    if (!loaded && !emptyFixture) return;
    // Rails load through their own hook; wait for them to be drawn.
    let frame = 0;
    const check = () => {
      if (document.querySelectorAll("#inbox .pr-rail").length === RAILS.length) {
        root.dataset.ready = "true";
        performance.mark("harness-ready");
      } else frame = requestAnimationFrame(check);
    };
    check();
    return () => cancelAnimationFrame(frame);
  }, [loaded, emptyFixture]);
  return null;
}

function Harness() {
  const [inboxWidth, setInboxWidth] = useState(iw);
  const [composerWidth, setComposerWidth] = useState(w);
  useEffect(() => {
    Object.assign(window, {
      harness: {
        fixture: fixtureName,
        calls,
        setInboxWidth,
        setComposerWidth,
        emitChanged: (ids: string[] = []) =>
          emit(PR_SET_CHANGED_EVENT, { sessionIds: ids }),
      },
    });
  }, []);
  return (
    <div
      id="harness"
      className="absolute inset-0 overflow-auto"
      data-fixture={fixtureName}
    >
      <Ready />
      {/* A first tab stop, so specs can reach the first real control by Tab. */}
      <button id="tab-start" type="button" className="sr-only">
        Start
      </button>
      <div className="flex items-start gap-6 p-4">
        <section
          id="sidebar"
          aria-label="Sidebar"
          className="flex w-[260px] shrink-0 flex-col gap-1"
        >
          <SidebarRow
            id="sb-row"
            sessionId={SESSION}
            title={SESSION_TITLE}
            branch={BRANCH}
            selected
          />
          <SidebarRow
            id="sb-row-neighbor"
            sessionId={NEIGHBOR_SESSION}
            title={NEIGHBOR_TITLE}
            branch="mc/rail-fit"
          />
        </section>
        <section
          id="panel"
          aria-label="Changes"
          className="shrink-0 px-3 py-2"
          style={{ width: pw }}
        >
          <div className="text-[12px] text-muted">3 changed files</div>
          <PrSection sessionId={SESSION} pr={null} />
        </section>
      </div>
      <section
        id="inbox"
        aria-label="Inbox"
        className="flex flex-col gap-4 px-4 pb-4"
        style={{ width: inboxWidth }}
      >
        {RAILS.map((rail) => (
          <div key={rail.id} id={rail.id} data-rail-host="">
            <PrInboxStack
              repo={rail.view.group.repo}
              number={rail.current}
              relatedSessions={[{ id: SESSION, title: SESSION_TITLE }]}
              onOpenPr={noop}
            />
          </div>
        ))}
      </section>
      {/* At the bottom so the chip's card opens upward with room, as in the app. */}
      <div className="fixed bottom-4 left-4">
        <Composer width={composerWidth} />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
