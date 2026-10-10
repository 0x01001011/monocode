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
  const user = () => block({ role: "user", text: "go" });
  const shell = (command: string, output: string, over: Partial<Block> = {}) =>
    block({
      role: "tool",
      tool: {
        kind: "execute",
        title: command,
        preview: { kind: "shell", title: command, output },
      },
      ...over,
    });

  it("marks the URL printed by gh pr create as created", () => {
    expect(
      findTurnPrUrls([
        user(),
        shell(
          "gh pr create --title 'Fix' --body 'x'",
          "\nhttps://github.com/acme/web/pull/482\n",
        ),
        block({ text: "Done: https://github.com/acme/web/pull/482." }),
      ]),
    ).toEqual([{ url: "https://github.com/acme/web/pull/482", created: true }]);
  });

  it("never treats a URL in the command text (--body) as created", () => {
    expect(
      findTurnPrUrls([
        user(),
        shell(
          'gh pr create --title "Child" --body "Stacked on https://github.com/acme/web/pull/470"',
          "https://github.com/acme/web/pull/482",
        ),
      ]),
    ).toEqual([
      { url: "https://github.com/acme/web/pull/470", created: false },
      { url: "https://github.com/acme/web/pull/482", created: true },
    ]);
    // A pending call whose detail still holds the command creates nothing.
    expect(
      findTurnPrUrls([
        user(),
        block({
          role: "tool",
          tool: {
            title: "gh pr create --body 'see https://github.com/acme/web/pull/470'",
            detail:
              "Bash: gh pr create --body 'see https://github.com/acme/web/pull/470'",
          },
        }),
      ]),
    ).toEqual([{ url: "https://github.com/acme/web/pull/470", created: false }]);
  });

  it("counts only the last PR URL a create prints", () => {
    expect(
      findTurnPrUrls([
        user(),
        shell(
          "gh pr create --fill",
          "Warning: see https://github.com/acme/web/pull/12 for the template\nhttps://github.com/acme/web/pull/482",
        ),
      ]),
    ).toEqual([
      { url: "https://github.com/acme/web/pull/12", created: false },
      { url: "https://github.com/acme/web/pull/482", created: true },
    ]);
  });

  it("creates nothing when gh says the PR already exists (URL on the next line)", () => {
    expect(
      findTurnPrUrls([
        user(),
        shell(
          "gh pr create --fill",
          'a pull request for branch "mc/x" into branch "main" already exists:\nhttps://github.com/acme/web/pull/470',
        ),
      ]),
    ).toEqual([{ url: "https://github.com/acme/web/pull/470", created: false }]);
  });

  it("records nothing at all from gh pr view or gh pr list", () => {
    expect(
      findTurnPrUrls([
        user(),
        shell(
          "gh pr view https://github.com/acme/web/pull/2",
          "title: Thing\nurl: https://github.com/acme/web/pull/2",
        ),
        shell(
          "gh pr list --author @me",
          "#5 Fix https://github.com/acme/web/pull/5\n#6 Feat https://github.com/acme/web/pull/6",
        ),
      ]),
    ).toEqual([]);
  });

  it("treats assistant prose as hints, even 'Created a PR'", () => {
    expect(
      findTurnPrUrls([
        user(),
        block({
          text: "Created a PR: [#9](https://github.com/acme/web/pull/9).\nCreated pull request https://github.com/acme/web/pull/10",
        }),
      ]),
    ).toEqual([
      { url: "https://github.com/acme/web/pull/9", created: false },
      { url: "https://github.com/acme/web/pull/10", created: false },
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
        user(),
        block({ role: "reasoning", text: "https://github.com/acme/web/pull/1" }),
        block({
          role: "tool",
          tool: { title: "gh api repos/acme/web/pulls", detail: "https://github.com/acme/web/pull/2" },
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
              {
                id: "b",
                kind: "tool",
                text: "gh pr view 7",
                detail: "https://github.com/acme/web/pull/7",
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
