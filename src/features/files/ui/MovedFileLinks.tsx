import { useEffect, useState } from "react";
import { prettyCwd } from "../../../shared/lib/paths";
import { REMOTE_PATH_PREFIX } from "../../../shared/lib/remotePaths";
import type { OpenFileFn } from "../../search/model/search";
import { findInOtherCheckouts, type MovedFile } from "../model/movedFile";

/** `~/project/a.md` for a path on this computer or on a connected machine. */
const hostPath = (path: string) =>
  prettyCwd(
    path.startsWith(REMOTE_PATH_PREFIX)
      ? path.slice(path.indexOf("/", REMOTE_PATH_PREFIX.length))
      : path,
  );

/** Offers the same file in the project's other checkouts when this one lacks it. */
export function MovedFileLinks({
  path,
  cwd,
  onOpenFile,
}: {
  path: string;
  cwd: string;
  onOpenFile?: OpenFileFn;
}) {
  const [found, setFound] = useState<MovedFile[]>([]);
  useEffect(() => {
    let live = true;
    setFound([]);
    void findInOtherCheckouts(path, cwd).then((next) => {
      if (live) setFound(next);
    });
    return () => {
      live = false;
    };
  }, [path, cwd]);
  if (!onOpenFile || found.length === 0) return null;
  return (
    <div className="mt-3 text-left" data-moved-file-links>
      <p className="text-[12px] text-muted">
        {found.length === 1
          ? "The same file exists in another checkout:"
          : "The same file exists in other checkouts:"}
      </p>
      <ul className="mt-1.5 space-y-1">
        {found.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              title={file.path}
              onClick={() =>
                onOpenFile(file.path, undefined, {
                  exact: true,
                  cwd: file.checkout,
                })
              }
              className="w-full truncate rounded-md bg-content/10 px-2.5 py-1 text-left font-mono text-[11px] text-content hover:bg-content/15"
            >
              {hostPath(file.path)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
