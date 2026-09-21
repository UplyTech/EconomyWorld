import { describe, expect, it } from "vitest";
import {
  account,
  accountKey,
  accrueDepositInterest,
  amortisationSchedule,
  amountDue,
  applyBasisPoints,
  applyRate,
  assertWithinCreditLimit,
  AuctionStateError,
  buyUnits,
  assertBalanced,
  cancelOrder,
  cancelSubscription,
  captureHold,
  chargeLateFee,
  closeAuction,
  ConfigurationError,
  couponDue,
  createCurrency,
  createDepositTerms,
  createFeeRule,
  createInstrument,
  createItem,
  createLoanTerms,
  createOffer,
  createOrder,
  createPlan,
  createPosting,
  createTier,
  CurrencyMismatchError,
  deposit,
  DepositError,
  distribute,
  distributeEvenly,
  EconomyEngine,
  exchange,
  financePurchase,
  HoldError,
  InstrumentError,
  InstrumentKind,
  InsufficientFundsError,
  Inventory,
  InvalidAmountError,
  isInArrears,
  isSubscriptionActive,
  levelPayment,
  LoanStateError,
  MAX_FEE_BASIS_POINTS,
  memberAccount,
  MIN_BALANCE,
  nextChargeAt,
  nextInstalment,
  openAuction,
  openDeposit,
  openLoan,
  openPosition,
  OrderError,
  OrderSide,
  outstandingAfter,
  placeBid,
  PostingKind,
  placeHold,
  purchase,
  RateError,
  releaseHold,
  repay,
  ScheduleError,
  settleAuction,
  settleEarly,
  settleFill,
  settlementQuote,
  startSubscription,
  SystemAccount,
  systemAccount,
  totalOutstanding,
  UnbalancedPostingError,
  ValidationError,
  writeOff,
  type Bid,
  type Position,
} from "../src/index.js";

/**
 * The mirror of `python/tests/test_guards.py`.
 *
 * A library's refusals are part of its contract: a caller reads "throws
 * ValidationError when the id is empty" and writes code that depends on it. The
 * suites next door check the behaviour of each subsystem; this one walks the
 * guards themselves, so that no argument check is a line nobody has ever run.
 */

const NOW = 1_700_000_000_000;
const LATER = NOW + 60_000;
const NOT_A_TIMESTAMP = [1.5, Number.NaN, Number.POSITIVE_INFINITY];

function engine(): EconomyEngine {
  return new EconomyEngine({ currencies: [createCurrency({ code: "COIN" })] });
}

function ref(name = "ada", currency = "COIN") {
  return memberAccount("g1", name, currency);
}

function loanOf(economy: EconomyEngine, overrides = {}) {
  return openLoan(
    economy,
    "L",
    createLoanTerms({ principal: 1_000, rateBasisPoints: 100, periods: 4, ...overrides }),
    account(ref(), 0),
    { now: NOW, operationId: "o", reason: "x" },
  ).loan;
}

describe("currency and amount guards", () => {
  it("needs whole numbers for a currency's shape", () => {
    expect(() => createCurrency({ code: "COIN", minorUnits: 1.5 })).toThrow(ConfigurationError);
    expect(() => createCurrency({ code: "COIN", maxBalance: 1.5 })).toThrow(ConfigurationError);
  });

  it("needs two whole numbers for a rate", () => {
    expect(() => applyRate(100, 1.5, 2)).toThrow(InvalidAmountError);
    expect(() => applyRate(100, 1, 2.5)).toThrow(InvalidAmountError);
    expect(() => applyRate(100, 1, 0)).toThrow(InvalidAmountError);
  });

  it("needs a whole number for a weight", () => {
    expect(() => distribute(100, [1, 1.5])).toThrow(ValidationError);
    expect(() => distribute(100, [1, -1])).toThrow(ValidationError);
  });

  it("needs a whole number of basis points", () => {
    expect(() => applyBasisPoints(1_000, 1.5)).toThrow(InvalidAmountError);
  });
});

