import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ARTIFACTS_CHANGED_EVENT,
  type ArtifactSummary,
} from "../../artifacts/artifacts";

/**
 * The artifacts one Mono saved, newest first and without their bodies, or
 * undefined while loading.
 * Follows later saves and refreshes when the window regains focus.
 */
export function useMonoArtifacts(
  sessionId: string | undefined,
): ArtifactSummary[] | undefined {
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>();
  useEffect(() => {
    if (!sessionId) {
      setArtifacts(undefined);
      return;
    }
    let live = true;
    let request = 0;
    const refresh = () => {
      const token = ++request;
      void invoke<ArtifactSummary[]>("artifacts_summaries").then(
        (all) => {
          if (!live || token !== request) return;
          setArtifacts(all.filter((artifact) => artifact.sourceSessionId === sessionId));
        },
        () => {
          if (live && token === request) setArtifacts([]);
        },
      );
    };
    refresh();
    window.addEventListener(ARTIFACTS_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      window.removeEventListener(ARTIFACTS_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [sessionId]);
  return artifacts;
}
