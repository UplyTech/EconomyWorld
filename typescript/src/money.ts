import { BASIS_POINTS_ONE, MAX_BALANCE, PERMILLE_ONE } from "./constants.js";
import { ConfigurationError, InvalidAmountError, ValidationError } from "./errors.js";
import { mulExact, toNumber } from "./exact.js";
import { Rounding, divideExactRounded } from "./rounding.js";

/**
 * A currency in a community's economy.
 *
 * Amounts are **always integers in the smallest unit**. A currency with
 * `minorUnits: 2` and an amount of `1234` means 12.34 of it. Floating-point
 * money accumulates rounding errors that turn into visible discrepancies over
 * a few million bookings, and — worse — into differences between the Python
 * and the TypeScript edition. There is no float anywhere in this package.
 *
 * If you want to show fractions, pick a smaller smallest unit.
 *
 * This is play money, and nothing in this package changes that: there is no
 * conversion to a real currency, no payment provider, no payout.
 */
export interface Currency {
  /** Short identifier, e.g. `"COIN"`. Unique within an engine. */
  readonly code: string;
  /** Human-readable name, for the caller's own display code. */
  readonly name: string;
  /** Symbol, for the caller's own display code. */
  readonly symbol: string;
  /**
   * How many decimal places the currency shows.
   *
   * `0` means whole coins; `2` means the stored integer is hundredths. The
   * package never divides by this — it is metadata for the caller's formatter.
   */
  readonly minorUnits: number;
  /** Ceiling for a single member account. Guards against overflow. */
  readonly maxBalance: number;
}

/** Loose input for {@link createCurrency}. */
export interface CurrencyInput {
  readonly code: string;
  readonly name?: string;
  readonly symbol?: string;
  readonly minorUnits?: number;
  readonly maxBalance?: number;
}

/** Build a validated {@link Currency}. */
export function createCurrency(input: CurrencyInput): Currency {
  const code = input.code;
  if (typeof code !== "string" || code.length === 0) {
    throw new ConfigurationError("A currency needs a non-empty code", { code });
  }
  const minorUnits = input.minorUnits ?? 0;
  if (!Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 8) {
    throw new ConfigurationError("minorUnits must be an integer between 0 and 8", {
      minorUnits,
    });
  }
  const maxBalance = input.maxBalance ?? MAX_BALANCE;
  if (!Number.isSafeInteger(maxBalance) || maxBalance <= 0) {
    throw new ConfigurationError("maxBalance must be a positive safe integer", {
      maxBalance,
    });
  }
  if (maxBalance > MAX_BALANCE) {
    throw new ConfigurationError(
      "maxBalance exceeds the range both editions can hold exactly",
      { maxBalance, limit: MAX_BALANCE },
    );
  }

  return Object.freeze({
    code,
    name: input.name ?? code,
    symbol: input.symbol ?? code,
    minorUnits,
    maxBalance,
  });
}

/**
 * Split an amount into its whole and fractional parts.
 *
 * Pure arithmetic on integers — this package does not format money, because a
 * display format is a locale decision and belongs to the caller. What it can
 * do is take the awkward part off your hands: the sign handling that everyone
 * gets wrong for negative amounts.
 *
 * ```ts
 * splitMinorUnits(-1234, { minorUnits: 2 })  // { negative: true, whole: 12, fraction: 34 }
 * ```
 */
/**
 * An amount split into the parts a formatter needs.
 *
 * Named rather than inline so that the Python edition's `MinorUnits` has a
 * counterpart a caller can annotate with — the two editions expose the same
 * answers under the same names, and a shape with no name is not one.
 *
 * `negative` is a flag rather than a sign on `whole`, because "-0.05" has a
 * whole part of zero and is still negative.
 */
export interface MinorUnits {
  readonly negative: boolean;
  readonly whole: number;
  readonly fraction: number;
}

export function splitMinorUnits(
  amount: number,
  currency: Pick<Currency, "minorUnits">,
): MinorUnits {
  assertWholeAmount(amount);
  const negative = amount < 0;
  const magnitude = Math.abs(amount);
  const divisor = 10 ** currency.minorUnits;
  return {
    negative,
    whole: Math.floor(magnitude / divisor),
    fraction: magnitude % divisor,
  };
}

/**
 * Multiply an amount by a chain of permille factors.
 *
 * Applied one after another, in the order given. The order is part of the
 * contract: rounding twice is not commutative, and two editions that disagreed
 * about the order would disagree about the balance.
 *
 * Rounds towards zero, which is what the 1.x behaviour was for positive amounts.
 * Use {@link applyRate} when you want to choose.
 *
 * **A factor above 1000 can produce an answer outside the range both editions
 * hold exactly, and that is refused rather than returned.** Python would hand
 * back the exact integer and this edition a rounded one, which is the single
 * failure this package is built to make impossible — see the 2.0.0 changelog
 * for what it cost before it was checked.
 */
export function applyPermille(amount: number, permilles: readonly number[]): number {
  let value = amount;
  for (const permille of permilles) {
    if (!Number.isSafeInteger(permille) || permille < 0) {
      throw new InvalidAmountError("A permille factor must be a non-negative integer", {
        permille,
      });
    }
    value = exactToAmount(
      divideExactRounded(mulExact(value, permille), BigInt(PERMILLE_ONE), Rounding.Down),
    );
  }
  return value;
}

/**
 * An exact result as an amount, or a refusal.
 *
 * The guard that makes a divergence impossible rather than unlikely. A factor
 * above one can push a product past the range this package works in; Python
 * would hand back the exact integer and this edition a rounded one, and the two
 * would then disagree about a balance. Neither returns it.
 */
