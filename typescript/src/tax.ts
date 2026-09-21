/**
 * Fees and taxes: what a transaction costs beyond its amount.
 *
 * A transfer fee, a sales tax, a market commission, a wealth levy. All of them
 * are the same shape — a rule turns an amount into a smaller amount — so they
 * are one module rather than four scattered special cases.
 *
 * # Who pays is a separate question from how much
 *
 * A fee of 50 on a payment of 1000 can mean two things, and communities argue
 * about both:
 *
 * | mode        | meaning                                          |
 * | ----------- | ------------------------------------------------ |
 * | `OnTop`     | the payer sends 1050; the recipient gets 1000     |
 * | `Inclusive` | the payer sends 1000; the recipient gets 950      |
 *
 * Neither is more correct. {@link FeeMode} makes it explicit so that a bot's
 * "/pay 1000" and its confirmation message cannot disagree.
 *
 * # A fee is booked, never deducted
 *
 * {@link chargeFee} produces a posting to `system:fee`, so collected revenue is
 * a balance an operator can see and spend. Quietly reducing a member's balance
 * without a counter-line would put the books out by exactly the fees collected,
 * which is the same failure as minting without a mint.
 *
 * # A rate above the amount is allowed; a rate a hundred times it is not
 *
 * A fee of more than 100 % is a real thing — a penalty surcharge, a punitive
 * withdrawal charge — so it is not refused. A rate of a million basis points is
 * not a fee, it is a typo, and it is refused at the same ceiling interest rates
 * use: {@link MAX_FEE_BASIS_POINTS}.
 *
 * # Tiers are inclusive of their floor and exclusive of their ceiling
 *
 * A tier from 0 to 1000 and another from 1000 upwards do not overlap, and 1000
 * falls in the second. Written down because half of all tier bugs are somebody
 * assuming the other convention.
 */
import { type Account, SystemAccount, emptyAccount, systemAccount } from "./accounts.js";
import type { EconomyEngine } from "./engine.js";
import { ConfigurationError, ValidationError } from "./errors.js";
import { PostingKind } from "./ledger.js";
import { applyBasisPoints, assertWholeAmount, distribute } from "./money.js";
import { Rounding } from "./rounding.js";
import type { BookingResult } from "./types.js";

/**
 * The largest rate a fee rule or tier may charge: 10,000 %, the same ceiling
 * interest rates use. Above this a rate is a typo rather than a policy.
 */
export const MAX_FEE_BASIS_POINTS = 1_000_000;

/** Where the fee comes from. */
export enum FeeMode {
  /**
   * The payer pays the amount *plus* the fee. The recipient gets the amount they
   * were promised.
   */
  OnTop = "ON_TOP",
  /**
   * The fee comes out of the amount. The payer sends what they said; the
   * recipient receives less.
   */
  Inclusive = "INCLUSIVE",
}

/**
 * One band of a tiered fee.
 *
 * Applies to the part of the amount that falls inside the band, not to the whole
 * amount — the way income tax brackets work, and the way people expect a
 * "progressive" fee to behave.
 */
export interface FeeTier {
  /** Where the band starts. Inclusive. */
  readonly threshold: number;
  /** What the part of the amount inside this band is charged, in basis points. */
  readonly basisPoints: number;
}

/**
 * How much a transaction costs.
 *
 * A flat part, a proportional part and a tiered part, any of which may be zero.
 * Most rules use one; having all three in one shape means a community that
 * starts with a flat fee and later wants a percentage does not change the type
 * it stores.
 */
export interface FeeRule {
  readonly key: string;
  readonly mode: FeeMode;
  /** Charged on every transaction regardless of size. */
  readonly flat: number;
  /** Charged on the whole amount, in basis points. */
  readonly basisPoints: number;
  /** Charged band by band. Empty for a rule that does not use tiers. */
  readonly tiers: readonly FeeTier[];
  /** The least any transaction is charged, after everything else. */
  readonly minimum: number;
  /** The most any transaction is charged. `null` is uncapped. */
  readonly maximum: number | null;
  /** How the proportional parts are rounded. */
  readonly rounding: Rounding;
}

