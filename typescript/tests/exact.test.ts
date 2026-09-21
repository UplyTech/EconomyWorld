import { describe, expect, it } from "vitest";
import { fitsSafely, mulDivTrunc, mulExact, mulModExact, toNumber } from "../src/exact.js";

/**
 * The arithmetic that keeps this edition honest.
 *
 * Python multiplies exactly at any size; JavaScript stops being exact at 2^53.
 * Every place this package multiplies before it divides goes through here, so
 * that an intermediate product past the safe range is computed in BigInt and
 * the two editions come back with the same answer — or refuse together.
 *
 * There is no Python mirror for this file: it exists because of a JavaScript
 * limit that Python does not have.
 */

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 2^53 - 1
const MIN_SAFE = Number.MIN_SAFE_INTEGER;

describe("mulExact", () => {
  it("agrees with ordinary multiplication while ordinary multiplication is right", () => {
    for (const [a, b] of [
      [0, 0],
      [1, 1],
      [7, 6],
      [-7, 6],
      [7, -6],
      [-7, -6],
      [1_000_000, 1_000],
    ]) {
      expect(mulExact(a!, b!)).toBe(BigInt(a! * b!));
    }
  });

  it("stays exact where a number would not", () => {
    // 94906266^2 is 9007199326062756, past 2^53 — the float result is even, the
    // true result is not, and a rounding decision made on it would be wrong.
    const product = mulExact(94_906_266, 94_906_266);
    expect(product).toBe(9_007_199_326_062_756n);
    expect(product % 2n).toBe(0n);
    expect(mulExact(MAX_SAFE, 2)).toBe(18_014_398_509_481_982n);
  });
});

describe("fitsSafely", () => {
  it("accepts the whole safe range and nothing beyond it", () => {
    expect(fitsSafely(BigInt(MAX_SAFE))).toBe(true);
    expect(fitsSafely(BigInt(MIN_SAFE))).toBe(true);
    expect(fitsSafely(0n)).toBe(true);
    expect(fitsSafely(BigInt(MAX_SAFE) + 1n)).toBe(false);
    expect(fitsSafely(BigInt(MIN_SAFE) - 1n)).toBe(false);
  });
});

describe("toNumber", () => {
  it("converts what fits", () => {
    expect(toNumber(42n)).toBe(42);
    expect(toNumber(BigInt(MAX_SAFE))).toBe(MAX_SAFE);
    expect(toNumber(BigInt(MIN_SAFE))).toBe(MIN_SAFE);
  });

  it("returns null rather than a rounded answer", () => {
    // The whole point: a caller that gets a number back knows it is the number,
    // and a caller that gets null knows to refuse rather than to guess.
    expect(toNumber(BigInt(MAX_SAFE) + 1n)).toBeNull();
    expect(toNumber(BigInt(MIN_SAFE) - 1n)).toBeNull();
  });
});

describe("mulDivTrunc", () => {
  it("multiplies then divides, in that order", () => {
    // Dividing first would lose the remainder: 7/2*4 is 12 in integers, and the
    // right answer is 14.
    expect(mulDivTrunc(7, 4, 2)).toBe(14);
    expect(mulDivTrunc(100, 250, 10_000)).toBe(2);
  });

  it("truncates towards zero on both signs", () => {
    expect(mulDivTrunc(7, 1, 2)).toBe(3);
    expect(mulDivTrunc(-7, 1, 2)).toBe(-3);
    expect(mulDivTrunc(7, -1, 2)).toBe(-3);
  });

  it("takes the exact path when the product leaves the safe range", () => {
    // 9007199254740991 * 3 / 3 is exactly the input. Computed as a float the
    // product rounds and the answer comes back one too low.
    expect(mulDivTrunc(MAX_SAFE, 3, 3)).toBe(MAX_SAFE);
    expect(mulDivTrunc(94_906_266, 94_906_266, 94_906_266)).toBe(94_906_266);
  });

  it("returns zero rather than a sign for a product smaller than the divisor", () => {
    expect(mulDivTrunc(1, 1, 1_000)).toBe(0);
    expect(mulDivTrunc(-1, 1, 1_000)).toBe(-0);
  });
});

describe("mulModExact", () => {
  it("gives the remainder the exact product would leave", () => {
    expect(mulModExact(7, 3, 5)).toBe(1n);
    expect(mulModExact(100, 250, 10_000)).toBe(5_000n);
    expect(mulModExact(10, 10, 5)).toBe(0n);
  });

  it("stays exact past the safe range", () => {
    // The remainder is what a rounding mode decides on, so it has to be the
    // true one: a float product would round the remainder away entirely.
    expect(mulModExact(94_906_266, 94_906_266, 1_000)).toBe(756n);
    expect(mulModExact(MAX_SAFE, 2, 7)).toBe(18_014_398_509_481_982n % 7n);
  });

  it("takes the sign of the dividend, as integer arithmetic does", () => {
    expect(mulModExact(-7, 3, 5)).toBe(-1n);
    expect(mulModExact(7, -3, 5)).toBe(-1n);
  });
});
