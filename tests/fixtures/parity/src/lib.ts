/**
 * @module lib
 *
 * Deterministic functions for the parity check. Integer arithmetic and
 * spec-defined number formatting only, so identical output across runtimes is
 * a property of the distributions rather than of floating-point luck.
 */

/** Aggregate statistics over a list of numbers. */
export interface Stats {
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
}

/** Greet a name. Exists so the parity check exercises string output too. */
export function greet(name: string): string {
  return `hello, ${name}`;
}

/** Compute aggregate statistics. An empty input yields all zeroes. */
export function stats(values: readonly number[]): Stats {
  if (values.length === 0) {
    return { count: 0, sum: 0, min: 0, max: 0, mean: 0 };
  }
  let sum = 0;
  let min = values[0] ?? 0;
  let max = min;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { count: values.length, sum, min, max, mean: sum / values.length };
}
