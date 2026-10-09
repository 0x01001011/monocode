import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { copyMessage } from "../../../platform/tauri/clipboard";
import {
  Copy,
  Maximize2,
  Minimize2,
  RefreshCw,
  Terminal,
  Trash2,
} from "../../../shared/ui/icons";
import {
  clearPreviewLogs,
  getPreviewLogs,
  previewLogKey,
  subscribePreviewLogs,
} from "../previewLogs";
import { HtmlFrame, type HtmlFrameSource } from "./HtmlFrame";

type Width = "full" | "tablet" | "phone";

/** Device widths to preview at; the page is never wider than the reader. */
const WIDTHS: { id: Width; label: string; short: string; px?: number }[] = [
  { id: "full", label: "Full width", short: "Full" },
  { id: "tablet", label: "Tablet width, 768 pixels", short: "768", px: 768 },
  { id: "phone", label: "Phone width, 375 pixels", short: "375", px: 375 },
];

const TOOL =
  "grid size-6 place-items-center rounded text-content/60 hover:bg-content/10 hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent";

function Tool({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={TOOL}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** A live page with the controls its readers need: reload, and fill the reader. */
export function HtmlPreview({
  source,
  title,
  version,
}: {
  source: HtmlFrameSource;
  title: string;
  version?: number;
}) {
  const [reload, setReload] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [width, setWidth] = useState<Width>("full");
  const logKey = previewLogKey(source);
  const logs = useSyncExternalStore(
    (listener) => subscribePreviewLogs(logKey, listener),
    () => getPreviewLogs(logKey),
  );
  const errors = logs.filter((entry) => entry.level === "error").length;

  useEffect(() => {
    if (!expanded) return;
    // Capture phase: this Escape is spent collapsing, so the reader behind the
    // preview, which also closes on Escape, must not see it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [expanded]);

  return (
    <div
      data-html-preview-root
      data-expanded={expanded || undefined}
      className={
        expanded
          ? "fixed inset-3 z-50 flex flex-col overflow-hidden rounded-xl border border-content/15 bg-background-base shadow-2xl"
          : "flex h-[min(70vh,720px)] flex-col overflow-hidden rounded-lg border border-content/10"
      }
    >
      <div className="flex h-8 shrink-0 items-center justify-between gap-0.5 border-b border-content/10 bg-content/5 px-1.5">
        <div
          role="radiogroup"
          aria-label="Preview width"
          className="flex items-center gap-0.5"
          onKeyDown={(event) => {
            const step =
              event.key === "ArrowRight"
                ? 1
                : event.key === "ArrowLeft"
                  ? -1
                  : 0;
            if (!step) return;
            event.preventDefault();
            const at = WIDTHS.findIndex((entry) => entry.id === width);
            setWidth(WIDTHS[(at + step + WIDTHS.length) % WIDTHS.length].id);
          }}
        >
          {WIDTHS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={width === entry.id}
              aria-label={entry.label}
              title={entry.label}
              tabIndex={width === entry.id ? 0 : -1}
              className={`${TOOL} w-auto px-1.5 text-[11px] ${
                width === entry.id ? "bg-content/10 text-content" : ""
              }`}
              onClick={() => setWidth(entry.id)}
            >
              {entry.short}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label={
              errors
                ? `Console, ${errors} error${errors === 1 ? "" : "s"}`
                : "Console"
            }
            aria-expanded={consoleOpen}
            title="Console"
            className={`${TOOL} relative`}
            onClick={() => setConsoleOpen((open) => !open)}
          >
            <Terminal className="size-3.5" />
            {errors ? (
              <span
                data-console-errors
                className="absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-danger px-1 text-center text-[9px] leading-[14px] font-medium text-background-base"
              >
                {errors}
              </span>
            ) : null}
          </button>
          <Tool label="Reload preview" onClick={() => setReload((n) => n + 1)}>
            <RefreshCw className="size-3.5" />
          </Tool>
          <Tool
            label={expanded ? "Collapse preview" : "Expand preview"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? (
              <Minimize2 className="size-3.5" />
            ) : (
              <Maximize2 className="size-3.5" />
            )}
          </Tool>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-content/5">
        <div
          data-preview-stage
          data-width={width}
          style={{ maxWidth: WIDTHS.find((entry) => entry.id === width)?.px }}
          className="mx-auto h-full w-full"
        >
          <HtmlFrame
            source={source}
            title={title}
            version={version}
            reloadKey={reload}
          />
        </div>
      </div>
      {consoleOpen ? (
        <div className="flex max-h-44 shrink-0 flex-col border-t border-content/10 bg-content/5">
          <div className="flex h-7 shrink-0 items-center justify-end gap-0.5 px-1.5">
            <Tool
              label="Copy console"
              onClick={() =>
                void copyMessage(
                  logs
                    .map((entry) => `[${entry.level}] ${entry.text}`)
                    .join("\n"),
                ).catch(() => undefined)
              }
            >
              <Copy className="size-3.5" />
            </Tool>
            <Tool
              label="Clear console"
              onClick={() => clearPreviewLogs(logKey)}
            >
              <Trash2 className="size-3.5" />
            </Tool>
          </div>
          <div
            data-preview-console
            role="log"
            aria-label="Page console"
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 font-mono text-[11px] leading-snug"
          >
            {logs.length ? (
              logs.map((entry, index) => (
                <div
                  key={index}
                  data-level={entry.level}
                  className={`whitespace-pre-wrap break-words ${
                    entry.level === "error"
                      ? "text-danger"
                      : entry.level === "warn"
                        ? "text-warning"
                        : "text-content/70"
                  }`}
                >
                  {entry.text}
                </div>
              ))
            ) : (
              <p className="text-content/45">No console output</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
