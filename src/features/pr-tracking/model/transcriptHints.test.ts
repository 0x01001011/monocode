import { describe, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import { extractPrUrls, findTurnPrUrls, parsePrUrl } from "./transcriptHints";

describe("extractPrUrls", () => {
  it("finds pull request URLs in prose", () => {
    expect(
      extractPrUrls(
        "Opened https://github.com/acme/web/pull/482 and https://github.com/acme/api/pull/7 today",
      ),
    ).toEqual([
      "https://github.com/acme/web/pull/482",
      "https://github.com/acme/api/pull/7",
    ]);
  });

  it("strips trailing punctuation", () => {
    expect(
      extractPrUrls(
        "See https://github.com/acme/web/pull/1. Also https://github.com/acme/web/pull/2, https://github.com/acme/web/pull/3; (https://github.com/acme/web/pull/4) and https://github.com/acme/web/pull/5!",
      ),
    ).toEqual([1, 2, 3, 4, 5].map((n) => `https://github.com/acme/web/pull/${n}`));
  });

  it("reads markdown links and autolinks", () => {
    expect(
      extractPrUrls(
        "[#12](https://github.com/acme/web/pull/12) <https://github.com/acme/web/pull/13> [https://github.com/acme/web/pull/14](https://github.com/acme/web/pull/14)",
      ),
    ).toEqual([
      "https://github.com/acme/web/pull/12",
      "https://github.com/acme/web/pull/13",
      "https://github.com/acme/web/pull/14",
    ]);
  });

  it("ignores issues, other hosts and incomplete paths", () => {
    expect(
      extractPrUrls(
        [
          "https://github.com/acme/web/issues/9",
          "https://gitlab.com/acme/web/pull/9",
          "https://evilgithub.com/acme/web/pull/9",
          "https://github.com.evil.io/acme/web/pull/9",
          "https://github.com/acme/web/pulls",
          "https://github.com/acme/web/pull/",
          "https://github.com/acme/web/pull/9abc",
          "https://github.com/acme/web/pull/0",
        ].join(" "),
      ),
    ).toEqual([]);
  });

  it("normalizes sub-pages, fragments and queries to the PR's base URL", () => {
    expect(
      extractPrUrls(
        "https://github.com/acme/web/pull/21/files https://github.com/acme/web/pull/22#issuecomment-1 https://github.com/acme/web/pull/23?w=1 http://www.github.com/acme/web/pull/24/commits/abc",
      ),
    ).toEqual([21, 22, 23, 24].map((n) => `https://github.com/acme/web/pull/${n}`));
  });

  it("de-duplicates, case-insensitively on owner and repo", () => {
    expect(
      extractPrUrls(
        "https://github.com/acme/web/pull/5 https://github.com/acme/web/pull/5/files https://github.com/Acme/Web/pull/5 https://github.com/acme/web/pull/6",
      ),
    ).toEqual([
      "https://github.com/acme/web/pull/5",
      "https://github.com/acme/web/pull/6",
    ]);
  });

  it("returns nothing for empty or URL-free text", () => {
    expect(extractPrUrls("")).toEqual([]);
    expect(extractPrUrls("PR #482 is ready")).toEqual([]);
  });
});

describe("parsePrUrl", () => {
  it("splits a normalized URL into repo and number", () => {
    expect(parsePrUrl("https://github.com/acme/web.js/pull/482")).toEqual({
      repo: "acme/web.js",
      number: 482,
    });
    expect(parsePrUrl("https://github.com/acme/web/issues/1")).toBeNull();
  });
});

function block(over: Partial<Block>): Block {
  return { id: Math.random().toString(36), role: "assistant", text: "", ...over };
}

describe("findTurnPrUrls", () => {
  it("marks URLs printed by a gh pr create tool call as created", () => {
    const found = findTurnPrUrls([
      block({ role: "user", text: "open a PR" }),
      block({
        role: "tool",
        tool: {
          kind: "execute",
          title: "gh pr create --title 'Fix' --body 'x'",
          preview: {
            kind: "shell",
            output: "\nhttps://github.com/acme/web/pull/482\n",
          },
        },
      }),
      block({
        text: "Done: https://github.com/acme/web/pull/482. Related to https://github.com/acme/web/pull/470.",
      }),
    ]);
    expect(found).toEqual([
      { url: "https://github.com/acme/web/pull/482", created: true },
      { url: "https://github.com/acme/web/pull/470", created: false },
    ]);
  });

  it("treats a 'Created pull request' line as created", () => {
    expect(
      findTurnPrUrls([
        block({ role: "user", text: "go" }),
        block({
          text: "Created pull request [#9](https://github.com/acme/web/pull/9).\nSee also https://github.com/acme/web/pull/3",
        }),
      ]),
    ).toEqual([
      { url: "https://github.com/acme/web/pull/9", created: true },
      { url: "https://github.com/acme/web/pull/3", created: false },
    ]);
  });

  it("only scans the latest turn", () => {
    expect(
      findTurnPrUrls([
        block({ role: "user", text: "first" }),
        block({ text: "https://github.com/acme/web/pull/1" }),
        block({ role: "user", text: "second https://github.com/acme/web/pull/2" }),
        block({ text: "https://github.com/acme/web/pull/3" }),
      ]),
    ).toEqual([{ url: "https://github.com/acme/web/pull/3", created: false }]);
  });

  it("reads tool output and subagent steps but not reasoning or user text", () => {
    expect(
      findTurnPrUrls([
        block({ role: "user", text: "go" }),
        block({ role: "reasoning", text: "https://github.com/acme/web/pull/1" }),
        block({
          role: "tool",
          tool: { title: "gh pr view", detail: "https://github.com/acme/web/pull/2" },
        }),
        block({
          role: "tool",
          agentRun: {
            name: "Ship",
            steps: [
              {
                id: "a",
                kind: "tool",
                text: "gh pr create --fill",
                preview: { kind: "shell", output: "https://github.com/acme/web/pull/4" },
              },
            ],
          },
        }),
      ]),
    ).toEqual([
      { url: "https://github.com/acme/web/pull/2", created: false },
      { url: "https://github.com/acme/web/pull/4", created: true },
    ]);
  });
});
