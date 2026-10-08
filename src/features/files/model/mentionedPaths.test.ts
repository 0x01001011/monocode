import { describe, expect, it } from "vitest";
import { mentionedFilePaths, transcriptTexts } from "./mentionedPaths";

const cwd = "/home/k/wt";
const remoteCwd = "remote://kgpu/home/k/wt";

describe("mentionedFilePaths", () => {
  it("finds a relative path the transcript used for a bare filename", () => {
    const texts = [
      "Its report goes to `autoresearch/loop-1/research.md`.",
      "The research report is in (`research.md`).",
    ];
    expect(mentionedFilePaths(texts, "research.md", cwd)).toEqual([
      "/home/k/wt/autoresearch/loop-1/research.md",
    ]);
  });

  it("keeps absolute mentions and maps them onto a remote project", () => {
    const texts = ["Written to /home/k/wt/out/loop-1/research.md."];
    expect(mentionedFilePaths(texts, "research.md", remoteCwd)).toEqual([
      "remote://kgpu/home/k/wt/out/loop-1/research.md",
    ]);
  });

  it("orders the most recent mention first and drops duplicates", () => {
    const texts = [
      "old: a/research.md",
      "new: b/research.md and again b/research.md",
    ];
    expect(mentionedFilePaths(texts, "research.md", cwd)).toEqual([
      "/home/k/wt/b/research.md",
      "/home/k/wt/a/research.md",
    ]);
  });

  it("ignores bare mentions and lookalike filenames", () => {
    const texts = ["see research.md", "my-research.md", "x/not-research.md"];
    expect(mentionedFilePaths(texts, "research.md", cwd)).toEqual([]);
  });

  it("matches a nested reference by its full relative suffix", () => {
    const texts = ["wrote loop-1/out/report.md"];
    expect(mentionedFilePaths(texts, "out/report.md", cwd)).toEqual([
      "/home/k/wt/loop-1/out/report.md",
    ]);
  });
});

describe("transcriptTexts", () => {
  const session = (cwd: string, text: string, worktreeCwd?: string) => ({
    cwd,
    worktreeCwd,
    blocks: [{ text, tool: { title: `t-${text}`, detail: `d-${text}` } }],
  });

  it("reads only sessions working in the checkout, in session order", () => {
    const sessions = [
      session("/p", "first-b", "/p-wt/b"),
      session("/p", "other-a", "/p-wt/a"),
      session("/p", "second-b", "/p-wt/b"),
    ];
    expect(transcriptTexts(sessions, "/p-wt/b")).toEqual([
      "first-b",
      "t-first-b",
      "d-first-b",
      "second-b",
      "t-second-b",
      "d-second-b",
    ]);
  });

  it("matches a session without a worktree by its project cwd", () => {
    expect(transcriptTexts([session("/p", "main")], "/p")).toContain("main");
  });

  it("is empty when no session works in the checkout", () => {
    expect(transcriptTexts([session("/p", "x")], "/elsewhere")).toEqual([]);
  });
});
