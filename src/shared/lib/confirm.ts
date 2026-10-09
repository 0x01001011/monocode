import { ask, message as showMessage } from "@tauri-apps/plugin-dialog";

const TITLE = "MonoCode";

/**
 * Native confirmation sheet. `window.confirm` is swallowed when a macOS menu
 * accelerator fires, and it can only say "OK". `okLabel` is required so a
 * destructive prompt can be answered without reading the body ("Delete folder",
 * not "OK").
 */
export function confirmNative(
  message: string,
  okLabel: string,
): Promise<boolean> {
  return ask(message, { title: TITLE, kind: "warning", okLabel });
}

/** The raw detail of a thrown value, without the `Error: ` prefix. */
export function errorDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error:\s*/, "").trim();
}

/**
 * Plain sentence first, raw exception second:
 * `Couldn't pull. Check your connection and try again.\n\n<detail>`.
 * `action` is a bare verb phrase ("pull", "copy the session ID"); `hint` is an
 * optional second sentence telling the user what to try.
 */
export function formatErrorReport(
  action: string,
  error: unknown,
  hint?: string,
): string {
  const lead = `Couldn't ${action}.${hint ? ` ${hint}` : ""}`;
  const detail = errorDetail(error);
  return detail ? `${lead}\n\n${detail}` : lead;
}

/** Tells the user an action failed, in place of `window.alert(String(error))`. */
export async function reportError(
  action: string,
  error: unknown,
  hint?: string,
): Promise<void> {
  const text = formatErrorReport(action, error, hint);
  console.error(`Failed to ${action}`, error);
  try {
    await showMessage(text, { title: TITLE, kind: "error" });
  } catch {
    globalThis.alert?.(text);
  }
}
