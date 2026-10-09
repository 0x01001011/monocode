import { invoke } from "@tauri-apps/api/core";
import { isEditTool } from "../../integrations/harness/core/preview";
import type { HarnessEvent } from "../../integrations/harness/core/types";
import { IS_WIN } from "../../platform/tauri/platform";
import { resolveWorkspacePath } from "../../shared/lib/paths";
import { isRemoteProjectPath } from "../projects/model/recents";

/** Tauri event whose payload is the token of a preview whose files changed. */
export const PREVIEW_CHANGED_EVENT = "monocode:preview-changed";

/** A folder serves a site (relative links resolve); an artifact is one page. */
export type PreviewSource =
  | { kind: "dir"; path: string }
  | { kind: "artifact"; id: string };

export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path);
}

/**
 * Address of a file inside a registered preview root. Each segment is encoded
 * on its own so `/` stays a separator and relative links keep resolving.
 */
export function previewUrl(token: string, rel = "", windows = IS_WIN): string {
  const base = windows ? "http://preview.localhost/" : "preview://localhost/";
  const path = rel.split("/").map(encodeURIComponent).join("/");
  return `${base}${token}/${path}`;
}

/** Register a preview root; the token is only valid until `closePreview`. */
export function openPreview(source: PreviewSource): Promise<string> {
  return invoke<string>("preview_open", { source });
}

export function closePreview(token: string): Promise<void> {
  return invoke("preview_close", { token });
}

/** The page's `<title>`, else its first `<h1>`, as plain text. */
export function htmlTitle(html: string): string | undefined {
  for (const pattern of [
    /<title[^>]*>([\s\S]*?)<\/title>/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
  ]) {
    const text = plainText(html.match(pattern)?.[1] ?? "");
    if (text) return text.slice(0, 200);
  }
  return undefined;
}

function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Local HTML files a finished agent edit created or rewrote. */
export function htmlWrittenPaths(event: HarnessEvent, cwd: string): string[] {
  if (event.type !== "tool.updated" || isRemoteProjectPath(cwd)) return [];
  if (event.status !== "completed" && event.status !== "success") return [];
  if (event.kind?.trim().toLowerCase() === "delete") return [];
  if (!isEditTool(event.kind, event.title, event.preview)) return [];
  const paths = [
    ...(event.paths ?? []),
    ...(event.preview?.path ? [event.preview.path] : []),
  ]
    .filter(isHtmlPath)
    .map((path) => resolveWorkspacePath(path, cwd) ?? path);
  return [...new Set(paths)];
}

/**
 * Open a preview for the first HTML file each session writes. Later writes to
 * a file already shown only reload its frame, so the user is not pulled back
 * to it on every save.
 */
export function createHtmlAutoOpener(open: (path: string) => void) {
  const seen = new Map<string, Set<string>>();
  return (key: string, paths: readonly string[]) => {
    let shown = seen.get(key);
    if (!shown) seen.set(key, (shown = new Set()));
    let first: string | undefined;
    for (const path of paths) {
      if (shown.has(path)) continue;
      shown.add(path);
      first ??= path;
    }
    if (first) open(first);
  };
}