describe("interest guards", () => {
  it("needs a whole number of periods", () => {
    expect(() => levelPayment(1_000, 100, 1.5)).toThrow(RateError);
    expect(() => amortisationSchedule(1_000, 1.5, 4)).toThrow(RateError);
  });

  it("pays nothing on nothing", () => {
    expect(levelPayment(0, 500, 12)).toBe(0);
  });

  it("needs a whole number of paid instalments", () => {
    const schedule = amortisationSchedule(1_000, 0, 4);
    for (const value of [1.5, Number.NaN]) {
      expect(() => outstandingAfter(schedule, value)).toThrow(ValidationError);
    }
  });
});

describe("bank guards", () => {
  it("needs an id for a deposit", () => {
    expect(() => openDeposit("", ref(), createDepositTerms(), NOW)).toThrow(ValidationError);
  });

  it("belongs to one account, and so to one currency", () => {
    // An AccountRef carries its currency, so comparing refs compares the
    // currency too -- there is no second check, because there would be nothing
    // left for it to catch.
    const opened = openDeposit("d", ref(), createDepositTerms(), NOW);
    for (const wrong of [ref("eve"), ref("ada", "GEM")]) {
      expect(() =>
        deposit(engine(), opened, account(wrong, 1_000), 100, {
          now: NOW,
          operationId: "d1",
          reason: "x",
        }),
      ).toThrow(DepositError);
    }
  });

  it("accrues over whole periods", () => {
    const opened = openDeposit("d", ref(), createDepositTerms({ rateBasisPoints: 100 }), NOW);
    for (const periods of [-1, 1.5]) {
      expect(() =>
        accrueDepositInterest(engine(), opened, periods, {
          now: NOW,
          operationId: "a",
          reason: "x",
        }),
      ).toThrow(ValidationError);
    }
  });

  it("needs an id and an amount for a hold", () => {
    expect(() => placeHold("", account(ref(), 1_000), 100, { now: NOW, reason: "bid" })).toThrow(
      ValidationError,
    );
    expect(() => placeHold("h", account(ref(), 1_000), 0, { now: NOW, reason: "bid" })).toThrow(
      InvalidAmountError,
    );
  });

  it("releases only a hold that is there", () => {
    const hold = placeHold("h1", account(ref(), 1_000), 100, { now: NOW, reason: "bid" });
    expect(() => releaseHold([hold], "nope")).toThrow(HoldError);
    expect(releaseHold([hold], "h1")).toEqual([]);
  });

  it("captures no more than was reserved", () => {
    const held = account(ref(), 1_000);
    const hold = placeHold("h1", held, 100, { now: NOW, reason: "bid" });
    expect(() =>
      captureHold(engine(), hold, held, account(ref("shop"), 0), {
        now: NOW,
        operationId: "c",
        reason: "x",
        amount: 101,
      }),
    ).toThrow(HoldError);
  });

  it("needs a whole number of milliseconds for a timestamp", () => {
    for (const value of NOT_A_TIMESTAMP) {
      expect(() => openDeposit("d", ref(), createDepositTerms(), value)).toThrow(ValidationError);
    }
  });
});

