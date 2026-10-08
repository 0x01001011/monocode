import { useEffect, type ReactNode } from "react";
import { lazySurface } from "../../../shared/ui/lazySurface";
import { MonoSidebar, MonoSidebarHeader } from "./MonoSidebar";

const SessionChangesDiff = lazySurface(async () => {
  const module = await import("../../source-control/ui/SessionChangesDiff");
  return { default: module.SessionChangesDiff };
});

/** A Mono's session changes, reviewed beside the chat whatever project they touched. */
export function MonoChangesPanel({
  sessionId,
  cwd,
  focusPath,
  color,
  onClose,
  windowControls,
}: {
  sessionId: string;
  cwd: string;
  focusPath?: string;
  color: string;
  onClose: () => void;
  windowControls?: ReactNode;
}) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);

  return (
    <MonoSidebar
      open
      kind="changes"
      label="Changes"
      color={color}
      windowControls={windowControls}
    >
      <MonoSidebarHeader title="Changes" onClose={onClose} />
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 h-full">
          <SessionChangesDiff
            cwd={cwd}
            sessionId={sessionId}
            focusPath={focusPath}
          />
        </div>
      </div>
    </MonoSidebar>
  );
}
