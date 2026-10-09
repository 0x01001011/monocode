import { describe, expect, it } from "vitest";
import { planFilePath, planRootFor } from "./planRoot";

describe("planRootFor", () => {
  it("is the session's working copy when it has one", () => {
    expect(planRootFor("/proj", { cwd: "/proj", worktreeCwd: "/wt/mc-1" })).toBe("/wt/mc-1");
  });

  it("is the project when the session works in the project itself", () => {
    expect(planRootFor("/proj", { cwd: "/proj" })).toBe("/proj");
    expect(planRootFor("/proj", { cwd: "/proj", worktreeCwd: "" })).toBe("/proj");
  });

  it("is the project when there is no session or it belongs to another project", () => {
    expect(planRootFor("/proj")).toBe("/proj");
    expect(planRootFor("/proj", { cwd: "/other", worktreeCwd: "/wt/other" })).toBe("/proj");
  });
});

describe("planFilePath", () => {
  it("resolves a relative plan path against the plan root and keeps an absolute one", () => {
    expect(planFilePath("/wt/mc-1", "docs/plan.md")).toBe("/wt/mc-1/docs/plan.md");
    expect(planFilePath("/wt/mc-1/", "docs/plan.md")).toBe("/wt/mc-1/docs/plan.md");
    expect(planFilePath("/wt/mc-1", "/abs/plan.md")).toBe("/abs/plan.md");
    expect(planFilePath("C:\\wt", "D:\\plan.md")).toBe("D:\\plan.md");
  });
});