describe("credit guards", () => {
  it("validates terms before a loan exists", () => {
    for (const overrides of [
      { lateFeeBasisPoints: -1 },
      { lateFeeBasisPoints: 1.5 },
      { gracePeriods: -1 },
      { gracePeriods: 1.5 },
    ]) {
      expect(() =>
        createLoanTerms({ principal: 1_000, rateBasisPoints: 0, periods: 2, ...overrides }),
      ).toThrow(ValidationError);
    }
  });

  it("needs a non-negative whole credit limit", () => {
    const terms = createLoanTerms({ principal: 1_000, rateBasisPoints: 0, periods: 2 });
    expect(() => assertWithinCreditLimit(terms, 0, -1)).toThrow(ValidationError);
  });

  it("needs an id for a loan", () => {
    const terms = createLoanTerms({ principal: 1_000, rateBasisPoints: 0, periods: 2 });
    expect(() =>
      openLoan(engine(), "", terms, account(ref(), 0), {
        now: NOW,
        operationId: "o",
        reason: "x",
      }),
    ).toThrow(ValidationError);
  });

  it("needs a whole number of instalments for an amount due", () => {
    const loan = loanOf(engine());
    for (const value of [0, -1, 1.5]) {
      expect(() => amountDue(loan, value)).toThrow(ValidationError);
    }
  });

  it("keeps a rebate inside nought to a hundred per cent", () => {
    const economy = engine();
    const loan = loanOf(economy);
    for (const value of [-1, 10_001, 1.5]) {
      expect(() =>
        settleEarly(economy, loan, account(ref(), 10_000), {
          now: NOW,
          operationId: "s",
          reason: "x",
          rebateBasisPoints: value,
        }),
      ).toThrow(ValidationError);
    }
  });

  it("takes no further action on a closed loan", () => {
    const economy = engine();
    const settled = settleEarly(economy, loanOf(economy, { periods: 1, rateBasisPoints: 0 }), account(ref(), 10_000), {
      now: NOW,
      operationId: "s",
      reason: "x",
    }).loan;

    expect(() =>
      repay(economy, settled, account(ref(), 10_000), 100, {
        now: NOW,
        operationId: "r",
        reason: "x",
      }),
    ).toThrow(LoanStateError);
    expect(() => chargeLateFee(settled, 1)).toThrow(LoanStateError);
    expect(() =>
      settleEarly(economy, settled, account(ref(), 10_000), {
        now: NOW,
        operationId: "s2",
        reason: "x",
      }),
    ).toThrow(LoanStateError);
    // These answer rather than throw: a closed loan owes nothing and is behind
    // on nothing.
    expect(settlementQuote(settled, 1)).toBe(0);
    expect(isInArrears(settled, 99)).toBe(false);
    expect(nextInstalment(settled)).toBeNull();
  });

  it("needs a whole number of missed instalments for a late fee", () => {
    const loan = loanOf(engine());
    for (const value of [0, -1, 1.5]) {
      expect(() => chargeLateFee(loan, value)).toThrow(ValidationError);
    }
  });

  it("changes nothing when a late fee lands past the last instalment", () => {
    const loan = loanOf(engine(), { periods: 2 });
    const pastTheEnd = { ...loan, paidInstalments: 2 };
    expect(chargeLateFee(pastTheEnd, 1)).toBe(pastTheEnd);
  });

  it("takes a repayment only from the borrower", () => {
    // One check, because a ref carries the currency it is denominated in.
    const economy = engine();
    const loan = loanOf(economy);
    for (const wrong of [ref("eve"), ref("ada", "GEM")]) {
      expect(() =>
        repay(economy, loan, account(wrong, 10_000), 100, {
          now: NOW,
          operationId: "r",
          reason: "x",
        }),
      ).toThrow(LoanStateError);
    }
  });

  it("writes nothing off when there is no capital left to lose", () => {
    const economy = engine();
    const loan = loanOf(economy);
    const clear = { ...loan, principalOutstanding: 0, interestOutstanding: 5 };
    const { booking, loan: written } = writeOff(economy, clear, {
      now: NOW,
      operationId: "w",
      reason: "x",
    });
    expect(booking).toBeNull();
    expect(totalOutstanding(written)).toBe(0);
  });
});

