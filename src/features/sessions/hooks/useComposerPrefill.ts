import { useEffect, useSyncExternalStore } from "react";
import {
  clearComposerPrefill,
  peekComposerPrefill,
  subscribeComposerPrefill,
} from "../model/composerPrefill";

/** Hands this session's pending composer text to `insert` once its pane is showing. */
export function useComposerPrefill(sessionId: string, visible: boolean, insert: (text: string) => void): void {
  const request = useSyncExternalStore(
    subscribeComposerPrefill,
    () => peekComposerPrefill(sessionId),
    () => null,
  );
  useEffect(() => {
    if (!visible || !request) return;
    insert(request.text);
    clearComposerPrefill(sessionId, request.token);
  }, [visible, request, sessionId, insert]);
}
