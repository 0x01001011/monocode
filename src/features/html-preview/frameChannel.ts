/**
 * Messages the injected bootstrap may send to the app. The page runs with an
 * opaque origin and its code is whatever an agent wrote, so every message is
 * untrusted: only own properties are read, only allowlisted types pass, and a
 * fresh object is returned instead of the page's own.
 */
export type FrameMessage = { type: "ready" } | { type: "escape" };

const own = (record: object, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(record, key)
    ? (record as Record<string, unknown>)[key]
    : undefined;

/** `name` is the frame's `window.name`, the channel nonce the host chose. */
export function parseFrameMessage(
  data: unknown,
  name: string,
): FrameMessage | null {
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return null;
  if (own(data, "mcp") !== 1 || own(data, "n") !== name) return null;
  switch (own(data, "type")) {
    case "ready":
      return { type: "ready" };
    case "escape":
      return { type: "escape" };
    default:
      return null;
  }
}

/** A fresh channel nonce; the page can read it, so it only binds messages to one frame. */
export function newFrameName(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `mc:${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
