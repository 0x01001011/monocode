import { expect, it } from "vitest";
import { bearerMatches } from "./secret";

const secret = "a".repeat(43);

it("accepts exactly the expected bearer credential", () => {
  expect(bearerMatches(`Bearer ${secret}`, secret)).toBe(true);
});

it.each([
  undefined,
  "",
  secret,
  `Bearer ${secret}x`,
  `Bearer ${secret.slice(1)}`,
  `Bearer ${"b".repeat(43)}`,
  `bearer ${secret}`,
  `Bearer  ${secret}`,
])("rejects %j", (header) => {
  expect(bearerMatches(header, secret)).toBe(false);
});
