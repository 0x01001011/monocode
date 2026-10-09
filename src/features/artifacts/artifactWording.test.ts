import { describe, expect, it } from "vitest";
import { artifactWording } from "./artifactWording";

describe("artifactWording", () => {
  it("names documents and web pages by what they are", () => {
    const doc = artifactWording("document");
    expect(doc).toMatchObject({
      noun: "document",
      label: "Document",
      loading: "Loading document…",
      missing: "This document is no longer available.",
      copyFailed: "Could not copy this document.",
      loadFailed: "Could not load this document.",
      close: "Close document",
    });
    const page = artifactWording("html");
    expect(page).toMatchObject({
      noun: "web page",
      label: "Web page",
      loading: "Loading web page…",
      missing: "This web page is no longer available.",
      copyFailed: "Could not copy this web page.",
      close: "Close web page",
    });
  });

  it("stays neutral until the kind is known", () => {
    const unknown = artifactWording();
    expect(unknown.noun).toBe("artifact");
    expect(unknown.label).toBe("Artifact");
    expect(unknown.loading).toBe("Loading…");
    expect(unknown.missing).toBe("This artifact is no longer available.");
    for (const text of Object.values(unknown)) expect(text).not.toMatch(/document/i);
  });
});
