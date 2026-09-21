import { describe, expect, it } from "vitest";
import {
  account,
  accountKey,
  averageCost,
  buyUnits,
  ConfigurationError,
  couponDue,
  createCurrency,
  createInstrument,
  CurrencyMismatchError,
  distributeDividend,
  EconomyEngine,
  InstrumentError,
  InstrumentKind,
  InsufficientFundsError,
  memberAccount,
  openPosition,
  payCoupon,
  PostingKind,
  sellUnits,
  SystemAccount,
  systemAccount,
  unrealisedGain,
  ValidationError,
  valuePortfolio,
  valuePosition,
  type Position,
} from "../src/index.js";

/** The mirror of `python/tests/test_instruments.py`. */

const NOW = 1_700_000_000_000;
const MAX_UNITS = 1_000_000_000;

function engine(): EconomyEngine {
  return new EconomyEngine({ currencies: [createCurrency({ code: "COIN" })] });
}

function ref(name = "ada", currency = "COIN") {
  return memberAccount("g1", name, currency);
}

function share() {
  return createInstrument("guild-share", InstrumentKind.Share, "COIN", { name: "Guild share" });
}

function bond() {
  // 5 % of a face value of 1,000: fifty a period, per unit, forever knowable.
  return createInstrument("guild-bond", InstrumentKind.Bond, "COIN", {
    faceValue: 1_000,
    couponBasisPoints: 500,
  });
}

function position(units: number, costBasis: number, instrumentId = "guild-share"): Position {
  return { holder: ref(), instrumentId, units, costBasis, realisedGain: 0 };
}

describe("building an instrument", () => {
  it("defaults the name to the id", () => {
    expect(createInstrument("x", InstrumentKind.Share, "COIN").name).toBe("x");
    expect(share().name).toBe("Guild share");
  });

  it("refuses an empty id or currency", () => {
    expect(() => createInstrument("", InstrumentKind.Share, "COIN")).toThrow(ConfigurationError);
    expect(() => createInstrument("x", InstrumentKind.Share, "")).toThrow(ConfigurationError);
  });

  it("gives a coupon to bonds only", () => {
    // The line that keeps this module free of a price model. A share with a
    // built-in coupon would pay out on its own, and the next question would be
    // how much -- which is a market model, which this package does not have.
    expect(() =>
      createInstrument("x", InstrumentKind.Share, "COIN", { couponBasisPoints: 500 }),
    ).toThrow(ConfigurationError);
    expect(() => createInstrument("x", InstrumentKind.Fund, "COIN", { faceValue: 100 })).toThrow(
      ConfigurationError,
    );
  });

  it("needs a face value on a bond", () => {
    expect(() => createInstrument("x", InstrumentKind.Bond, "COIN")).toThrow(ConfigurationError);
  });

  it("refuses a negative face value or coupon", () => {
    expect(() => createInstrument("x", InstrumentKind.Bond, "COIN", { faceValue: -1 })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      createInstrument("x", InstrumentKind.Bond, "COIN", {
        faceValue: 100,
        couponBasisPoints: -1,
      }),
    ).toThrow(ConfigurationError);
  });

  it("matches the position currency to the instrument", () => {
    expect(() => openPosition(ref("ada", "GEM"), share())).toThrow(CurrencyMismatchError);
  });

  it("opens an empty position holding nothing", () => {
    const opened = openPosition(ref(), share());
    expect([opened.units, opened.costBasis, opened.realisedGain]).toEqual([0, 0, 0]);
    expect(averageCost(opened)).toBe(0);
  });
});

