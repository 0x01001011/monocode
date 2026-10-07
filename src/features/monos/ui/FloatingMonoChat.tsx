import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ExternalLink, Plus, Square, X } from "../../../shared/ui/icons";
import { PixelMascot } from "../../projects/ui/PixelMascot";
import { AgentTranscript } from "../../sessions/ui/AgentTranscript";
import { QuestionForm } from "../../sessions/ui/QuestionForm";
import { revokeAttachment } from "../../sessions/model/attachments";
import { useMonoTranscript } from "../hooks/useMonoTranscript";
import { monoState } from "../model/mono";
import {
  monoMessageDeliveries,
  monoPendingTranscriptBlocks,
} from "../model/monoMessaging";
import { sessionWorkCwd, type Session } from "../../sessions/model/session";
import {
  FLOATING_MONO_CHANGED,
  floatingMonoAttachments,
  type FloatingMonoAction,
  type FloatingMonoEntry,
  type FloatingMonoView,
} from "../model/floatingMono";
import { MonoComposer } from "./MonoComposer";
import { MonoStatus } from "./MonoStatus";
import { MONO_PAGE_TURNS } from "../../sessions/data/sessionStore";

const EMPTY: FloatingMonoView = {
  monos: [],
  monoId: null,
  session: null,
  error: null,
};
const BUTTON =
  "grid size-7 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/8 hover:text-content disabled:opacity-30";
const SURFACE =
  "sidebar-glass flex h-full min-h-0 overflow-hidden rounded-2xl font-sans text-content";
/**
 * Inset from the window by its gap, so its corners follow the window's. Under
 * native glass both surfaces are clear, so the card's spread shadow shades
 * everything around it instead: the rail and the gaps, never the chat.
 */
const CARD =
  "body-glass my-1.5 mr-1.5 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] shadow-[0_0_0_100vmax_rgb(0_0_0/0.28)] [html.theme-light_&]:shadow-[0_0_0_100vmax_rgb(0_0_0/0.05)]";

