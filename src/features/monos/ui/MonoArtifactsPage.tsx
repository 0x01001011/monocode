import { useState } from "react";
import { artifactWording } from "../../artifacts/artifactWording";
import type { Artifact } from "../../artifacts/artifacts";
import { PageHeader } from "./monoPanelParts";

/** The documents and web pages a Mono saved, searchable, newest first. */
export function MonoArtifactsPage({
  artifacts,
  onOpen,
  onBack,
}: {
  artifacts: Artifact[] | undefined;
  onOpen: (id: string) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = (artifacts ?? []).filter(
    (artifact) =>
      !needle ||
      artifact.title.toLowerCase().includes(needle) ||
      artifactWording(artifact.kind).label.toLowerCase().includes(needle),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-mono-artifacts>
      <PageHeader title="Artifacts" onBack={onBack} />
      <div className="shrink-0 border-b border-stroke px-3 py-2">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search artifacts"
          aria-label="Search artifacts"
          className="w-full rounded-md border border-content/10 bg-content/5 px-2.5 py-1.5 text-[13px] text-content placeholder:text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-none px-2 py-2">
        {artifacts === undefined ? (
          <p role="status" className="px-2 py-3 text-[12px] text-muted">
            Loading…
          </p>
        ) : artifacts.length === 0 ? (
          <p className="px-2 py-3 text-[12px] leading-5 text-muted">
            No artifacts yet. Ask this bot for a report or a page and it will
            appear here.
          </p>
        ) : shown.length === 0 ? (
          <p className="px-2 py-3 text-[12px] text-muted">
            No artifacts match “{query.trim()}”.
          </p>
        ) : (
          shown.map((artifact) => (
            <button
              key={artifact.id}
              type="button"
              data-artifact-row={artifact.id}
              onClick={() => onOpen(artifact.id)}
              className="flex w-full flex-col rounded-lg px-3 py-2 text-left hover:bg-content/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <span className="truncate text-[13px] leading-5 text-content/90">
                {artifact.title}
              </span>
              <span className="text-[12px] leading-5 text-muted">
                {artifactWording(artifact.kind).label} ·{" "}
                {new Date(artifact.updatedAt).toLocaleDateString()}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
