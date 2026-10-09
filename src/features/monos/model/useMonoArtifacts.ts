import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ARTIFACTS_CHANGED_EVENT, type Artifact } from "../../artifacts/artifacts";

/**
 * The artifacts one Mono saved, newest first, or undefined while loading.
 * Follows later saves and refreshes when the window regains focus.
 */
export function useMonoArtifacts(sessionId: string | undefined): Artifact[] | undefined {
  const [artifacts, setArtifacts] = useState<Artifact[]>();
  useEffect(() => {
    if (!sessionId) {
      setArtifacts(undefined);
      return;
    }
    let live = true;
    let request = 0;
    const refresh = () => {
      const token = ++request;
      void invoke<Artifact[]>("artifacts_list").then(
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
