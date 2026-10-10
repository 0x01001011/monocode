// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseSuggestion } from "../model/baseSuggestion";
import type { PrEntry, PrSetView } from "../model/types";

type Deferred = { ref: string; resolve: (value: boolean) => void };
const h = vi.hoisted(() => ({ pending: [] as Deferred[] }));

vi.mock("../../../platform/tauri/fs", () => ({
  gitIsAncestor: (_cwd: string, ref: string) =>
    new Promise<boolean>((resolve) => h.pending.push({ ref, resolve })),
}));

import { useBaseSuggestion } from "./PrBaseField";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function entry(number: number, headRef: string): PrEntry {
  return {
    snapshot: {
      repo: "acme/web",
      number,
      url: `https://github.com/acme/web/pull/${number}`,
      title: `PR ${number}`,
      state: "open",
      isDraft: false,
      headRef,
      baseRef: "main",
      originalBaseRef: "main",
      headOid: `oid-${number}`,
      author: null,
      checks: "none",
      review: "none",
      mergeable: "mergeable",
      behindBy: null,
      fetchedAt: 0,
    },
    relation: "owned",
    ownerSessionId: "s1",
    onLiveBranch: false,
    parent: null,
    attention: "none",
    attentionReason: null,
    dismissed: false,
    error: null,
  };
}

const VIEW: PrSetView = {
  sessionId: "s1",
  entries: [entry(482, "mc/tasks-panel-keyboard")],
  stacks: [],
  tracking: "full",
  status: "ok",
  refreshedAt: null,
};

let seen: (BaseSuggestion | null)[] = [];
function Probe(props: { headBranch: string; head: string }) {
  seen.push(
    useBaseSuggestion({
      view: VIEW,
      cwd: "/repo",
      defaultBase: "main",
      remote: null,
      ...props,
    }),
  );
  return null;
}

let root: Root;
let container: HTMLElement;
const last = () => seen[seen.length - 1];
const render = (props: { headBranch: string; head: string }) =>
  act(() => root.render(createElement(Probe, props)));
async function settle(index: number, value: boolean) {
  await act(async () => {
    h.pending[index].resolve(value);
    await Promise.resolve();
  });
}

beforeEach(() => {
  h.pending = [];
  seen = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useBaseSuggestion", () => {
  it("keeps the last suggestion for the branch while a new commit recomputes", async () => {
    render({ headBranch: "mc/next", head: "c1" });
    expect(last()).toBeNull();
    await settle(0, true);
    expect(last()).toEqual({
      ref: "mc/tasks-panel-keyboard",
      prNumber: 482,
      stacked: true,
    });

    render({ headBranch: "mc/next", head: "c2" });
    expect(h.pending).toHaveLength(2);
    // Pending: no flicker to the default branch.
    expect(last()).toMatchObject({ ref: "mc/tasks-panel-keyboard" });
    await settle(1, false);
    expect(last()).toEqual({ ref: "main", prNumber: null, stacked: false });
  });

  it("drops the result on a branch change and ignores the stale answer", async () => {
    render({ headBranch: "mc/next", head: "c1" });
    await settle(0, true);
    expect(last()).toMatchObject({ stacked: true });

    render({ headBranch: "mc/other", head: "d1" });
    expect(last()).toBeNull();

    // A late answer for a superseded request changes nothing.
    render({ headBranch: "mc/third", head: "e1" });
    await settle(1, true);
    expect(last()).toBeNull();
    await settle(2, false);
    expect(last()).toEqual({ ref: "main", prNumber: null, stacked: false });
  });
});