describe("buying", () => {
  it("sends the currency to the market account", () => {
    const outcome = buyUnits(engine(), share(), openPosition(ref(), share()), account(ref(), 10_000), 10, 250, {
      now: NOW,
      operationId: "b1",
      reason: "buy",
    });
    expect(outcome.consideration).toBe(2_500);
    expect(outcome.position.units).toBe(10);
    expect(outcome.position.costBasis).toBe(2_500);
    expect(outcome.booking!.posting.kind).toBe(PostingKind.Exchange);
    expect(
      outcome.booking!.balances[accountKey(systemAccount("g1", "COIN", SystemAccount.Market))],
    ).toBe(2_500);
    expect(outcome.booking!.balances[accountKey(ref())]).toBe(7_500);
  });

  it("will not let a buyer spend money they do not have", () => {
    // Buying from the market is still buying, not borrowing. The market account
    // may go negative when it pays a seller -- it issues. That must never be
    // read as permission for the buyer's own balance to.
    expect(() =>
      buyUnits(engine(), share(), openPosition(ref(), share()), account(ref(), 100), 10, 250, {
        now: NOW,
        operationId: "b1",
        reason: "buy",
      }),
    ).toThrow(InsufficientFundsError);
  });

  it("pays the seller in a peer-to-peer purchase", () => {
    const seller = account(ref("bob"), 0);
    const outcome = buyUnits(
      engine(),
      share(),
      openPosition(ref(), share()),
      account(ref(), 10_000),
      4,
      100,
      { now: NOW, operationId: "b1", reason: "buy", counterparty: seller },
    );
    expect(outcome.booking!.balances[accountKey(seller.ref)]).toBe(400);
  });

  it("averages the cost over two purchases", () => {
    const economy = engine();
    const instrument = share();
    let held = buyUnits(economy, instrument, openPosition(ref(), instrument), account(ref(), 100_000), 10, 100, {
      now: NOW,
      operationId: "b1",
      reason: "x",
    }).position;
    held = buyUnits(economy, instrument, held, account(ref(), 99_000), 10, 300, {
      now: NOW,
      operationId: "b2",
      reason: "x",
    }).position;
    expect(held.units).toBe(20);
    expect(held.costBasis).toBe(4_000);
    expect(averageCost(held)).toBe(200);
  });

  it("grants units at a price of zero without booking anything", () => {
    // A founding member's share. Zero is a price, not a missing one -- and a
    // zero-amount posting is not a thing this ledger will write.
    const outcome = buyUnits(engine(), share(), openPosition(ref(), share()), account(ref(), 0), 5, 0, {
      now: NOW,
      operationId: "b1",
      reason: "grant",
    });
    expect(outcome.consideration).toBe(0);
    expect(outcome.booking).toBeNull();
    expect(outcome.position.units).toBe(5);
  });

  it("refuses zero units, a negative price and a wrong holder", () => {
    const buyer = account(ref(), 10_000);
    const instrument = share();
    expect(() =>
      buyUnits(engine(), instrument, openPosition(ref(), instrument), buyer, 0, 100, {
        now: NOW,
        operationId: "b",
        reason: "x",
      }),
    ).toThrow(ValidationError);
    expect(() =>
      buyUnits(engine(), instrument, openPosition(ref(), instrument), buyer, 1, -1, {
        now: NOW,
        operationId: "b",
        reason: "x",
      }),
    ).toThrow(ValidationError);
    expect(() =>
      buyUnits(engine(), instrument, openPosition(ref("bob"), instrument), buyer, 1, 100, {
        now: NOW,
        operationId: "b",
        reason: "x",
      }),
    ).toThrow(InstrumentError);
  });

  it("refuses to pass the unit ceiling", () => {
    const instrument = share();
    expect(() =>
      buyUnits(
        engine(),
        instrument,
        openPosition(ref(), instrument),
        account(ref(), 1_000_000),
        MAX_UNITS + 1,
        0,
        { now: NOW, operationId: "b", reason: "x" },
      ),
    ).toThrow(InstrumentError);
  });
});

