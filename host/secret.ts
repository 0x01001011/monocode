import { timingSafeEqual } from "node:crypto";

/** Compare an Authorization header with `Bearer <secret>` in constant time. */
export function bearerMatches(
  header: string | undefined,
  secret: string,
): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header ?? "");
  // Only the length (a public format) can differ before the constant-time compare.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