function exactToAmount(value: bigint): number {
  const asNumber = toNumber(value);
  if (asNumber === null) {
    throw new InvalidAmountError(
      "Amounts must stay inside the range both editions can hold exactly",
      { amount: value.toString() },
    );
  }
  assertWholeAmount(asNumber);
  return asNumber;
}

/**
 * A share of an amount, in hundredths of a percent.
 *
 * Basis points rather than permille because that is the unit interest and fees
 * come in: 2.5 % is 250 basis points, and a permille figure could not express it
 * without losing the half. One basis point on a thousand-unit balance is a tenth
 * of a unit, which rounds — so the rounding mode is an argument rather than a
 * decision made here.
 *
 * ```ts
 * applyBasisPoints(10_000, 250); // 250 — 2.5 % of 10,000
 * ```
 */
export function applyBasisPoints(
  amount: number,
  basisPoints: number,
  rounding: Rounding = Rounding.Down,
): number {
  assertWholeAmount(amount);
  if (!Number.isSafeInteger(basisPoints)) {
    throw new InvalidAmountError("A basis-point figure must be an integer", { basisPoints });
  }
  if (basisPoints < 0) {
    throw new InvalidAmountError("A basis-point figure must not be negative", { basisPoints });
  }
  return exactToAmount(
    divideExactRounded(mulExact(amount, basisPoints), BigInt(BASIS_POINTS_ONE), rounding),
  );
}

/**
 * `amount * numerator / denominator`, exact and rounded as asked.
 *
 * The general form the other two are special cases of, for a caller with a rate
 * this package has no unit for — an exchange rate, a revenue share, a price
 * expressed as a fraction.
 */
export function applyRate(
  amount: number,
  numerator: number,
  denominator: number,
  rounding: Rounding = Rounding.Down,
): number {
  assertWholeAmount(amount);
  if (!Number.isSafeInteger(numerator)) {
    throw new InvalidAmountError("A rate numerator must be an integer", { numerator });
  }
  if (!Number.isSafeInteger(denominator)) {
    throw new InvalidAmountError("A rate denominator must be an integer", { denominator });
  }
  if (denominator <= 0) {
    throw new InvalidAmountError("A rate denominator must be positive", { denominator });
  }
  return exactToAmount(
    divideExactRounded(mulExact(amount, numerator), BigInt(denominator), rounding),
  );
}

/**
 * Split an amount into shares that add back up to exactly it.
 *
 * The largest-remainder method. Divide by the weights, hand each share its whole
 * part, then give the units left over to the shares whose discarded fraction was
 * largest — one each, until none are left.
 *
 * ```ts
 * distribute(1000, [1, 1, 1]);  // [334, 333, 333]
 * ```
 *
 * The naive version of this is how a community loses a unit of currency every
 * time three people split a prize. Here nothing is lost, because the sum is the
 * postcondition rather than a hope: 334 + 333 + 333 is 1000, and the posting
 * balances.
 *
 * Ties are broken by position, so the earlier weight wins the spare unit. Any
 * rule would do; what matters is that both editions use the same one and that it
 * does not depend on an object's key order.
 */
export function distribute(amount: number, weights: readonly number[]): number[] {
  assertWholeAmount(amount);
  if (weights.length === 0) {
    throw new ValidationError("Cannot distribute across no weights", {});
  }

  let totalWeight = 0n;
  for (const weight of weights) {
    if (!Number.isSafeInteger(weight)) {
      throw new ValidationError("A weight must be an integer", { weight });
    }
    if (weight < 0) {
      throw new ValidationError("A weight must not be negative", { weight });
    }
    totalWeight += BigInt(weight);
  }
  if (totalWeight === 0n) {
    throw new ValidationError("The weights must not all be zero", {});
  }

  const negative = amount < 0;
  const magnitude = BigInt(Math.abs(amount));

  const shares: number[] = [];
  const remainders: bigint[] = [];
  let handedOut = 0n;
  for (const weight of weights) {
    const scaled = magnitude * BigInt(weight);
    const share = scaled / totalWeight;
    shares.push(Number(share));
    remainders.push(scaled % totalWeight);
    handedOut += share;
  }
  const leftOver = Number(magnitude - handedOut);

  // The indices with the largest discarded fraction, earliest first. The
  // position tie-break keeps it deterministic where two remainders are equal.
  const order = shares.map((unused, index) => index);
  order.sort((a, b) => {
    const left = remainders[a] as bigint;
    const right = remainders[b] as bigint;
    if (left !== right) return left > right ? -1 : 1;
    return a - b;
  });
  for (let taken = 0; taken < leftOver; taken += 1) {
    const index = order[taken] as number;
    shares[index] = (shares[index] as number) + 1;
  }

  return negative ? shares.map((share) => -share || 0) : shares;
}

/**
 * Split an amount into `parts` shares that add back up to exactly it.
 *
 * {@link distribute} with every weight equal, which is the case that comes up
 * most: an instalment plan, a prize split, a bill divided between members.
 */
export function distributeEvenly(amount: number, parts: number): number[] {
  if (!Number.isSafeInteger(parts) || parts <= 0) {
    throw new ValidationError("parts must be a positive integer", { parts });
  }
  return distribute(amount, new Array<number>(parts).fill(1));
}

/** Reject anything that is not a whole number of minor units. */
export function assertWholeAmount(amount: number): void {
  if (!Number.isSafeInteger(amount)) {
    throw new InvalidAmountError(
      "Amounts must be whole numbers of minor units inside the safe integer range",
      { amount },
    );
  }
}

/** Reject anything that is not a positive whole number of minor units. */
export function assertPositiveAmount(amount: number): void {
  assertWholeAmount(amount);
  if (amount <= 0) {
    throw new InvalidAmountError("Amount must be greater than zero", { amount });
  }
}