/** What a rule charges on one amount, and what is left. */
export interface FeeQuote {
  readonly ruleKey: string;
  readonly mode: FeeMode;
  /** The amount the caller asked about. */
  readonly amount: number;
  readonly fee: number;
  /** What the payer's account is debited in total. */
  readonly payerPays: number;
  /** What the recipient's account is credited. */
  readonly recipientReceives: number;
}

/**
 * True when the rule charged nothing.
 *
 * The Python edition reads this off the quote as `quote.free`; here it is a
 * function, the way `isClosed` and `isMature` are.
 */
export function isFree(quote: FeeQuote): boolean {
  return quote.fee === 0;
}

/** Build a validated fee tier. */
export function createTier(threshold: number, basisPoints: number): FeeTier {
  assertWholeAmount(threshold);
  if (threshold < 0) {
    throw new ConfigurationError("A tier threshold cannot be negative", { threshold });
  }
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0) {
    throw new ConfigurationError(
      "A tier rate must be a non-negative integer number of basis points",
      { basisPoints },
    );
  }
  if (basisPoints > MAX_FEE_BASIS_POINTS) {
    throw new ConfigurationError(
      `A tier rate is capped at ${MAX_FEE_BASIS_POINTS} basis points`,
      { basisPoints, limit: MAX_FEE_BASIS_POINTS },
    );
  }
  return { threshold, basisPoints };
}

/**
 * Build a validated fee rule.
 *
 * Tiers must ascend and the first must start at zero, so that every amount falls
 * in exactly one band and none is left uncovered. A rule whose tiers began at
 * 100 would silently charge nothing on the first hundred, which is a decision
 * that should be written as a tier of zero rather than implied by an omission.
 */
export function createFeeRule(
  key: string,
  options: Partial<Omit<FeeRule, "key">> = {},
): FeeRule {
  const rule: FeeRule = {
    key,
    mode: options.mode ?? FeeMode.OnTop,
    flat: options.flat ?? 0,
    basisPoints: options.basisPoints ?? 0,
    tiers: options.tiers ?? [],
    minimum: options.minimum ?? 0,
    maximum: options.maximum ?? null,
    rounding: options.rounding ?? Rounding.Down,
  };

  if (typeof key !== "string" || key.length === 0) {
    throw new ConfigurationError("A fee rule needs a non-empty key", { key });
  }
  assertWholeAmount(rule.flat);
  if (rule.flat < 0) {
    throw new ConfigurationError("A flat fee cannot be negative", { flat: rule.flat });
  }
  if (!Number.isSafeInteger(rule.basisPoints) || rule.basisPoints < 0) {
    throw new ConfigurationError(
      "A fee rate must be a non-negative integer number of basis points",
      { basisPoints: rule.basisPoints },
    );
  }
  if (rule.basisPoints > MAX_FEE_BASIS_POINTS) {
    throw new ConfigurationError(
      `A fee rate is capped at ${MAX_FEE_BASIS_POINTS} basis points`,
      { basisPoints: rule.basisPoints, limit: MAX_FEE_BASIS_POINTS },
    );
  }
  assertWholeAmount(rule.minimum);
  if (rule.minimum < 0) {
    throw new ConfigurationError("A minimum fee cannot be negative", {
      minimum: rule.minimum,
    });
  }
  if (rule.maximum !== null) {
    assertWholeAmount(rule.maximum);
    if (rule.maximum < 0) {
      throw new ConfigurationError("A maximum fee cannot be negative", {
        maximum: rule.maximum,
      });
    }
    if (rule.maximum < rule.minimum) {
      throw new ConfigurationError("The maximum fee is below the minimum", {
        minimum: rule.minimum,
        maximum: rule.maximum,
      });
    }
  }

  if (rule.tiers.length > 0) {
    if ((rule.tiers[0] as FeeTier).threshold !== 0) {
      throw new ConfigurationError(
        "The first tier must start at zero, or amounts below it are charged nothing by accident",
        { firstThreshold: (rule.tiers[0] as FeeTier).threshold },
      );
    }
    for (let index = 1; index < rule.tiers.length; index += 1) {
      const previous = rule.tiers[index - 1] as FeeTier;
      const current = rule.tiers[index] as FeeTier;
      if (current.threshold <= previous.threshold) {
        throw new ConfigurationError("Tiers must ascend", {
          previous: previous.threshold,
          current: current.threshold,
        });
      }
    }
  }

  return rule;
}

