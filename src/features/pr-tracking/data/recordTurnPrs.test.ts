import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../sessions/model/session";

const h = vi.hoisted(() => ({
  recordPrUrl: vi.fn(async () => undefined),
  recordPrHints: vi.fn(async () => undefined),
}));
vi.mock("./prTracking", () => ({
  recordPrUrl: h.recordPrUrl,
  recordPrHints: h.recordPrHints,
}));

async function load() {
  vi.resetModules();
  return import("./recordTurnPrs");
}

let n = 0;
const block = (over: Partial<Block>): Block => ({
  id: `b${(n += 1)}`,
  role: "assistant",
  text: "",
  ...over,
});

function session(blocks: Block[], over: Record<string, unknown> = {}) {
  return { id: "s1", cwd: "/work/web", blocks, ...over };
}

const created = block({
  role: "tool",
  tool: {
    title: "gh pr create --fill",
    preview: { kind: "shell", output: "https://github.com/acme/web/pull/482" },
  },
});

beforeEach(() => {
  h.recordPrUrl.mockClear();
  h.recordPrHints.mockClear();
});

describe("recordTurnPrs", () => {
  it("records created PRs by URL and the rest as hints per repo", async () => {
    const { recordTurnPrs } = await load();
    recordTurnPrs(
      session([
        block({ role: "user", text: "ship it" }),
        created,
        block({
          text: "Stacked on https://github.com/acme/web/pull/470 and https://github.com/acme/web/pull/471, see https://github.com/acme/api/pull/9",
        }),
      ]),
    );
    expect(h.recordPrUrl).toHaveBeenCalledTimes(1);
    expect(h.recordPrUrl).toHaveBeenCalledWith(
      "s1",
      "https://github.com/acme/web/pull/482",
    );
    expect(h.recordPrHints.mock.calls).toEqual([
      ["s1", "/work/web", [470, 471], "acme/web"],
      ["s1", "/work/web", [9], "acme/api"],
    ]);
  });

  it("uses the worktree checkout for hints", async () => {
    const { recordTurnPrs } = await load();
    recordTurnPrs(
      session(
        [block({ role: "user" }), block({ text: "https://github.com/acme/web/pull/5" })],
        { worktreeCwd: "/work/web-wt" },
      ),
    );
    expect(h.recordPrHints).toHaveBeenCalledWith(
      "s1",
      "/work/web-wt",
      [5],
      "acme/web",
    );
  });

  it("de-duplicates per session in memory, but lets a hint become created", async () => {
    const { recordTurnPrs } = await load();
    const hint = session([
      block({ role: "user" }),
      block({ text: "https://github.com/acme/web/pull/482" }),
    ]);
    recordTurnPrs(hint);
    recordTurnPrs(hint);
    expect(h.recordPrHints).toHaveBeenCalledTimes(1);
    recordTurnPrs(session([block({ role: "user" }), created]));
    recordTurnPrs(session([block({ role: "user" }), created]));
    expect(h.recordPrUrl).toHaveBeenCalledTimes(1);
    // Created already: a later mention is not downgraded to a hint.
    recordTurnPrs(hint);
    expect(h.recordPrHints).toHaveBeenCalledTimes(1);
    // Another chat is tracked on its own.
    recordTurnPrs({ ...hint, id: "s2" });
    expect(h.recordPrHints).toHaveBeenCalledTimes(2);
  });

  it("skips remote sessions and never throws", async () => {
    const { recordTurnPrs } = await load();
    recordTurnPrs(
      session([block({ role: "user" }), created], {
        cwd: "remote://env-1/work",
      }),
    );
    expect(h.recordPrUrl).not.toHaveBeenCalled();
    h.recordPrUrl.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(() =>
      recordTurnPrs(session([block({ role: "user" }), created])),
    ).not.toThrow();
    expect(() =>
      recordTurnPrs({ id: "s3", cwd: "/x", blocks: null } as never),
    ).not.toThrow();
  });
});
