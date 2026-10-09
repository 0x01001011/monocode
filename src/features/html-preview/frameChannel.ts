/**
 * Messages the injected bootstrap may send to the app. The page runs with an
 * opaque origin and its code is whatever an agent wrote, so every message is
 * untrusted: only own properties are read, only allowlisted types pass, and a
 * fresh object is returned instead of the page's own.
 */
export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

export type FrameMessage =
  | { type: "ready" }
  | { type: "escape" }
  | { type: "open"; url: string }
  | { type: "console"; level: ConsoleLevel; text: string }
  | { type: "scroll"; x: number; y: number }
  | { type: "copy"; text: string };

const MAX_COPY = 100_000;

const MAX_SCROLL = 10_000_000;

function scrollMessage(x: unknown, y: unknown): FrameMessage | null {
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const clamp = (value: number) => Math.min(MAX_SCROLL, Math.max(0, Math.floor(value)));
  return { type: "scroll", x: clamp(x), y: clamp(y) };
}

const CONSOLE_LEVELS = new Set<string>(["log", "info", "warn", "error", "debug"]);
const MAX_CONSOLE_TEXT = 2000;

function consoleMessage(level: unknown, text: unknown): FrameMessage | null {
  if (typeof level !== "string" || !CONSOLE_LEVELS.has(level)) return null;
  if (typeof text !== "string") return null;
  return {
    type: "console",
    level: level as ConsoleLevel,
    text: text.slice(0, MAX_CONSOLE_TEXT),
  };
}

/** Links a page may ask the app to open; everything else (javascript:, file:, app schemes) is dropped. */
const OPEN_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);
const MAX_URL_LENGTH = 2048;

function openMessage(url: unknown): FrameMessage | null {
  if (typeof url !== "string" || !url || url.length > MAX_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!OPEN_PROTOCOLS.has(parsed.protocol)) return null;
  if (parsed.protocol !== "mailto:" && !parsed.hostname) return null;
  return { type: "open", url: parsed.href };
}

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
    case "open":
      return openMessage(own(data, "url"));
    case "console":
      return consoleMessage(own(data, "level"), own(data, "text"));
    case "scroll":
      return scrollMessage(own(data, "x"), own(data, "y"));
    case "copy": {
      const text = own(data, "text");
      return typeof text === "string" && text
        ? { type: "copy", text: text.slice(0, MAX_COPY) }
        : null;
    }
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
