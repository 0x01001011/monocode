import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { basename } from "../../../platform/tauri/fs";
import { parentPath } from "../../../shared/lib/paths";
import { newFrameName, parseFrameMessage } from "../frameChannel";
import {
  clearPreviewLogs,
  previewLogKey,
  recordPreviewLog,
} from "../previewLogs";
import {
  closePreview,
  openPreview,
  PREVIEW_CHANGED_EVENT,
  previewUrl,
} from "../htmlPreview";

export type HtmlFrameSource =
  | { kind: "file"; path: string }
  | { kind: "artifact"; id: string };

/**
 * Scripts run, but without `allow-same-origin` the page gets an opaque origin:
 * it cannot reach Tauri IPC, app storage or this document. Never add
 * `allow-same-origin`; on Windows it would hand the page a working IPC channel.
 */
/** Links from a page open at most this often. */
const OPEN_COOLDOWN_MS = 750;

const SANDBOX = "allow-scripts allow-forms allow-modals allow-downloads";

/** Live, sandboxed view of an HTML file (with its folder) or an artifact. */
export function HtmlFrame({
  source,
  title,
  version,
  reloadKey,
}: {
  source: HtmlFrameSource;
  title: string;
  /** Changing it reloads the page, e.g. an artifact's `updatedAt`. */
  version?: number;
  /** Bumped by a Reload control; reloads the page without reopening the preview. */
  reloadKey?: number;
}) {
  const sourceKey = previewLogKey(source);
  const logKey = sourceKey;
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const tokenRef = useRef<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const lastOpen = useRef(0);
  // The page reads this from window.name to address its messages to us.
  const [frameName] = useState(newFrameName);

  useEffect(() => {
    let live = true;
    let opened: string | null = null;
    setToken(null);
    setError(false);
    void openPreview(
      source.kind === "file"
        ? { kind: "dir", path: parentPath(source.path) }
        : { kind: "artifact", id: source.id },
    ).then(
      (next) => {
        opened = next;
        if (!live) {
          void closePreview(next).catch(() => undefined);
          return;
        }
        tokenRef.current = next;
        setToken(next);
      },
      () => {
        if (live) setError(true);
      },
    );
    return () => {
      live = false;
      tokenRef.current = null;
      if (opened) void closePreview(opened).catch(() => undefined);
    };
    // sourceKey captures every field of `source` that matters.
  }, [sourceKey, attempt]);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    void listen<string>(PREVIEW_CHANGED_EVENT, (event) => {
      if (event.payload === tokenRef.current) setReload((n) => n + 1);
    }).then(
      (unlisten) => {
        if (live) stop = unlisten;
        else unlisten();
      },
      () => undefined,
    );
    return () => {
      live = false;
      stop?.();
    };
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      // The frame's origin is "null", so the window is the only identity check.
      if (!frame || event.source !== frame.contentWindow) return;
      const message = parseFrameMessage(event.data, frameName);
      if (message?.type === "console") {
        recordPreviewLog(logKey, message.level, message.text);
        return;
      }
      if (message?.type === "ready") {
        // A new document loaded in the frame; its console starts empty.
        clearPreviewLogs(logKey);
        return;
      }
      if (message?.type === "open") {
        // Only on the heels of a real click or key press, and not in bursts: a
        // page's own script can post this message too.
        const now = Date.now();
        if (now - lastOpen.current < OPEN_COOLDOWN_MS) return;
        if (navigator.userActivation?.isActive !== true) return;
        lastOpen.current = now;
        void openUrl(message.url).catch(() => undefined);
        return;
      }
      if (message?.type === "escape") {
        // Keys pressed inside the page never reach this window; hand them back.
        frame.blur();
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameName, logKey]);

  if (error)
    return (
      <div
        role="alert"
        className="grid h-full place-items-center gap-2 p-6 text-center text-[13px] text-content/65"
      >
        <p>Could not open this preview.</p>
        <button
          type="button"
          onClick={() => setAttempt((n) => n + 1)}
          className="rounded-md border border-content/15 px-2.5 py-1 text-[12px] text-content/80 hover:bg-content/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          Retry
        </button>
      </div>
    );
  if (!token)
    return (
      <p
        role="status"
        className="grid h-full place-items-center text-[12px] text-content/45"
      >
        Loading preview…
      </p>
    );
  const entry = source.kind === "file" ? basename(source.path) : "index.html";
  return (
    <iframe
      // A new element reloads the page and every subresource it fetched.
      key={`${token}:${reload}:${reloadKey ?? 0}:${version ?? ""}`}
      ref={frameRef}
      name={frameName}
      data-html-preview={token}
      title={title}
      src={previewUrl(token, entry)}
      sandbox={SANDBOX}
      referrerPolicy="no-referrer"
      allow=""
      className="block h-full w-full border-0 bg-white"
    />
  );
}
