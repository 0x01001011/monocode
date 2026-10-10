import type { HarnessId } from "../../sessions/model/session";
import type { GitFileDiffKind, GitHistoryCommit } from "../../../platform/tauri/fs";
import { GitChangesPanel } from "./GitChangesPanel";

type Props = {
  cwd: string;
  /** The chat a PR created here is attributed to, when the checkout is its own. */
  sessionId?: string;
  enabled: boolean;
  textHarness?: HarnessId;
  selectedPath?: string;
  selectedKind?: GitFileDiffKind;
  selectedSha?: string;
  onOpenFile: (path: string, kind: GitFileDiffKind) => void;
  onOpenAllChanges: (kind: GitFileDiffKind) => void;
  onOpenCommit: (commit: GitHistoryCommit) => void;
};

export function SourceControl({
  cwd,
  sessionId,
  enabled,
  textHarness,
  selectedPath,
  selectedKind,
  selectedSha,
  onOpenFile,
  onOpenAllChanges,
  onOpenCommit,
}: Props) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <GitChangesPanel
        key={cwd}
        cwd={cwd}
        sessionId={sessionId}
        enabled={enabled}
        textHarness={textHarness}
        selectedPath={selectedPath}
        selectedKind={selectedKind}
        selectedSha={selectedSha}
        onOpenFile={onOpenFile}
        onOpenAllChanges={onOpenAllChanges}
        onOpenCommit={onOpenCommit}
      />
    </div>
  );
}
