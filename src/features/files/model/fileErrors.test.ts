import { describe, expect, it } from "vitest";
import { describeFileError } from "./fileErrors";

describe("describeFileError", () => {
  it.each([
    ["/repo/a.md: No such file or directory (os error 2)", "not-found"],
    ["ENOENT: no such file or directory, open '/x'", "not-found"],
    ["/root/x: Permission denied (os error 13)", "no-permission"],
    ["File is too large to edit (maximum 1 MB).", "too-large"],
    ["Binary files cannot be edited.", "binary"],
    ["File is not valid UTF-8.", "binary"],
    ["[ssh:refused] Machine is unreachable. Check the host.", "unreachable"],
    ["[ssh:timeout] The host request did not complete. Retry to confirm its result.", "timeout"],
    ["Path is outside the project", "outside-project"],
    ["something odd", "other"],
  ])("classifies %j as %s", (message, kind) => {
    expect(describeFileError(new Error(message)).kind).toBe(kind);
  });

  it("strips transport tags from the detail and gives a next step", () => {
    const info = describeFileError("[ssh:timeout] The host request did not complete.");
    expect(info.detail).toBe("The host request did not complete.");
    expect(info.hint).toMatch(/Retry/);
  });

  it("leaves unknown errors to their own message", () => {
    expect(describeFileError("boom")).toEqual({ kind: "other", hint: "", detail: "boom" });
  });
});
