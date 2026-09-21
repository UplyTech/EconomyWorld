import { describe, expect, it } from "vitest";
import {
  account,
  accountKey,
  chargeFee,
  ConfigurationError,
  createCurrency,
  createFeeRule,
  createTier,
  EconomyEngine,
  FeeMode,
  isFree,
  MAX_FEE_BASIS_POINTS,
  memberAccount,
  PostingKind,
  quoteFee,
  Rounding,
  splitFee,
  SystemAccount,
  systemAccount,
  totalOf,
  ValidationError,
} from "../src/index.js";

/** The mirror of `python/tests/test_tax.py`. */

const NOW = 1_700_000_000_000;

function engine(): EconomyEngine {
  return new EconomyEngine({ currencies: [createCurrency({ code: "COIN" })] });
}

function ref(name = "ada") {
  return memberAccount("g1", name, "COIN");
}

describe("building a rule", () => {
  it("needs a key", () => {
    expect(() => createFeeRule("", { basisPoints: 100 })).toThrow(ConfigurationError);
  });

  it("refuses a negative charge", () => {
    for (const options of [{ flat: -1 }, { basisPoints: -1 }, { minimum: -1 }, { maximum: -1 }]) {
      expect(() => createFeeRule("k", options)).toThrow();
    }
  });

  it("refuses a maximum below the minimum", () => {
    // Otherwise the two clamps contradict each other and the answer depends on
    // which one the implementation happens to apply last.
    expect(() => createFeeRule("k", { basisPoints: 100, minimum: 500, maximum: 100 })).toThrow(
      ConfigurationError,
    );
  });

  it("allows a rate above a hundred per cent but not a typo", () => {
    // A penalty surcharge really can exceed what it is charged on, so 150 % is
    // a policy. A million basis points is a slipped decimal point.
    expect(quoteFee(createFeeRule("k", { basisPoints: 15_000 }), 100).fee).toBe(150);
    expect(() => createFeeRule("k", { basisPoints: MAX_FEE_BASIS_POINTS + 1 })).toThrow(
      ConfigurationError,
    );
  });

  it("makes tiers start at zero", () => {
    // A first tier at 100 would charge nothing at all on amounts below 100,
    // silently, which is a configuration bug rather than a design.
    expect(() => createFeeRule("k", { tiers: [createTier(100, 250)] })).toThrow(
      ConfigurationError,
    );
  });

  it("makes tiers ascend, in the order they were given", () => {
    // Sorting them silently would hide a caller who wrote the bands out of
    // order and therefore probably wrote the rates against the wrong ones.
    expect(() =>
      createFeeRule("k", { tiers: [createTier(0, 250), createTier(0, 100)] }),
    ).toThrow(ConfigurationError);
    expect(() =>
      createFeeRule("k", { tiers: [createTier(1000, 100), createTier(0, 250)] }),
    ).toThrow(ConfigurationError);
    const rule = createFeeRule("k", { tiers: [createTier(0, 250), createTier(1000, 100)] });
    expect(rule.tiers.map((tier) => tier.threshold)).toEqual([0, 1000]);
  });

  it("refuses an impossible tier", () => {
    expect(() => createTier(0, MAX_FEE_BASIS_POINTS + 1)).toThrow(ConfigurationError);
    expect(() => createTier(-1, 100)).toThrow();
    for (const value of [1.5, Number.NaN]) {
      expect(() => createTier(0, value)).toThrow(ConfigurationError);
    }
  });
});

describe("quoting", () => {
  it("matches the documented example", () => {
    const quote = quoteFee(createFeeRule("transfer", { basisPoints: 250, minimum: 1 }), 1_000);
    expect([quote.fee, quote.payerPays, quote.recipientReceives]).toEqual([25, 1025, 1000]);
  });

  it("adds on top or deducts inside", () => {
    // The same 2.5 per cent, charged the two ways a shop can charge it.
    const onTop = createFeeRule("a", { basisPoints: 250 });
    const inclusive = createFeeRule("b", { mode: FeeMode.Inclusive, basisPoints: 250 });
    expect(quoteFee(onTop, 1_000).payerPays).toBe(1_025);
    expect(quoteFee(onTop, 1_000).recipientReceives).toBe(1_000);
    expect(quoteFee(inclusive, 1_000).payerPays).toBe(1_000);
    expect(quoteFee(inclusive, 1_000).recipientReceives).toBe(975);
  });

  it("never lets an inclusive fee exceed the amount", () => {
    // A flat 50 on a payment of 10 leaves the recipient nothing. It must not
    // leave them minus forty.
    const quote = quoteFee(createFeeRule("b", { mode: FeeMode.Inclusive, flat: 50 }), 10);
    expect(quote.fee).toBe(10);
    expect(quote.recipientReceives).toBe(0);
    expect(quote.payerPays).toBe(10);
  });

  it("adds a flat charge to a rate", () => {
    expect(quoteFee(createFeeRule("k", { flat: 5, basisPoints: 100 }), 1_000).fee).toBe(15);
  });

  it("lifts a small fee to the minimum and caps a large one", () => {
    const floored = createFeeRule("k", { basisPoints: 100, minimum: 10 });
    expect(quoteFee(floored, 100).fee).toBe(10); // one per cent of 100 is 1
    expect(quoteFee(floored, 100_000).fee).toBe(1_000);
    expect(quoteFee(createFeeRule("k", { basisPoints: 100, maximum: 500 }), 1_000_000).fee).toBe(
      500,
    );
  });

  it("applies the minimum to a zero amount too", () => {
    // Deliberate: a rule with a floor charges the floor. A caller who wants
    // free-below-a-threshold writes a tier, not a minimum.
    expect(quoteFee(createFeeRule("k", { basisPoints: 100, minimum: 10 }), 0).fee).toBe(10);
  });

  it("rounds the way the rule says", () => {
    expect(quoteFee(createFeeRule("k", { basisPoints: 1 }), 100).fee).toBe(0);
    expect(quoteFee(createFeeRule("k", { basisPoints: 1, rounding: Rounding.Up }), 100).fee).toBe(
      1,
    );
  });

  it("refuses a negative amount", () => {
    expect(() => quoteFee(createFeeRule("k", { flat: 1 }), -1)).toThrow(ValidationError);
  });

  it("quotes nothing for a rule that charges nothing", () => {
    const quote = quoteFee(createFeeRule("free"), 1_000);
    expect(quote.fee).toBe(0);
    expect(isFree(quote)).toBe(true);
    expect(quote.payerPays).toBe(1_000);
    expect(quote.recipientReceives).toBe(1_000);
  });
});

