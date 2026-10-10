import { describe, expect, it } from "vitest";
import { shortSha } from "./taskBoard";

describe("shortSha", () => {
  it("shortens both ends of a range", () => {
    expect(shortSha("a1b2c3d4e5..f6a7b8c9")).toEqual(["a1b2c3d", "f6a7b8c"]);
  });
  it("shortens a bare sha", () => {
    expect(shortSha("abc1234")).toEqual(["abc1234"]);
    expect(shortSha("a1b2c3d4e5f6a7b8")).toEqual(["a1b2c3d"]);
  });
  it("returns nothing for refs that are not shas", () => {
    expect(shortSha("main")).toEqual([]);
    expect(shortSha("")).toEqual([]);
    expect(shortSha("abc")).toEqual([]);
    expect(shortSha("HEAD~1")).toEqual([]);
  });
  it("drops a range end that is not a sha", () => {
    expect(shortSha("a1b2c3d..main")).toEqual(["a1b2c3d"]);
  });
});
