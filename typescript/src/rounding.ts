/**
 * How money is rounded, stated once instead of decided six times.
 *
 * Every financial subsystem in this package divides: a fee is a share of an
 * amount, interest is a share of a balance, an instalment is a loan split into
 * parts. Integer division has to round somewhere, and *where* is a policy
 * decision an operator should be able to see and set rather than discover.
 *
 * Three rules govern everything here.
 *
 * **One rounding, one number.** Whatever a division rounds to, both sides of
 * the resulting posting use that same number. The fee the payer pays is the fee
 * the recipient receives, to the unit. Money cannot leak through a rounding
 * because no posting is ever built from two separately-rounded halves.
 *
 * **Splitting is exact.** `distribute` hands out a remainder rather than
 * dropping it, so three members sharing 1000 receive 334, 333 and 333 — not 333
 * each with a unit lost. That is the largest-remainder method, and the
 * tie-break is by position so both editions agree.
 *
 * **Rounding is symmetric about zero.** `DOWN` means towards zero and `UP`
 * means away from it, not towards minus infinity. A refund of a fee is then the
 * same size as the fee, which is the behaviour a member expects and the one an
 * auditor can check.
 */
import { ValidationError } from "./errors.js";

/**
 * Where a division that does not come out even is sent.
 *
 * All four are symmetric about zero, so `-x` rounds to `-round(x)`.
 */
export enum Rounding {
  /** Towards zero. The payer keeps the fraction. */
  Down = "DOWN",
  /** Away from zero. The recipient gets the fraction. */
  Up = "UP",
  /**
   * To the nearer, and away from zero exactly halfway. What people mean by
   * "rounding" when they are not thinking about it.
   */
  HalfUp = "HALF_UP",
  /**
   * To the nearer, and to the even one exactly halfway. Removes the upward bias
   * HalfUp has over many roundings, which is why accountants use it.
   */
  HalfEven = "HALF_EVEN",
}

/**
 * `numerator / denominator` as an integer, rounded by `mode`.
 *
 * The one division in this package. Everything that computes a share of an
 * amount comes through here, so there is exactly one place where a rounding
 * decision is made and exactly one place to check that both editions make it
 * the same way.
 *
 * ```ts
 * divideRounded(7, 2, Rounding.Down);    // 3
 * divideRounded(7, 2, Rounding.HalfUp);  // 4
 * divideRounded(-7, 2, Rounding.Down);   // -3
 * ```
 *
 * `Math.floor` rounds towards minus infinity and Python's `//` does the same,
 * so neither is used: the sign is taken off first, the division is done on
 * magnitudes, and the sign is put back. That is what makes the result
 * symmetric, and it is why `Math.floor(-7 / 2)` (which is `-4`) is not the
 * answer above.
 */
export function divideRounded(
  numerator: number,
  denominator: number,
  mode: Rounding = Rounding.Down,
): number {
  if (!Number.isSafeInteger(numerator)) {
    throw new ValidationError("numerator must be an integer", { numerator });
  }
  if (!Number.isSafeInteger(denominator)) {
    throw new ValidationError("denominator must be an integer", { denominator });
  }
  if (denominator === 0) {
    throw new ValidationError("Cannot divide by zero", {});
  }

  const negative = numerator < 0 !== denominator < 0;
  const top = Math.abs(numerator);
  const bottom = Math.abs(denominator);

  // `Math.floor(a / b)` is not integer division. IEEE division is correctly
  // rounded to the nearest *double*, and near 2^53 the nearest double can sit
  // on the wrong side of an integer — so the floor comes back one too low or
  // one too high, and the remainder computed from it is then nonsense.
  //
  // Found by the differential harness, on `9007199254737658 / 360`: Python said
  // one thing, this edition said one less, and every vector in the repository
  // passed because none of them divided a number that large by anything but a
  // power of ten.
  //
  // Two paths, and the boundary between them is proved rather than guessed:
  // every product below is at most `top + bottom`, so while that fits in a
  // double every step here is exact and the correction below is enough. Past
  // it, the only honest answer is BigInt.
  if (top > Number.MAX_SAFE_INTEGER - bottom) {
    return Number(divideExactRounded(BigInt(numerator), BigInt(denominator), mode));
  }

  let quotient = Math.floor(top / bottom);
  // At most one step in either direction, but written as a loop rather than as
  // two ifs: a bound that is "obviously one" is exactly the kind of obvious
  // that this function has already been wrong about once.
  while (quotient * bottom > top) quotient -= 1;
  while ((quotient + 1) * bottom <= top) quotient += 1;
  const remainder = top - quotient * bottom;

  if (remainder !== 0) {
    if (mode === Rounding.Up) {
      quotient += 1;
    } else if (mode === Rounding.HalfUp) {
      if (remainder * 2 >= bottom) quotient += 1;
    } else if (mode === Rounding.HalfEven) {
      const doubled = remainder * 2;
      if (doubled > bottom || (doubled === bottom && quotient % 2 === 1)) quotient += 1;
    }
    // Rounding.Down keeps the truncated quotient.
  }

  // `|| 0` so a rounded-away negative comes back as 0 rather than -0, which
  // Python has no spelling for.
  return negative ? -quotient || 0 : quotient;
}

/**
 * `numerator / denominator` rounded by `mode`, where the numerator is exact.
 *
 * The BigInt sibling of {@link divideRounded}, for the sites that multiply
 * before they divide. Splitting them would defeat the point: it is the
 * *product* that overflows, so the product must never become a `number` before
 * the division brings it back into range.
 */
export function divideExactRounded(
  numerator: bigint,
  denominator: bigint,
  mode: Rounding = Rounding.Down,
): bigint {
  if (denominator === 0n) {
    throw new ValidationError("Cannot divide by zero", {});
  }

  const negative = numerator < 0n !== denominator < 0n;
  const top = numerator < 0n ? -numerator : numerator;
  const bottom = denominator < 0n ? -denominator : denominator;

  let quotient = top / bottom;
  const remainder = top - quotient * bottom;

  if (remainder !== 0n) {
    if (mode === Rounding.Up) {
      quotient += 1n;
    } else if (mode === Rounding.HalfUp) {
      if (remainder * 2n >= bottom) quotient += 1n;
    } else if (mode === Rounding.HalfEven) {
      const doubled = remainder * 2n;
      if (doubled > bottom || (doubled === bottom && quotient % 2n === 1n)) quotient += 1n;
    }
  }

  return negative ? -quotient : quotient;
}
