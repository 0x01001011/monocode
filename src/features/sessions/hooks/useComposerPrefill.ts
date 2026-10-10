import { useEffect, useSyncExternalStore } from "react";
import {
  clearComposerPrefill,
  markComposerMounted,
  peekComposerPrefill,
  subscribeComposerPrefill,
} from "../model/composerPrefill";

/**
 * Hands this session's pending composer text to `insert` once its pane is showing. While mounted
 * (hidden or not) the session counts as having a live composer, so other surfaces route drafts
 * here instead of into the draft cache the live composer would overwrite.
 */
export function useComposerPrefill(sessionId: string, visible: boolean, insert: (text: string) => void): void {
  const request = useSyncExternalStore(
    subscribeComposerPrefill,
    () => peekComposerPrefill(sessionId),
    () => null,
  );
  useEffect(() => markComposerMounted(sessionId), [sessionId]);
  useEffect(() => {
    if (!visible || !request) return;
    insert(request.text);
    clearComposerPrefill(sessionId, request.token);
  }, [visible, request, sessionId, insert]);
}
