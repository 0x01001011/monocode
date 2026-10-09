import { useEffect, useState, type ReactNode } from "react";
import { Maximize2, Minimize2, RefreshCw } from "../../../shared/ui/icons";
import { HtmlFrame, type HtmlFrameSource } from "./HtmlFrame";

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
      <div className="flex h-8 shrink-0 items-center justify-end gap-0.5 border-b border-content/10 bg-content/5 px-1.5">
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
      <div className="min-h-0 flex-1">
        <HtmlFrame
          source={source}
          title={title}
          version={version}
          reloadKey={reload}
        />
      </div>
    </div>
  );
}