describe("tiers", () => {
  const rule = createFeeRule("market", {
    // Nothing on the first 1,000; one per cent to 10,000; 2.5 beyond.
    tiers: [createTier(0, 0), createTier(1_000, 100), createTier(10_000, 250)],
  });

  it("charges each band on its own slice", () => {
    expect(quoteFee(rule, 1_000).fee).toBe(0);
    expect(quoteFee(rule, 2_000).fee).toBe(10);
    expect(quoteFee(rule, 10_000).fee).toBe(90);
    expect(quoteFee(rule, 20_000).fee).toBe(90 + 250);
  });

  it("never lets the fee fall as the amount rises", () => {
    let previous = 0;
    for (let amount = 0; amount < 30_000; amount += 137) {
      const fee = quoteFee(rule, amount).fee;
      expect(fee).toBeGreaterThanOrEqual(previous);
      previous = fee;
    }
  });

  it("never takes more than the slice", () => {
    for (const amount of [1, 999, 1_000, 1_001, 9_999, 10_001, 999_999]) {
      expect(quoteFee(rule, amount).fee).toBeLessThanOrEqual(amount);
    }
  });

  it("stacks with a flat charge", () => {
    expect(quoteFee(createFeeRule("k", { flat: 7, tiers: [createTier(0, 100)] }), 1_000).fee).toBe(
      17,
    );
  });
});

describe("charging", () => {
  it("books the fee to the scope's fee account", () => {
    const payer = account(ref(), 10_000);
    const quote = quoteFee(createFeeRule("k", { basisPoints: 250 }), 1_000);
    const booking = chargeFee(engine(), payer, quote, {
      now: NOW,
      operationId: "f1",
      reason: "commission",
    });
    expect(booking).not.toBeNull();
    expect(booking!.posting.kind).toBe(PostingKind.Fee);
    expect(booking!.balances[accountKey(systemAccount("g1", "COIN", SystemAccount.Fee))]).toBe(25);
    expect(booking!.balances[accountKey(ref())]).toBe(9_975);
  });

  it("books nothing for a zero fee rather than throwing", () => {
    const quote = quoteFee(createFeeRule("k", { tiers: [createTier(0, 0)] }), 1_000);
    expect(
      chargeFee(engine(), account(ref(), 10_000), quote, {
        now: NOW,
        operationId: "f1",
        reason: "commission",
      }),
    ).toBeNull();
  });

  it("charges exactly what it quoted", () => {
    // The promise that makes a quote worth showing to a member.
    const rule = createFeeRule("k", {
      flat: 3,
      basisPoints: 175,
      minimum: 10,
      maximum: 900,
    });
    for (const amount of [0, 1, 99, 1_000, 55_555, 1_000_000]) {
      const quote = quoteFee(rule, amount);
      const booking = chargeFee(engine(), account(ref(), 5_000_000), quote, {
        now: NOW,
        operationId: `f${amount}`,
        reason: "x",
      });
      expect(booking === null ? 0 : booking.posting.amount).toBe(quote.fee);
    }
  });

  it("can send the fee somewhere else", () => {
    // A guild that keeps its own commission rather than the scope's.
    const pot = account(memberAccount("g1", "guild-pot", "COIN"), 0);
    const quote = quoteFee(createFeeRule("k", { flat: 100 }), 1_000);
    const booking = chargeFee(engine(), account(ref(), 10_000), quote, {
      now: NOW,
      operationId: "f1",
      reason: "x",
      feeAccount: pot,
    });
    expect(booking!.balances[accountKey(pot.ref)]).toBe(100);
  });
});

describe("splitting and totalling", () => {
  it("adds the shares up to the fee", () => {
    for (const fee of [0, 1, 2, 7, 100, 9_999]) {
      for (const weights of [[1, 1, 1], [70, 20, 10], [1, 0], [5]]) {
        const shares = splitFee(fee, weights);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(fee);
        expect(shares).toHaveLength(weights.length);
      }
    }
  });

  it("gives a zero weight nothing", () => {
    expect(splitFee(100, [1, 0, 1])).toEqual([50, 0, 50]);
  });

  it("keeps a remainder inside the total", () => {
    expect(splitFee(10, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(10);
  });

  it("charges several rules on the amount rather than on each other", () => {
    // Order-independence, which is the whole reason for this helper.
    const platform = createFeeRule("platform", { basisPoints: 250 });
    const tax = createFeeRule("tax", { basisPoints: 1900 });
    const forwards = totalOf([quoteFee(platform, 10_000), quoteFee(tax, 10_000)]);
    const backwards = totalOf([quoteFee(tax, 10_000), quoteFee(platform, 10_000)]);
    expect(forwards).toBe(backwards);
    expect(forwards).toBe(250 + 1_900);
  });

  it("totals no quotes as nothing", () => {
    expect(totalOf([])).toBe(0);
  });
});