export function FloatingMonoChat({ onShown }: { onShown: () => void }) {
  const [view, setView] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const selectedId = useRef(view.monoId);
  selectedId.current = view.monoId;
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    let received = false;
    let selected: string | null = null;
    const receive = (next: FloatingMonoView) => {
      if (disposed) return;
      if (next.monoId !== selected) {
        selected = next.monoId;
        setError(null);
        setFocus((n) => n + 1);
      }
      setView(next);
      onShown();
    };
    void getCurrentWebviewWindow()
      .listen<FloatingMonoView>(FLOATING_MONO_CHANGED, (event) => {
        received = true;
        receive(event.payload);
      })
      .then(async (unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        stop = unlisten;
        const initial = await invoke<FloatingMonoView>("mono_chat_state");
        if (!received) receive(initial);
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason));
      });
    const onFocus = () => {
      onShown();
      setFocus((n) => n + 1);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      stop?.();
      window.removeEventListener("focus", onFocus);
    };
  }, [onShown]);

  useEffect(() => {
    // Present only after the loading screen has mounted. A hidden WKWebView
    // can suspend animation frames, so this must not wait on rAF to open.
    let disposed = false;
    void invoke("mono_chat_ready").catch((reason) => {
      if (!disposed) setError(String(reason));
    });
    return () => {
      disposed = true;
    };
  }, []);

  const mono = view.monos.find((entry) => entry.id === view.monoId);
  const action = useCallback(
    async (next: FloatingMonoAction): Promise<boolean> => {
      if (!view.monoId) return false;
      const id = view.monoId;
      setError(null);
      try {
        await invoke("mono_chat_action", { monoId: id, action: next });
        return true;
      } catch (reason) {
        if (selectedId.current === id)
          setError(reason instanceof Error ? reason.message : String(reason));
        return false;
      }
    },
    [view.monoId],
  );
  const switchTo = useCallback(
    async (to: string) => {
      if (!view.monoId || to === view.monoId) return;
      setError(null);
      try {
        await invoke("mono_chat_switch", { from: view.monoId, to });
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    },
    [view.monoId],
  );
  const state = view.session
    ? monoState(view.session)
    : { status: "idle" as const };
  const failure = error ?? view.error;
  const loading = !mono || !view.session;

  // The rail and header stay mounted while switching; only the conversation
  // waits for its Mono, so moving between them never redraws the window.
  return (
    <div
      data-floating-mono
      data-floating-mono-loading={loading || undefined}
      aria-busy={loading && !failure}
      className={SURFACE}
    >
      <MonoRail
        monos={view.monos}
        currentId={view.monoId}
        onSwitch={(id) => void switchTo(id)}
        onCreate={() => action({ kind: "create" })}
      />
      <div className={CARD}>
        <header
          data-tauri-drag-region
          className="flex shrink-0 items-center gap-2 border-b border-content/8 px-3 py-3"
        >
          {mono ? (
            <PixelMascot
              name={mono.mascot}
              color={mono.color}
              status={state.status}
              className="pointer-events-none size-7 shrink-0"
            />
          ) : null}
          <div
            data-tauri-drag-region
            className="flex min-h-7 min-w-0 flex-1 flex-col justify-center"
          >
            {mono ? (
              <>
                <h1
                  data-tauri-drag-region
                  className="truncate text-[13px] leading-4 font-semibold"
                >
                  {mono.name}
                </h1>
                <MonoStatus
                  state={state}
                  color={mono.color}
                  className="pointer-events-none text-[11px] leading-3.5 text-content/45"
                />
              </>
            ) : null}
          </div>
          {view.session?.busy ? (
            <button
              type="button"
              aria-label="Stop reply"
              title="Stop reply (Escape)"
              className={BUTTON}
              onClick={() => void action({ kind: "stop" })}
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Open in MonoCode"
            title="Open in MonoCode"
            disabled={loading}
            className={BUTTON}
            onClick={() => void action({ kind: "reveal" })}
          >
            <ExternalLink className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Hide chat"
            title="Hide chat"
            className={BUTTON}
            onClick={() => void getCurrentWindow().hide()}
          >
            <X className="size-4" />
          </button>
        </header>
        {loading ? (
          <div
            data-floating-mono-loader
            role={failure ? "alert" : "status"}
            className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-8 text-center"
          >
            {mono ? (
              <PixelMascot
                name={mono.mascot}
                color={mono.color}
                className="size-12"
              />
            ) : (
              <img
                src="/monocode.png"
                alt=""
                className="size-18 object-contain"
              />
            )}
            <p className="text-[13px] text-content/50">
              {failure ?? "Loading conversation…"}
            </p>
          </div>
        ) : (
          <>
            {failure ? (
              <p
                role="alert"
                className="shrink-0 border-b border-content/8 px-3 py-2 text-[12px] text-red-400"
              >
                {failure}
              </p>
            ) : null}
            <FloatingConversation
              key={view.session!.id}
              mono={mono!}
              session={view.session!}
              focus={focus}
              action={action}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Every Mono beside the conversation, so one floating frame can move between
 * them. Picking another shows its chat in this one's place.
 */
function MonoRail({
  monos,
  currentId,
  onSwitch,
  onCreate,
}: {
  monos: FloatingMonoEntry[];
  currentId: string | null;
  onSwitch: (monoId: string) => void;
  onCreate: () => Promise<boolean>;
}) {
  const [creating, setCreating] = useState(false);
  return (
    <nav
      aria-label="Monos"
      data-floating-mono-rail
      data-tauri-drag-region
      // 17px puts the first mascot's center level with the header's: the
      // card's 6px inset, the header's 12px padding, and half of its 30px
      // name row, less half this 32px button.
      className="relative z-10 flex w-14 shrink-0 flex-col items-center gap-1.5 overflow-y-auto pt-[17px] pb-3 [scrollbar-width:none]"
    >
      {monos.map((mono) => {
        const selected = mono.id === currentId;
        return (
          <div
            key={mono.id}
            className="group relative flex w-full justify-center"
          >
            <span
              aria-hidden
              className={`absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r-full bg-content transition-[height,opacity] duration-150 motion-reduce:transition-none ${
                selected
                  ? "h-5 opacity-100"
                  : "h-2 opacity-0 group-hover:opacity-100"
              }`}
            />
            <button
              type="button"
              title={mono.name}
              aria-label={mono.name}
              aria-current={selected ? "true" : undefined}
              onClick={() => onSwitch(mono.id)}
              className={`grid size-8 place-items-center rounded-lg transition-opacity ${
                selected ? "" : "opacity-70 hover:opacity-100"
              }`}
            >
              <PixelMascot
                name={mono.mascot}
                color={mono.color}
                className="pointer-events-none size-7"
              />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        title="New mono"
        aria-label="New mono"
        disabled={creating || !currentId}
        onClick={() => {
          setCreating(true);
          void onCreate().finally(() => setCreating(false));
        }}
        className="grid size-8 shrink-0 place-items-center rounded-lg border border-content/10 bg-content/5 text-content/60 hover:bg-content/10 hover:text-content disabled:opacity-40"
      >
        <Plus className="size-3.5" strokeWidth={1.75} />
      </button>
    </nav>
  );
}

function FloatingConversation({
  mono,
  session,
  focus,
  action,
}: {
  mono: FloatingMonoEntry;
  session: Session;
  focus: number;
  action: (action: FloatingMonoAction) => Promise<boolean>;
}) {
  const transcript = useMonoTranscript(session, true);
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.nativeEvent.isComposing &&
          session.busy
        ) {
          event.preventDefault();
          void action({ kind: "stop" });
        }
      }}
    >
      <div className="@container relative min-h-0 flex-1">
        {!session.blocks.length ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 px-8 text-center">
            <PixelMascot
              name={mono.mascot}
              color={mono.color}
              className="size-12"
            />
            <p className="text-[13px] leading-6 text-content/45">
              Say hello to {mono.name}, ask a question, or hand over some work.
            </p>
          </div>
        ) : null}
        <AgentTranscript
          blocks={
            transcript.viewingOlderPage
              ? transcript.blocks
              : monoPendingTranscriptBlocks(session, transcript.blocks)
          }
          historicalBlockIds={transcript.historicalBlockIds}
          initialTurns={MONO_PAGE_TURNS}
          pageSize={MONO_PAGE_TURNS}
          busy={!!session.busy && !transcript.viewingOlderPage}
          cwd={sessionWorkCwd(session)}
          agentName={mono.name}
          agentMascot={mono}
          bottomAligned
          inlineWork
          daySeparators
          hideTurnMetrics
          visible
          messageDeliveries={monoMessageDeliveries(session)}
          hasEarlier={transcript.hasEarlier}
          loadEarlierOnScroll
          onLoadEarlier={transcript.loadEarlier}
          onReturnToLatest={
            transcript.viewingOlderPage ? transcript.latest : undefined
          }
          harness={session.harness}
          model={session.model}
          modelSettings={session.modelSettings}
          pendingQuestion={!!session.pendingQuestion}
          backgroundTasks={session.backgroundTasks}
          onApproval={(requestId, decision) =>
            void action({ kind: "approval", requestId, decision })
          }
          onOpenFile={(path) => void action({ kind: "openFile", path })}
          onOpenArtifact={(id) => void action({ kind: "openArtifact", id })}
          onOpenDiff={() => void action({ kind: "reveal" })}
          onShowWork={() => void action({ kind: "reveal" })}
          onShowSessions={() => void action({ kind: "reveal" })}
        />
      </div>
      {session.pendingQuestion ? (
        <div className="max-h-[45%] shrink-0 overflow-y-auto px-2 pb-2">
          <QuestionForm
            prompt={session.pendingQuestion}
            onReply={(requestId, reply) =>
              void action({ kind: "question", requestId, reply })
            }
            onInteraction={(requestId) =>
              void action({ kind: "questionInteraction", requestId })
            }
          />
        </div>
      ) : null}
      {session.usageLimit ? (
        <div className="shrink-0 px-3 pb-2 text-[12px] text-content/60">
          <p>The provider’s usage limit was reached.</p>
          <button
            type="button"
            className="mt-1 text-accent hover:underline"
            onClick={() => void action({ kind: "resume" })}
          >
            Try again
          </button>
          <span className="mx-2 text-content/25">·</span>
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => void action({ kind: "reveal" })}
          >
            Change model in MonoCode
          </button>
        </div>
      ) : null}
      <div className="shrink-0 px-1 pb-1">
        <MonoComposer
          sessionId={`floating:${session.id}`}
          name={mono.name}
          enabled={!session.worktreeRemoved}
          focusToken={focus}
          onSubmit={async (text, attachments) => {
            const accepted = await action({
              kind: "submit",
              text,
              attachments: floatingMonoAttachments(attachments),
            });
            // Only bytes/paths cross into the owner; its renderer never owns
            // these composer preview URLs.
            if (accepted) attachments.forEach(revokeAttachment);
            return accepted;
          }}
        />
      </div>
    </div>
  );
}
