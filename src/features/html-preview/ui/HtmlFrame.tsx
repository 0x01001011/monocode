import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { basename } from "../../../platform/tauri/fs";
import { parentPath } from "../../../shared/lib/paths";
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
const SANDBOX = "allow-scripts allow-forms allow-modals allow-downloads";

/** Live, sandboxed view of an HTML file (with its folder) or an artifact. */
export function HtmlFrame({
  source,
  title,
  version,
}: {
  source: HtmlFrameSource;
  title: string;
  /** Changing it reloads the page, e.g. an artifact's `updatedAt`. */
  version?: number;
}) {
  const sourceKey =
    source.kind === "file" ? `file:${source.path}` : `artifact:${source.id}`;
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const tokenRef = useRef<string | null>(null);

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
  }, [sourceKey]);

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

  if (error)
    return (
      <p role="alert" className="p-6 text-[13px] text-content/65">
        Could not open this preview.
      </p>
    );
  if (!token)
    return (
      <p role="status" className="sr-only">
        Loading preview…
      </p>
    );
  const entry = source.kind === "file" ? basename(source.path) : "index.html";
  return (
    <iframe
      // A new element reloads the page and every subresource it fetched.
      key={`${token}:${reload}:${version ?? ""}`}
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
