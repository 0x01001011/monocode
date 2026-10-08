import { parentPath } from "../../../shared/lib/paths";
import { peekDir } from "./fileTree";

/** One rendered `treeitem`, in visual order. */
export type TreeNavItem = {
  path: string;
  /** 1-based `aria-level`. */
  level: number;
  isDir: boolean;
  open: boolean;
};

export type TreeNavAction =
  | { type: "focus"; path: string }
  | { type: "expand"; path: string }
  | { type: "collapse"; path: string };

/**
 * The WAI-ARIA tree keys. Up/Down/Home/End move, Right expands a folder or
 * steps into an open one, Left collapses an open folder or steps out to the
 * parent. Returns null for keys the tree does not own.
 */
export function treeNavAction(
  key: string,
  items: readonly TreeNavItem[],
  index: number,
): TreeNavAction | null {
  const current = items[index];
  if (!current) return null;
  const focus = (to: number): TreeNavAction | null => {
    const target = items[to];
    return target && to !== index ? { type: "focus", path: target.path } : null;
  };
  switch (key) {
    case "ArrowDown":
      return focus(index + 1);
    case "ArrowUp":
      return focus(index - 1);
    case "Home":
      return focus(0);
    case "End":
      return focus(items.length - 1);
    case "ArrowRight": {
      if (!current.isDir) return null;
      if (!current.open) return { type: "expand", path: current.path };
      const next = items[index + 1];
      return next && next.level > current.level ? focus(index + 1) : null;
    }
    case "ArrowLeft": {
      if (current.isDir && current.open) {
        return { type: "collapse", path: current.path };
      }
      for (let i = index - 1; i >= 0; i--) {
        if (items[i].level < current.level) return focus(i);
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * The one `treeitem` that is a Tab stop (roving tabindex): the selected row
 * when it is on screen, otherwise the first row, so the tree stays reachable
 * after a collapse, a delete or a stale saved selection.
 */
export function treeTabStop(
  cwd: string,
  selectedPath: string | null,
  expanded: ReadonlySet<string>,
  showExcludedFiles: boolean,
  firstPath: string | null,
): string | null {
  if (selectedPath && selectedPath !== cwd) {
    let dir = parentPath(selectedPath);
    let rendered = true;
    while (dir !== cwd) {
      const up = parentPath(dir);
      if (!expanded.has(dir) || up === dir) {
        rendered = false;
        break;
      }
      dir = up;
    }
    const entry = peekDir(parentPath(selectedPath))?.find(
      (candidate) => candidate.path === selectedPath,
    );
    if (rendered && entry && (showExcludedFiles || !entry.ignored)) {
      return selectedPath;
    }
  }
  return firstPath;
}