/**
 * What `rule` charges on `amount`. Books nothing.
 *
 * The number to show a member before they confirm. Computed the same way
 * {@link chargeFee} computes it, because it is the same function — a quote that
 * could differ from the charge would be worse than no quote.
 *
 * ```ts
 * const rule = createFeeRule("transfer", { basisPoints: 250, minimum: 1 });
 * quoteFee(rule, 1000);  // fee 25, payerPays 1025, recipientReceives 1000
 * ```
 */
export function quoteFee(rule: FeeRule, amount: number): FeeQuote {
  assertWholeAmount(amount);
  if (amount < 0) {
    throw new ValidationError("A fee cannot be quoted on a negative amount", { amount });
  }

  let fee = rule.flat;
  if (rule.basisPoints) {
    fee += applyBasisPoints(amount, rule.basisPoints, rule.rounding);
  }
  if (rule.tiers.length > 0) {
    fee += tiered(amount, rule);
  }

  fee = Math.max(fee, rule.minimum);
  if (rule.maximum !== null) {
    fee = Math.min(fee, rule.maximum);
  }

  let payerPays: number;
  let recipientReceives: number;
  if (rule.mode === FeeMode.OnTop) {
    payerPays = amount + fee;
    recipientReceives = amount;
  } else {
    // An inclusive fee can never take more than the amount: a payment of 10 with
    // a flat fee of 50 leaves the recipient nothing, not minus forty.
    fee = Math.min(fee, amount);
    payerPays = amount;
    recipientReceives = amount - fee;
  }

  assertWholeAmount(payerPays);
  return {
    ruleKey: rule.key,
    mode: rule.mode,
    amount,
    fee,
    payerPays,
    recipientReceives,
  };
}

/** The tiered part of a fee: each band charged on the slice inside it. */
function tiered(amount: number, rule: FeeRule): number {
  let total = 0;
  for (let index = 0; index < rule.tiers.length; index += 1) {
    const tier = rule.tiers[index] as FeeTier;
    const upper =
      index + 1 < rule.tiers.length ? (rule.tiers[index + 1] as FeeTier).threshold : null;
    if (amount <= tier.threshold) break;
    const top = upper === null ? amount : Math.min(amount, upper);
    total += applyBasisPoints(top - tier.threshold, tier.basisPoints, rule.rounding);
  }
  return total;
}

/**
 * Book a fee to the scope's fee account.
 *
 * `null` comes back when the fee was zero, which is an ordinary outcome for a
 * rule with a threshold and not worth an exception.
 *
 * This books *only the fee*. The payment it was charged on is the caller's own
 * booking, and the two belong in the same database transaction — a fee that was
 * collected for a transfer that never happened is money taken for nothing.
 */
export function chargeFee(
  engine: EconomyEngine,
  payer: Account,
  quote: FeeQuote,
  options: {
    now: number;
    operationId: string;
    reason: string;
    feeAccount?: Account;
    metadata?: Record<string, string>;
  },
): BookingResult | null {
  if (quote.fee === 0) return null;
  return engine.transfer(
    payer,
    options.feeAccount ??
      emptyAccount(systemAccount(payer.ref.scope, payer.ref.currency, SystemAccount.Fee)),
    quote.fee,
    {
      now: options.now,
      operationId: options.operationId,
      reason: options.reason,
      kind: PostingKind.Fee,
      metadata: options.metadata,
    },
  );
}

/**
 * Divide a collected fee between several recipients, exactly.
 *
 * For a community that shares a market commission between the platform, the
 * seller's guild and a charity pot. The shares add up to the fee, always — see
 * {@link distribute} for why that is not automatic.
 */
export function splitFee(fee: number, weights: readonly number[]): number[] {
  return distribute(fee, weights);
}

/**
 * What a list of quotes charges in total.
 *
 * For a basket, or for a caller applying several rules to one transaction — a
 * platform fee and a sales tax, say. The rules are applied independently to the
 * same amount rather than to each other's output, which is the conventional
 * reading and the one that does not depend on their order.
 */
export function totalOf(quotes: readonly FeeQuote[]): number {
  return quotes.reduce((sum, quote) => sum + quote.fee, 0);
}
