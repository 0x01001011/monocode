import type { ArtifactKind } from "./artifacts";

/** User-facing words for an artifact; neutral until its kind is known. */
export function artifactWording(kind?: ArtifactKind) {
  const noun =
    kind === "html" ? "web page" : kind === "document" ? "document" : "artifact";
  return {
    noun,
    label: noun.charAt(0).toUpperCase() + noun.slice(1),
    loading: kind ? `Loading ${noun}…` : "Loading…",
    missing: `This ${noun} is no longer available.`,
    copyFailed: `Could not copy this ${noun}.`,
    loadFailed: `Could not load this ${noun}.`,
    close: `Close ${noun}`,
  };
}