describe("selling", () => {
  function bought(economy: EconomyEngine, instrument = share(), units = 10, price = 100) {
    return buyUnits(
      economy,
      instrument,
      openPosition(ref(), instrument),
      account(ref(), 1_000_000),
      units,
      price,
      { now: NOW, operationId: "b", reason: "x" },
    ).position;
  }

  it("has the market pay the seller", () => {
    const economy = engine();
    const outcome = sellUnits(economy, share(), bought(economy), account(ref(), 0), 10, 150, {
      now: NOW,
      operationId: "s1",
      reason: "sell",
    });
    expect(outcome.consideration).toBe(1_500);
    expect(outcome.booking!.balances[accountKey(ref())]).toBe(1_500);
    expect(
      outcome.booking!.balances[accountKey(systemAccount("g1", "COIN", SystemAccount.Market))],
    ).toBe(-1_500);
  });

  it("clears the cost basis exactly on a full sale", () => {
    // No rounding may strand a unit of cost on an empty position.
    for (const [units, price] of [
      [3, 333],
      [7, 101],
      [99, 7],
      [1, 1],
    ]) {
      const economy = engine();
      const instrument = share();
      const outcome = sellUnits(
        economy,
        instrument,
        bought(economy, instrument, units, price),
        account(ref(), 0),
        units,
        50,
        { now: NOW, operationId: "s", reason: "x" },
      );
      expect(outcome.position.units).toBe(0);
      expect(outcome.position.costBasis).toBe(0);
    }
  });

  it("releases its share of the cost on a partial sale", () => {
    const economy = engine();
    const outcome = sellUnits(
      economy,
      share(),
      bought(economy, share(), 10, 100), // 1,000 for ten
      account(ref(), 0),
      4,
      150,
      { now: NOW, operationId: "s", reason: "x" },
    );
    expect(outcome.position.costBasis).toBe(600);
    expect(outcome.realisedGain).toBe(600 - 400); // sold for 600, cost 400
  });

  it("realises a loss as a negative gain", () => {
    const economy = engine();
    const outcome = sellUnits(
      economy,
      share(),
      bought(economy, share(), 10, 100),
      account(ref(), 0),
      10,
      40,
      { now: NOW, operationId: "s", reason: "x" },
    );
    expect(outcome.realisedGain).toBe(-600);
    expect(outcome.position.realisedGain).toBe(-600);
  });

  it("accumulates the realised gain over a round trip", () => {
    const economy = engine();
    const instrument = share();
    let held = bought(economy, instrument, 10, 100);
    held = sellUnits(economy, instrument, held, account(ref(), 0), 5, 150, {
      now: NOW,
      operationId: "s1",
      reason: "x",
    }).position;
    held = sellUnits(economy, instrument, held, account(ref(), 0), 5, 50, {
      now: NOW,
      operationId: "s2",
      reason: "x",
    }).position;
    expect(held.units).toBe(0);
    expect(held.costBasis).toBe(0);
    expect(held.realisedGain).toBe(750 + 250 - 1_000);
  });

  it("cannot sell more than is held", () => {
    const economy = engine();
    expect(() =>
      sellUnits(economy, share(), bought(economy, share(), 3, 100), account(ref(), 0), 4, 100, {
        now: NOW,
        operationId: "s",
        reason: "x",
      }),
    ).toThrow(InstrumentError);
  });

  it("needs a peer-to-peer buyer to have the money", () => {
    const economy = engine();
    expect(() =>
      sellUnits(economy, share(), bought(economy), account(ref(), 0), 10, 100, {
        now: NOW,
        operationId: "s",
        reason: "x",
        counterparty: account(ref("bob"), 10),
      }),
    ).toThrow(InsufficientFundsError);
  });
});

describe("valuation", () => {
  it("values a holding at the price the caller supplies", () => {
    expect(valuePosition(openPosition(ref(), share()), 500).marketValue).toBe(0);
    const valuation = valuePosition(position(10, 1_000), 150);
    expect(valuation.marketValue).toBe(1_500);
    expect(valuation.costBasis).toBe(1_000);
    expect(valuation.unrealisedGain).toBe(500);
  });

  it("values a holding at nothing when the price is zero", () => {
    expect(valuePosition(position(10, 1_000), 0).unrealisedGain).toBe(-1_000);
  });

  it("treats a missing price as an error rather than a zero", () => {
    // A total that quietly omits a holding is a number a member acts on.
    expect(() => valuePortfolio([position(10, 1_000)], {})).toThrow(InstrumentError);
  });

  it("totals a portfolio", () => {
    const positions = [position(10, 1_000, "a"), position(5, 500, "b")];
    expect(unrealisedGain(positions, { a: 150, b: 50 })).toBe(1_500 - 1_000 + (250 - 500));
  });

  it("values no holdings at nothing", () => {
    expect(unrealisedGain([], {})).toBe(0);
  });
});

