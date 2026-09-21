import { describe, expect, it } from "vitest";
import {
  divideExactRounded,
  divideRounded,
  Rounding,
  ValidationError,
} from "../src/index.js";

/**
 * The mirror of `python/tests/test_rounding.py`. Both editions round the same
 * way or the shared vectors are meaningless.
 */

const MODES = [Rounding.Down, Rounding.Up, Rounding.HalfUp, Rounding.HalfEven];

describe("divideRounded", () => {
  it("divides exactly when it can", () => {
    for (const mode of MODES) {
      expect(divideRounded(100, 4, mode)).toBe(25);
      expect(divideRounded(-100, 4, mode)).toBe(-25);
      expect(divideRounded(0, 7, mode)).toBe(0);
    }
  });

  it("rounds towards zero when told to go down", () => {
    // "Down" means towards zero, not towards minus infinity: a rule that is
    // symmetric about zero cannot favour one sign over the other.
    expect(divideRounded(7, 2, Rounding.Down)).toBe(3);
    expect(divideRounded(-7, 2, Rounding.Down)).toBe(-3);
  });

  it("rounds away from zero when told to go up", () => {
    expect(divideRounded(7, 2, Rounding.Up)).toBe(4);
    expect(divideRounded(-7, 2, Rounding.Up)).toBe(-4);
    expect(divideRounded(1, 1000, Rounding.Up)).toBe(1);
  });

  it("rounds a half away from zero", () => {
    expect(divideRounded(5, 2, Rounding.HalfUp)).toBe(3);
    expect(divideRounded(-5, 2, Rounding.HalfUp)).toBe(-3);
    expect(divideRounded(4, 2, Rounding.HalfUp)).toBe(2);
  });

  it("rounds a half to the even neighbour", () => {
    // The mode that does not drift upwards over a long run of halves, which is
    // what makes it the right default for interest paid out again and again.
    expect(divideRounded(5, 2, Rounding.HalfEven)).toBe(2);
    expect(divideRounded(7, 2, Rounding.HalfEven)).toBe(4);
    expect(divideRounded(-5, 2, Rounding.HalfEven)).toBe(-2);
    expect(divideRounded(-7, 2, Rounding.HalfEven)).toBe(-4);
  });

  it("never returns negative zero", () => {
    // `-0` compares equal to `0` but serialises as "-0", so a vector file would
    // differ from the Python edition on a value that is not actually different.
    for (const mode of MODES) {
      expect(Object.is(divideRounded(-1, 1000, mode), -0)).toBe(false);
    }
  });

  it("refuses a divisor of zero and non-integer input", () => {
    expect(() => divideRounded(1, 0)).toThrow(ValidationError);
    expect(() => divideRounded(1.5, 2)).toThrow(ValidationError);
    expect(() => divideRounded(1, 2.5)).toThrow(ValidationError);
    expect(() => divideRounded(Number.NaN, 2)).toThrow(ValidationError);
    expect(() => divideRounded(Number.POSITIVE_INFINITY, 2)).toThrow(ValidationError);
  });

  it("agrees with itself over a negative divisor", () => {
    for (const mode of MODES) {
      expect(divideRounded(7, -2, mode)).toBe(-divideRounded(7, 2, mode));
    }
  });
});

describe("the division that was wrong", () => {
  /**
   * `Math.floor(a / b)` is not integer division, and this is the edition it bit.
   *
   * IEEE division is correctly rounded to the nearest *double*, and near 2^53
   * the nearest double can sit on the wrong side of an integer — so the floor
   * came back one too low and the remainder computed from it was nonsense.
   * Python was right all along; this edition was not, and no vector in the
   * repository divided a number that large by anything but a power of ten.
   *
   * Found by the differential harness. These cases are also in
   * `shared/testcases/rounding.json`, so both editions are held to them.
   */

  it("divides the case the harness found", () => {
    expect(divideRounded(9_007_199_254_737_658, 360)).toBe(25_019_997_929_826);
  });

  it("stays exact across a sweep near the ceiling", () => {
    const MAX = Number.MAX_SAFE_INTEGER;
    for (const numerator of [MAX, MAX - 1, MAX - 333, 9_007_199_254_737_658]) {
      for (const denominator of [3, 7, 12, 360, 9973]) {
        // BigInt is the definition of right here: it is what Python's integers
        // do, and the whole point is agreeing with them.
        const expected = Number(BigInt(numerator) / BigInt(denominator));
        expect(divideRounded(numerator, denominator)).toBe(expected);
        expect(divideRounded(-numerator, denominator)).toBe(-expected);
      }
    }
  });

  it("still reads the remainder for every other mode", () => {
    // A wrong quotient gives a wrong remainder, and every mode but Down reads
    // the remainder.
    const numerator = 9_007_199_254_737_658;
    const denominator = 360;
    const exact = Number(BigInt(numerator) / BigInt(denominator));
    const remainder = Number(BigInt(numerator) % BigInt(denominator));
    expect(divideRounded(numerator, denominator, Rounding.Up)).toBe(exact + 1);
    expect(divideRounded(numerator, denominator, Rounding.HalfUp)).toBe(
      remainder * 2 >= denominator ? exact + 1 : exact,
    );
  });
});

describe("divideExactRounded", () => {
  it("rounds the same way on values no number can hold", () => {
    // The reason it exists: an intermediate product past 2^53 is exact in
    // Python and lossy in JavaScript, so the big cases go through BigInt.
    const big = 9_007_199_254_740_993n; // 2^53 + 1, not representable as a number
    expect(divideExactRounded(big, 2n, Rounding.Down)).toBe(4_503_599_627_370_496n);
    expect(divideExactRounded(big, 2n, Rounding.Up)).toBe(4_503_599_627_370_497n);
    expect(divideExactRounded(big, 2n, Rounding.HalfUp)).toBe(4_503_599_627_370_497n);
    expect(divideExactRounded(big, 2n, Rounding.HalfEven)).toBe(4_503_599_627_370_496n);
  });

  it("is symmetric about zero", () => {
    for (const mode of MODES) {
      expect(divideExactRounded(-7n, 2n, mode)).toBe(-divideExactRounded(7n, 2n, mode));
    }
  });

  it("refuses a divisor of zero", () => {
    expect(() => divideExactRounded(1n, 0n)).toThrow(ValidationError);
  });

  it("agrees with the number version wherever both are exact", () => {
    for (const mode of MODES) {
      for (const numerator of [0, 1, 7, -7, 100, -100, 12_345, -98_765]) {
        for (const denominator of [1, 2, 3, 7, 1000]) {
          expect(Number(divideExactRounded(BigInt(numerator), BigInt(denominator), mode))).toBe(
            divideRounded(numerator, denominator, mode),
          );
        }
      }
    }
  });
});
