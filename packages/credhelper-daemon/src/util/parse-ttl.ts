const MULTIPLIERS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a duration string such as "1h", "30m", "2d", or "45s" into
 * milliseconds.
 *
 * @param input - Duration string with a positive integer followed by a unit
 *   suffix (`s`, `m`, `h`, or `d`).
 * @returns The equivalent duration in milliseconds.
 * @throws {Error} If the input is empty, has an unknown suffix, a
 *   non-numeric/non-positive value, or is otherwise malformed.
 */
export function parseTtl(input: string): number {
  if (!input) {
    throw new Error("parseTtl: input must be a non-empty string");
  }

  const match = input.match(/^(\d+)([a-z])$/);

  if (!match) {
    throw new Error(
      `parseTtl: invalid duration string "${input}" — expected a positive integer followed by one of s, m, h, d`,
    );
  }

  const value = Number(match[1]!);
  const suffix = match[2]!;

  if (value <= 0) {
    throw new Error(
      `parseTtl: duration must be a positive integer, got ${value}`,
    );
  }

  const multiplier = MULTIPLIERS[suffix];

  if (multiplier === undefined) {
    throw new Error(
      `parseTtl: unknown suffix "${suffix}" — expected one of s, m, h, d`,
    );
  }

  return value * multiplier;
}
