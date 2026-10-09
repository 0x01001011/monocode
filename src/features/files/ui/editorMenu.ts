import { useEffect, useState } from "react";
import {
  listExternalEditors,
  type ExternalEditor,
} from "../../../platform/tauri/fs";
import { editorsFor, lastEditorId } from "../model/openInEditor";
import type { ExplorerMenuItem } from "./ExplorerMenu";

const PREFIX = "external-editor:";

let installed: Promise<ExternalEditor[]> | undefined;
let loaded: ExternalEditor[] | undefined;
const NONE: ExternalEditor[] = [];

/** Installed editors, looked up once per session; a failed lookup is retried. */
function loadEditors(): Promise<ExternalEditor[]> {
  installed ??= listExternalEditors()
    .then((list) => (loaded = Array.isArray(list) ? list : NONE))
    .catch(() => {
      installed = undefined;
      return NONE;
    });
  return installed;
}

/**
 * Installed editors for a menu. Nothing is looked up until `enabled` (a menu
 * is open), so a tab bar or tree that never shows a menu stays free of
 * async work.
 */
export function useExternalEditors(enabled: boolean): ExternalEditor[] {
  const [editors, setEditors] = useState<ExternalEditor[]>(loaded ?? NONE);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void loadEditors().then((list) => {
      if (active) setEditors(list);
    });
    return () => {
      active = false;
    };
  }, [enabled]);
  return editors;
}

/** An "Open in Editor" submenu for `path`; empty when no editor can open it. */
export function editorMenuItems(
  editors: readonly ExternalEditor[],
  path: string,
): ExplorerMenuItem[] {
  const last = lastEditorId();
  const usable = editorsFor(editors, path).sort(
    (a, b) => Number(b.id === last) - Number(a.id === last),
  );
  if (usable.length === 0) return [];
  return [
    {
      kind: "item",
      id: "external-editor",
      label: "Open in Editor",
      submenu: usable.map((editor) => ({
        kind: "item" as const,
        id: `${PREFIX}${editor.id}`,
        label: editor.name,
      })),
    },
  ];
}

/** The editor a submenu pick names, if the id is one of ours. */
export function editorIdFromMenu(id: string): string | undefined {
  return id.startsWith(PREFIX) && id.length > PREFIX.length
    ? id.slice(PREFIX.length)
    : undefined;
}