describe("coupons", () => {
  it("is fixed by the terms", () => {
    expect(couponDue(bond(), 1)).toBe(50);
    expect(couponDue(bond(), 10)).toBe(500);
    expect(couponDue(bond(), 10, 4)).toBe(2_000);
  });

  it("owes nothing on nothing", () => {
    expect(couponDue(bond(), 0)).toBe(0);
    expect(couponDue(bond(), 10, 0)).toBe(0);
  });

  it("pays nothing when the coupon is too small to round", () => {
    const tiny = createInstrument("t", InstrumentKind.Bond, "COIN", {
      faceValue: 1,
      couponBasisPoints: 1,
    });
    expect(couponDue(tiny, 1)).toBe(0);
    expect(
      payCoupon(engine(), tiny, position(1, 1, "t"), account(ref(), 0), {
        now: NOW,
        operationId: "c",
        reason: "coupon",
      }),
    ).toBeNull();
  });

  it("is paid by bonds only", () => {
    expect(() => couponDue(share(), 10)).toThrow(InstrumentError);
  });

  it("is funded from the mint by default", () => {
    const booking = payCoupon(
      engine(),
      bond(),
      position(10, 10_000, "guild-bond"),
      account(ref(), 0),
      { now: NOW, operationId: "c", reason: "coupon" },
    );
    expect(booking!.posting.kind).toBe(PostingKind.Distribution);
    expect(booking!.balances[accountKey(systemAccount("g1", "COIN", SystemAccount.Mint))]).toBe(
      -500,
    );
    expect(booking!.balances[accountKey(ref())]).toBe(500);
  });

  it("makes a named payer hold what it pays", () => {
    // The mint issues. An issuer paying its own bondholders does not: otherwise
    // a guild treasury could pay coupons it cannot afford and the overdraft
    // would look like a bookkeeping detail rather than a default.
    const held = position(10, 10_000, "guild-bond");
    expect(() =>
      payCoupon(engine(), bond(), held, account(ref(), 0), {
        now: NOW,
        operationId: "c",
        reason: "coupon",
        source: account(memberAccount("g1", "issuer", "COIN"), 100),
      }),
    ).toThrow(InsufficientFundsError);

    const funded = account(memberAccount("g1", "issuer", "COIN"), 10_000);
    const booking = payCoupon(engine(), bond(), held, account(ref(), 0), {
      now: NOW,
      operationId: "c",
      reason: "coupon",
      source: funded,
    });
    expect(booking!.balances[accountKey(funded.ref)]).toBe(9_500);
  });

  it("refuses a negative period count", () => {
    expect(() => couponDue(bond(), 1, -1)).toThrow(ValidationError);
  });
});

describe("dividends", () => {
  function holder(name: string, units: number): Position {
    return {
      holder: memberAccount("g1", name, "COIN"),
      instrumentId: "s",
      units,
      costBasis: 0,
      realisedGain: 0,
    };
  }

  it("adds the shares up to the declared total", () => {
    const positions = [holder("a", 1), holder("b", 1), holder("c", 1)];
    for (const total of [0, 1, 2, 10, 1_000, 9_999]) {
      const payouts = distributeDividend(positions, total);
      expect(payouts.reduce((sum, payout) => sum + payout.amount, 0)).toBe(total);
    }
  });

  it("splits by units held", () => {
    const payouts = distributeDividend([holder("a", 70), holder("b", 30)], 1_000);
    expect(payouts.map((payout) => payout.amount)).toEqual([700, 300]);
  });

  it("leaves empty positions out rather than paying them nothing", () => {
    const payouts = distributeDividend([holder("a", 10), holder("b", 0)], 100);
    expect(payouts.map((payout) => payout.holder.owner)).toEqual(["a"]);
  });

  it("refuses a dividend with nobody to pay", () => {
    expect(() => distributeDividend([holder("a", 0)], 100)).toThrow(InstrumentError);
    expect(() => distributeDividend([], 100)).toThrow(InstrumentError);
  });

  it("refuses a negative dividend", () => {
    expect(() => distributeDividend([holder("a", 1)], -1)).toThrow(ValidationError);
  });
});
