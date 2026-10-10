import { describe, expect, it } from "vitest";
import { isSafePlanPath, planFilePath, planRootFor } from "./planRoot";

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
  it("resolves a relative plan path against the plan root", () => {
    expect(planFilePath("/wt/mc-1", "docs/plan.md")).toBe("/wt/mc-1/docs/plan.md");
    expect(planFilePath("/wt/mc-1/", "docs/plan.md")).toBe("/wt/mc-1/docs/plan.md");
    expect(planFilePath("/wt/mc-1", "./docs/my plan.md")).toBe("/wt/mc-1/./docs/my plan.md");
    expect(planFilePath("C:\\wt", "docs\\plan.md")).toBe("C:\\wt/docs\\plan.md");
  });

  it("keeps an absolute path that is inside the plan root", () => {
    expect(planFilePath("/wt/mc-1", "/wt/mc-1/docs/plan.md")).toBe("/wt/mc-1/docs/plan.md");
    expect(planFilePath("/wt/mc-1/", "/wt/mc-1/docs/plan.md")).toBe("/wt/mc-1/docs/plan.md");
    expect(planFilePath("C:\\wt", "C:\\wt\\docs\\plan.md")).toBe("C:\\wt\\docs\\plan.md");
    expect(planFilePath("C:\\wt", "c:/WT/docs/plan.md")).toBe("c:/WT/docs/plan.md");
  });

  it.each([
    ["/abs/plan.md"],
    ["/wt/mc-10/plan.md"],
    ["/wt/mc-1"],
    ["D:\\plan.md"],
  ])("rejects the absolute path %s outside the plan root", (path) => {
    expect(planFilePath("/wt/mc-1", path)).toBeUndefined();
  });

  it.each([
    ["../secret.md"],
    ["docs/../../secret.md"],
    ["docs\\..\\..\\secret.md"],
    ["/wt/mc-1/docs/../../etc/passwd.md"],
    [".."],
  ])("rejects the traversal %s", (path) => {
    expect(planFilePath("/wt/mc-1", path)).toBeUndefined();
  });

  it.each([["https://example.com/plan.md"], ["file:///etc/hosts.md"], ["ssh://host/plan.md"]])(
    "rejects the URL %s",
    (path) => {
      expect(planFilePath("/wt/mc-1", path)).toBeUndefined();
    },
  );

  it.each([["~/plan.md"], ["~root/plan.md"], ["~"]])("rejects the tilde path %s", (path) => {
    expect(planFilePath("/wt/mc-1", path)).toBeUndefined();
  });

  it("rejects an empty path, and still allows dots inside names", () => {
    expect(planFilePath("/wt/mc-1", "  ")).toBeUndefined();
    expect(planFilePath("/wt/mc-1", "docs/a..b.md")).toBe("/wt/mc-1/docs/a..b.md");
  });
});

describe("isSafePlanPath", () => {
  it("allows a relative path without a root, and no absolute path", () => {
    expect(isSafePlanPath(undefined, "docs/spec.md")).toBe(true);
    expect(isSafePlanPath(undefined, "/wt/docs/spec.md")).toBe(false);
    expect(isSafePlanPath("/wt", "/wt/docs/spec.md")).toBe(true);
  });
});