describe("instrument guards", () => {
  it("needs whole units", () => {
    const share = createInstrument("s", InstrumentKind.Share, "COIN");
    for (const units of [1.5, Number.NaN]) {
      expect(() =>
        buyUnits(engine(), share, openPosition(ref(), share), account(ref(), 10_000), units, 100, {
          now: NOW,
          operationId: "b",
          reason: "x",
        }),
      ).toThrow(ValidationError);
    }
  });

  it("keeps a position to one holder and one instrument", () => {
    const share = createInstrument("s", InstrumentKind.Share, "COIN");
    const other = createInstrument("other", InstrumentKind.Share, "COIN");
    expect(() =>
      buyUnits(engine(), other, openPosition(ref(), share), account(ref(), 10_000), 1, 100, {
        now: NOW,
        operationId: "b",
        reason: "x",
      }),
    ).toThrow(InstrumentError);
  });

  it("refuses a position in another currency", () => {
    // openPosition will not make one, but a Position is a plain record a caller
    // rebuilds from their own database -- and a portfolio that mixes currencies
    // is a portfolio whose total means nothing.
    const share = createInstrument("s", InstrumentKind.Share, "COIN");
    const holder = ref("ada", "GEM");
    const mismatched: Position = {
      holder,
      instrumentId: "s",
      units: 0,
      costBasis: 0,
      realisedGain: 0,
    };
    expect(() =>
      buyUnits(engine(), share, mismatched, account(holder, 10_000), 1, 100, {
        now: NOW,
        operationId: "b",
        reason: "x",
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it("refuses to take a position past the unit ceiling", () => {
    const share = createInstrument("s", InstrumentKind.Share, "COIN");
    const full: Position = {
      holder: ref(),
      instrumentId: "s",
      units: 1_000_000_000,
      costBasis: 0,
      realisedGain: 0,
    };
    expect(() =>
      buyUnits(engine(), share, full, account(ref(), 10_000), 1, 0, {
        now: NOW,
        operationId: "b",
        reason: "x",
      }),
    ).toThrow(InstrumentError);
  });

  it("refuses a negative period count on a coupon", () => {
    const bond = createInstrument("b", InstrumentKind.Bond, "COIN", {
      faceValue: 1_000,
      couponBasisPoints: 500,
    });
    expect(() => couponDue(bond, 1, -1)).toThrow(ValidationError);
  });
});

describe("market guards", () => {
  it("needs an instrument for an order", () => {
    expect(() => createOrder("o", ref(), "", OrderSide.Buy, 100, 1, NOW)).toThrow(OrderError);
  });

  it("cancels an order once", () => {
    const book = [createOrder("o", ref(), "ore", OrderSide.Buy, 100, 1, NOW)];
    const { cancelled } = cancelOrder(book, "o");
    expect(() => cancelOrder([cancelled], "o")).toThrow(OrderError);
  });

  it("refuses an exchange across scopes", () => {
    expect(() =>
      exchange(
        engine(),
        account(memberAccount("g1", "ada", "COIN"), 1_000),
        account(memberAccount("g2", "ada", "GEM"), 0),
        100,
        1,
        1,
        { now: NOW, operationId: "x", reason: "swap" },
      ),
    ).toThrow(ValidationError);
  });

  it("takes no more bids on a closed auction", () => {
    const auction = openAuction({
      auctionId: "a",
      seller: ref("s"),
      subject: "sword",
      currency: "COIN",
      reserve: 100,
      openedAt: NOW,
      endsAt: LATER,
    });
    const closed = closeAuction(auction, LATER).auction;
    const bid: Bid = { bidder: ref(), amount: 1_000, placedAt: NOW, bidId: "b" };
    expect(() => placeBid(closed, bid, NOW)).toThrow(AuctionStateError);
  });

  it("settles an auction once", () => {
    const economy = engine();
    const auction = placeBid(
      openAuction({
        auctionId: "a",
        seller: ref("s"),
        subject: "sword",
        currency: "COIN",
        reserve: 100,
        openedAt: NOW,
        endsAt: LATER,
      }),
      { bidder: ref(), amount: 1_000, placedAt: NOW, bidId: "b1" },
      NOW,
    );
    const outcome = closeAuction(auction, LATER);
    const { auction: settled } = settleAuction(
      economy,
      outcome,
      account(ref(), 5_000),
      account(ref("s"), 0),
      { now: LATER, operationId: "s1", reason: "x" },
    );
    expect(() =>
      settleAuction(
        economy,
        { ...outcome, auction: settled },
        account(ref(), 5_000),
        account(ref("s"), 0),
        { now: LATER, operationId: "s2", reason: "x" },
      ),
    ).toThrow(AuctionStateError);
  });

  it("names both sides of a settled fill", () => {
    const economy = engine();
    const fill = {
      buyOrderId: "b",
      sellOrderId: "s",
      buyer: ref("ada"),
      seller: ref("bob"),
      instrumentId: "ore",
      quantity: 1,
      unitPrice: 100,
      consideration: 100,
    };
    expect(() =>
      settleFill(economy, fill, account(ref("ada"), 1_000), account(ref("eve"), 0), {
        now: NOW,
        operationId: "f",
        reason: "x",
      }),
    ).toThrow(OrderError);
  });

  it("needs a whole number of milliseconds for a timestamp", () => {
    for (const value of NOT_A_TIMESTAMP) {
      expect(() =>
        openAuction({
          auctionId: "a",
          seller: ref("s"),
          subject: "sword",
          currency: "COIN",
          reserve: 100,
          openedAt: value,
          endsAt: LATER,
        }),
      ).toThrow(ValidationError);
    }
  });
});

describe("billing and fee guards", () => {
  it("needs an id for a plan and a subscription", () => {
    expect(() =>
      createPlan({
        planId: "",
        payer: ref(),
        payee: ref("guild"),
        amount: 100,
        intervalMs: 86_400_000,
      }),
    ).toThrow(ScheduleError);
    const plan = createPlan({
      planId: "p",
      payer: ref(),
      payee: ref("guild"),
      amount: 100,
      intervalMs: 86_400_000,
    });
    expect(() => startSubscription("", plan, NOW)).toThrow(ScheduleError);
  });

  it("needs a whole number of milliseconds for a financed purchase", () => {
    for (const value of NOT_A_TIMESTAMP) {
      expect(() =>
        financePurchase(engine(), {
          planId: "f",
          buyer: ref(),
          seller: account(ref("shop"), 0),
          cashPrice: 1_000,
          rateBasisPoints: 0,
          instalments: 2,
          now: value,
          operationId: "op",
          reason: "x",
        }),
      ).toThrow(ValidationError);
    }
  });

  it("needs a whole number for a tier rate", () => {
    for (const value of [1.5, Number.NaN]) {
      expect(() => createTier(0, value)).toThrow(ConfigurationError);
    }
    expect(() => createTier(0, MAX_FEE_BASIS_POINTS + 1)).toThrow(ConfigurationError);
  });

  it("needs a whole number for a flat fee", () => {
    expect(() => createFeeRule("k", { flat: 1.5 })).toThrow();
  });
});

describe("the last few branches", () => {
  it("stops an overdraft at the floor", () => {
    // An overdraft is a permission, not an unlimited one. The mint and the sink
    // go arbitrarily negative because that is what they are for; a member
    // account with allowNegative still stops at the smallest number both
    // editions can hold.
    expect(() =>
      engine().transfer(account(ref(), MIN_BALANCE + 1), account(ref("bob"), 0), 100, {
        now: NOW,
        operationId: "t",
        reason: "x",
        allowNegative: true,
      }),
    ).toThrow(InsufficientFundsError);
  });

  it("banks shop takings where the engine was told to", () => {
    const configured = new EconomyEngine({
      currencies: [createCurrency({ code: "COIN" })],
      shopAccountOwner: "system:fee",
    });
    const result = purchase(configured, {
      offer: createOffer({ offerId: "o", itemId: "potion", unitPrice: 100, currency: "COIN", stock: 10 }),
      item: createItem({ itemId: "potion", maxStack: 10 }),
      buyer: account(ref(), 1_000),
      inventory: new Inventory(),
      quantity: 1,
      now: NOW,
      operationId: "p",
      reason: "x",
    });
    expect(result.booking.balances[accountKey(systemAccount("g1", "COIN", SystemAccount.Fee))]).toBe(
      100,
    );
  });

  it("refuses an unrecognised shop owner when the engine is built", () => {
    // Where a scope's takings go is not a thing to get wrong quietly.
    // Redirecting them to the shop account anyway, or inventing an account no
    // report knows about, both hide the mistake until somebody asks where the
    // money went. The engine says so at startup instead.
    expect(
      () =>
        new EconomyEngine({
          currencies: [createCurrency({ code: "COIN" })],
          shopAccountOwner: "system:not-a-thing",
        }),
    ).toThrow(ConfigurationError);
  });

  it("says whether a subscription is still charging", () => {
    const plan = createPlan({
      planId: "p",
      payer: ref(),
      payee: ref("guild"),
      amount: 100,
      intervalMs: 86_400_000,
    });
    const subscription = startSubscription("s", plan, NOW);
    expect(isSubscriptionActive(subscription)).toBe(true);
    expect(isSubscriptionActive(cancelSubscription(subscription, NOW))).toBe(false);
  });

  it("has no next charge for a subscription stored at its last one", () => {
    // Reached by a caller reloading a subscription from their own database
    // rather than by charging one: the charge that ends a term also ends the
    // subscription, so this is the reload path.
    const plan = createPlan({
      planId: "p",
      payer: ref(),
      payee: ref("guild"),
      amount: 100,
      intervalMs: 86_400_000,
      occurrences: 3,
    });
    const stored = { ...startSubscription("s", plan, NOW), chargesMade: 3 };
    expect(nextChargeAt(stored)).toBeNull();
  });

  it("refuses weights that are all zero, and a bad part count", () => {
    expect(() => distribute(100, [0, 0])).toThrow(ValidationError);
    expect(() => distributeEvenly(100, 0)).toThrow(ValidationError);
    expect(() => distributeEvenly(100, 1.5)).toThrow(ValidationError);
    expect(distributeEvenly(10, 4)).toEqual([3, 3, 2, 2]);
  });

  it("needs a whole number for a posting line delta", () => {
    expect(() =>
      createPosting({
        operationId: "x",
        kind: PostingKind.Transfer,
        scope: "g1",
        currency: "COIN",
        amount: 100,
        reason: "x",
        occurredAt: NOW,
        lines: [
          { account: ref(), delta: 1.5, balanceBefore: 0, balanceAfter: 1.5 },
          { account: ref("bob"), delta: -1.5, balanceBefore: 0, balanceAfter: -1.5 },
        ],
      }),
    ).toThrow(ValidationError);
  });

  it("names a posting whose lines do not sum to zero", () => {
    // The rule the whole ledger rests on, checked where it is written.
    expect(() =>
      createPosting({
        operationId: "x",
        kind: PostingKind.Transfer,
        scope: "g1",
        currency: "COIN",
        amount: 100,
        reason: "x",
        occurredAt: NOW,
        lines: [
          { account: ref(), delta: -100, balanceBefore: 100, balanceAfter: 0 },
          { account: ref("bob"), delta: 90, balanceBefore: 0, balanceAfter: 90 },
        ],
      }),
    ).toThrow(UnbalancedPostingError);

    const broken = {
      operationId: "x",
      kind: PostingKind.Transfer,
      scope: "g1",
      currency: "COIN",
      amount: 100,
      reason: "x",
      occurredAt: NOW,
      lines: [{ account: ref(), delta: -100, balanceBefore: 100, balanceAfter: 0 }],
      reverses: null,
      metadata: {},
    };
    expect(() => assertBalanced(broken)).toThrow(UnbalancedPostingError);
  });
});
