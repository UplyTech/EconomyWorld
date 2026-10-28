import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import {
  accountKey,
  accrueDepositInterest,
  accrueInterest,
  amortisationSchedule,
  amountDue,
  averageCost,
  buyUnits,
  chargesDue,
  costOfCredit,
  couponDue,
  createDepositTerms,
  createFeeRule,
  createInstrument,
  createLoanTerms,
  createOrder,
  createPlan,
  createTier,
  deposit,
  depositBalance,
  distributeDividend,
  divideRounded,
  exchange,
  filledQuantity,
  financePurchase,
  giniPermille,
  InstrumentKind,
  levelPayment,
  LoanState,
  matchOrder,
  maturityValue,
  nextChargeAt,
  openDeposit,
  openLoan,
  openPosition,
  projectBalance,
  quoteFee,
  repay,
  sellUnits,
  splitFee,
  splitPayroll,
  startSubscription,
  topHolders,
  totalConsideration,
  totalPayable,
  valuePosition,
  wealthDistribution,
  acceptTrade,
  account,
  addItem,
  applyPermille,
  createCurrency,
  createEarnRule,
  createEarnState,
  createItem,
  createOffer,
  EconomyEngine,
  emptyAccount,
  Inventory,
  maxPurchasable,
  memberAccount,
  proposeTrade,
  purchase,
  removeItem,
  settleTrade,
  splitMinorUnits,
  SystemAccount,
  systemAccount,
  type AccrualBasis,
  type AmortisationMethod,
  type FeeMode,
  type OrderSide,
  type OrderState,
  type Rounding,
  type BookingResult,
  type DecayRule,
  type InventorySlot,
  type TradeSide,
} from "../src/index.js";

/**
 * The shared vectors are the contract between the Python and the TypeScript
 * edition. Both run this same set of cases; a difference in either edition
 * turns into a red build here rather than into two communities whose members
 * end up with different balances for the same activity.
 */

const vectorDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "shared",
  "testcases",
);

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(vectorDir, `${name}.json`), "utf8")) as T;
}

// The generator stamps every financial vector at this instant. The engine
// vectors carry their own `baseTimestampMs`, which the describes below read.
const T0 = 1_700_000_000_000;

const SCOPE = "guild-1";
const COIN = "COIN";
const ANA = memberAccount(SCOPE, "ana", COIN);
const BEN = memberAccount(SCOPE, "ben", COIN);
const POTION = createItem({ itemId: "potion", maxStack: 10 });
const SWORD = createItem({ itemId: "sword", stackable: false });

const engine = () =>
  new EconomyEngine({
    currencies: [createCurrency({ code: COIN, maxBalance: 1_000_000 })],
    earnRules: [
      createEarnRule({
        key: "message",
        amount: 10,
        currency: COIN,
        cooldownSeconds: 60,
        periodCapAmount: 100,
      }),
      createEarnRule({ key: "daily", amount: 250, currency: COIN, cooldownSeconds: 86400 }),
    ],
  });

const opts = (operationId: string, now: number) => ({
  now,
  operationId,
  reason: "shared vector",
});

describe("shared vectors: money", () => {
  const data = load<{
    formatVersion: number;
    splits: {
      amount: number;
      minorUnits: number;
      expected: { negative: boolean; whole: number; fraction: number };
    }[];
    permilleChains: { amount: number; permilles: number[]; expected: number }[];
  }>("money");

  it("uses a format version this edition understands", () => {
    expect(data.formatVersion).toBe(1);
  });

  it("splits minor units identically", () => {
    for (const testCase of data.splits) {
      expect(
        splitMinorUnits(
          testCase.amount,
          createCurrency({ code: "X", minorUnits: testCase.minorUnits }),
        ),
      ).toEqual(testCase.expected);
    }
  });

  it("applies permille chains identically", () => {
    for (const testCase of data.permilleChains) {
      expect(applyPermille(testCase.amount, testCase.permilles)).toBe(testCase.expected);
    }
  });
});

describe("shared vectors: bookings", () => {
  const data = load<{
    baseTimestampMs: number;
    cases: {
      id: string;
      description: string;
      expected: {
        kind: string;
        amount: number;
        lines: {
          account: string;
          delta: number;
          balanceBefore: number;
          balanceAfter: number;
        }[];
        balances: Record<string, number>;
      };
    }[];
  }>("bookings");

  const T0 = data.baseTimestampMs;

  const runners: Record<string, () => BookingResult> = {
    "credit-issues-from-the-mint": () =>
      engine().credit(emptyAccount(ANA), 500, opts("op-credit", T0)),
    "debit-removes-to-the-sink": () =>
      engine().debit(account(ANA, 500), 200, opts("op-debit", T0)),
    "transfer-between-members": () =>
      engine().transfer(account(ANA, 500), account(BEN, 20), 300, opts("op-transfer", T0)),
    "transfer-of-the-whole-balance": () =>
      engine().transfer(account(ANA, 500), account(BEN, 0), 500, opts("op-all", T0)),
    "credit-to-an-explicit-source": () =>
      engine().credit(account(ANA, 100), 200, {
        ...opts("op-refund", T0),
        source: account(systemAccount(SCOPE, COIN, SystemAccount.Shop), 1000),
      }),
  };

  for (const testCase of data.cases) {
    it(`reproduces ${testCase.id}: ${testCase.description}`, () => {
      const runner = runners[testCase.id];
      expect(runner, `no runner for ${testCase.id}`).toBeDefined();
      const result = (runner as () => BookingResult)();

      expect(result.posting.kind as string).toBe(testCase.expected.kind);
      expect(result.posting.amount).toBe(testCase.expected.amount);
      expect(
        result.posting.lines.map((line) => ({
          account: `${line.account.scope}/${line.account.owner}/${line.account.currency}`,
          delta: line.delta,
          balanceBefore: line.balanceBefore,
          balanceAfter: line.balanceAfter,
        })),
      ).toEqual(testCase.expected.lines);
      expect({ ...result.balances }).toEqual(testCase.expected.balances);

      // The property the whole design exists for.
      expect(result.posting.lines.reduce((sum, line) => sum + line.delta, 0)).toBe(0);
    });
  }
});

describe("shared vectors: earning", () => {
  const data = load<{
    baseTimestampMs: number;
    scenarios: {
      id: string;
      description: string;
      ruleKey: string;
      initialBalance: number;
      steps: {
        offsetMs: number;
        expected: {
          outcome: string;
          amount: number;
          grossAmount: number;
          previousBalance: number;
          newBalance: number;
          cooldownRemainingMs: number;
          periodRemaining: number | null;
          booked: boolean;
        };
      }[];
      finalBalance: number;
    }[];
  }>("earning");

  for (const scenario of data.scenarios) {
    it(`replays ${scenario.id}: ${scenario.description}`, () => {
      const economy = engine();
      let state = createEarnState();
      let balance = scenario.initialBalance;

      scenario.steps.forEach((step, index) => {
        const result = economy.earn(
          account(ANA, balance),
          scenario.ruleKey,
          state,
          opts(`${scenario.id}-${index}`, data.baseTimestampMs + step.offsetMs),
        );
        state = result.state;
        balance = result.newBalance;

        expect({
          outcome: result.outcome as string,
          amount: result.amount,
          grossAmount: result.grossAmount,
          previousBalance: result.previousBalance,
          newBalance: result.newBalance,
          cooldownRemainingMs: result.cooldownRemainingMs,
          periodRemaining: result.periodRemaining,
          booked: result.posting !== null,
        }).toEqual(step.expected);
      });

      expect(balance).toBe(scenario.finalBalance);
    });
  }
});

describe("shared vectors: decay", () => {
  const data = load<{
    baseTimestampMs: number;
    cases: {
      id: string;
      rule: DecayRule;
      balance: number;
      lastActivityAt: number;
      offsetMs: number;
      expected: {
        amount: number;
        periods: number;
        previousBalance: number;
        newBalance: number;
        appliedUpTo: number;
        booked: boolean;
      };
    }[];
  }>("decay");

  for (const testCase of data.cases) {
    it(`reproduces ${testCase.id}`, () => {
      const result = engine().applyDecay(account(ANA, testCase.balance), testCase.rule, {
        ...opts(testCase.id, data.baseTimestampMs + testCase.offsetMs),
        lastActivityAt: testCase.lastActivityAt,
        lastAppliedAt: null,
      });
      expect({
        amount: result.amount,
        periods: result.periods,
        previousBalance: result.previousBalance,
        newBalance: result.newBalance,
        appliedUpTo: result.appliedUpTo,
        booked: result.posting !== null,
      }).toEqual(testCase.expected);
    });
  }
});

describe("shared vectors: inventory", () => {
  const data = load<{
    sequences: {
      id: string;
      start: InventorySlot[];
      steps: {
        op: "add" | "remove";
        itemId: string;
        quantity: number;
        expected: { deltas: unknown[]; slots: InventorySlot[] };
      }[];
      finalSlots: InventorySlot[];
    }[];
  }>("inventory");

  for (const sequence of data.sequences) {
    it(`replays ${sequence.id}`, () => {
      let inventory = new Inventory(sequence.start);
      for (const step of sequence.steps) {
        const item = step.itemId === "potion" ? POTION : SWORD;
        const change =
          step.op === "add"
            ? addItem(inventory, item, step.quantity)
            : removeItem(inventory, step.itemId, step.quantity);
        inventory = change.inventory;
        expect(change.deltas).toEqual(step.expected.deltas);
        expect(change.inventory.toJSON()).toEqual(step.expected.slots);
      }
      expect(inventory.toJSON()).toEqual(sequence.finalSlots);
    });
  }
});

describe("shared vectors: shop", () => {
  const data = load<{
    baseTimestampMs: number;
    cases: {
      id: string;
      unitPrice: number;
      quantity: number;
      balance: number;
      stock: number | null;
      expected: {
        totalPrice: number;
        quantity: number;
        balances: Record<string, number>;
        remainingStock: number | null;
        slots: InventorySlot[];
        maxPurchasable: number;
      };
    }[];
  }>("shop");

  for (const testCase of data.cases) {
    it(`reproduces ${testCase.id}`, () => {
      const offer = createOffer({
        offerId: `offer-${testCase.id}`,
        itemId: "potion",
        unitPrice: testCase.unitPrice,
        currency: COIN,
        stock: testCase.stock,
      });
      const result = purchase(engine(), {
        ...opts(`shop-${testCase.id}`, data.baseTimestampMs),
        offer,
        item: POTION,
        buyer: account(ANA, testCase.balance),
        inventory: new Inventory(),
        quantity: testCase.quantity,
      });

      expect({
        totalPrice: result.totalPrice,
        quantity: result.quantity,
        balances: { ...result.booking.balances },
        remainingStock: result.offer.stock,
        slots: result.inventory.inventory.toJSON(),
        maxPurchasable: maxPurchasable(
          offer,
          testCase.balance,
          0,
          data.baseTimestampMs,
        ),
      }).toEqual(testCase.expected);
    });
  }
});

describe("shared vectors: trade", () => {
  const data = load<{
    baseTimestampMs: number;
    cases: {
      id: string;
      left: TradeSide;
      right: TradeSide;
      leftBalance: number;
      rightBalance: number;
      leftSlots: InventorySlot[];
      rightSlots: InventorySlot[];
      expiresAt: number;
      expected: {
        state: string;
        settledAt: number;
        booked: boolean;
        amount: number;
        balances: Record<string, number> | null;
        leftSlots: InventorySlot[];
        rightSlots: InventorySlot[];
      };
    }[];
  }>("trade");

  const T0 = data.baseTimestampMs;

  for (const testCase of data.cases) {
    it(`reproduces ${testCase.id}`, () => {
      const proposed = proposeTrade({
        tradeId: `trade-${testCase.id}`,
        scope: SCOPE,
        currency: COIN,
        left: testCase.left,
        right: testCase.right,
        now: T0,
      });
      expect(proposed.expiresAt).toBe(testCase.expiresAt);

      const settled = settleTrade(engine(), {
        ...opts(`trade-${testCase.id}-settle`, T0 + 1000),
        trade: acceptTrade(acceptTrade(proposed, "ana", T0), "ben", T0),
        leftAccount: account(ANA, testCase.leftBalance),
        rightAccount: account(BEN, testCase.rightBalance),
        leftInventory: new Inventory(testCase.leftSlots),
        rightInventory: new Inventory(testCase.rightSlots),
        items: { potion: POTION, sword: SWORD },
      });

      expect({
        state: settled.trade.state as string,
        settledAt: settled.trade.settledAt as number,
        booked: settled.booking !== null,
        amount: settled.booking?.posting.amount ?? 0,
        balances:
          settled.booking === null ? null : { ...settled.booking.balances },
        leftSlots: settled.leftInventory.inventory.toJSON(),
        rightSlots: settled.rightInventory.inventory.toJSON(),
      }).toEqual(testCase.expected);
    });
  }
});



// The shapes the generator writes. Spelled out rather than inferred, because a
// vector file that grew a field nobody reads is a vector nobody is checking.

interface RoundingVectors {
  cases: { numerator: number; denominator: number; mode: Rounding; expected: number }[];
}

interface InstalmentRow {
  number: number;
  openingBalance: number;
  interest: number;
  principal: number;
  payment: number;
  closingBalance: number;
}

interface InterestVectors {
  accruals: {
    principal: number;
    rateBasisPoints: number;
    periods: number;
    basis: AccrualBasis;
    rounding: Rounding;
    expected: { interest: number; balance: number };
  }[];
  schedules: {
    principal: number;
    rateBasisPoints: number;
    periods: number;
    method: AmortisationMethod;
    expected: {
      levelPayment: number | null;
      totalInterest: number;
      totalPaid: number;
      instalments: InstalmentRow[];
    };
  }[];
}

interface BankingVectors {
  deposits: {
    rateBasisPoints: number;
    amount: number;
    periods: number;
    expected: {
      steps: { kind: string; amount: number; balance: number }[];
      principal: number;
      accruedInterest: number;
      balance: number;
      maturityValue: number;
    };
  }[];
}

interface CreditVectors {
  loans: {
    principal: number;
    rateBasisPoints: number;
    periods: number;
    method: AmortisationMethod;
    expected: {
      totalInterest: number;
      totalPaid: number;
      payments: {
        amount: number;
        toFees: number;
        toInterest: number;
        toPrincipal: number;
        instalmentsCleared: number;
      }[];
      finalState: LoanState;
      creditAccount: number;
      feeAccount: number;
    };
  }[];
}

interface FeeVectors {
  rules: {
    key: string;
    rule: {
      mode: FeeMode;
      flat: number;
      basisPoints: number;
      minimum: number;
      maximum: number | null;
      rounding: Rounding;
      tiers: { threshold: number; basisPoints: number }[];
    };
    quotes: {
      amount: number;
      expected: { fee: number; payerPays: number; recipientReceives: number };
    }[];
  }[];
  splits: { fee: number; weights: number[]; expected: number[] }[];
}

interface InstrumentVectors {
  trades: {
    units: number[];
    prices: number[];
    sell: [number, number];
    expected: {
      steps: Record<string, number | string>[];
      units: number;
      costBasis: number;
      realisedGain: number;
      averageCost: number;
      valuation: number;
    };
  }[];
  coupons: {
    faceValue: number;
    couponBasisPoints: number;
    units: number;
    periods: number;
    expected: number;
  }[];
  dividends: { units: number[]; total: number; expected: number[] }[];
}

type OrderRow = [string, string, OrderSide, number, number, number];

interface MarketVectors {
  books: {
    id: string;
    book: OrderRow[];
    incoming: OrderRow;
    expected: {
      fills: {
        buyOrderId: string;
        sellOrderId: string;
        quantity: number;
        unitPrice: number;
        consideration: number;
      }[];
      filledQuantity: number;
      totalConsideration: number;
      book: { orderId: string; filled: number; state: OrderState }[];
    };
  }[];
  exchanges: {
    amount: number;
    numerator: number;
    denominator: number;
    rounding: Rounding;
    expected: number;
  }[];
}

interface BillingVectors {
  subscriptions: {
    intervalMs: number;
    amount: number;
    elapsedMs: number[];
    expected: { elapsedMs: number; due: number }[];
    nextChargeAt: number | null;
  }[];
  payrolls: {
    total: number;
    count: number;
    weights: number[] | null;
    expected: { owner: string; amount: number }[];
  }[];
  financed: {
    cashPrice: number;
    rateBasisPoints: number;
    instalments: number;
    expected: { totalPayable: number; costOfCredit: number };
  }[];
}

interface ReportingVectors {
  gini: { balances: number[]; expected: number }[];
  distributions: {
    balances: Record<string, number>;
    expected: {
      holders: number;
      total: number;
      median: number;
      mean: number;
      giniPermille: number;
    };
    topHolders: { key: string; amount: number }[];
  }[];
}

// ---------------------------------------------------------------------------
// The financial subsystems
//
// These vectors are generated from this edition, so a failure here means this
// edition changed without the vectors being regenerated — which is exactly the
// moment to ask whether the change belongs in the changelog rather than to
// regenerate and move on.
// ---------------------------------------------------------------------------

describe("shared vectors: rounding", () => {
  const vectors = load<RoundingVectors>("rounding");
  for (const testCase of vectors.cases) {
    it(`${testCase.numerator}/${testCase.denominator} ${testCase.mode}`, () => {
      expect(divideRounded(testCase.numerator, testCase.denominator, testCase.mode)).toBe(
        testCase.expected,
      );
    });
  }
});

describe("shared vectors: interest", () => {
  const vectors = load<InterestVectors>("interest");

  it("accrues every case exactly", () => {
    for (const testCase of vectors.accruals) {
      const { principal, rateBasisPoints, periods, basis, rounding, expected } = testCase;
      expect(accrueInterest(principal, rateBasisPoints, periods, basis, rounding)).toBe(
        expected.interest,
      );
      expect(projectBalance(principal, rateBasisPoints, periods, basis, rounding)).toBe(
        expected.balance,
      );
    }
  });

  for (const testCase of vectors.schedules) {
    it(`schedules ${testCase.principal}@${testCase.rateBasisPoints}x${testCase.periods} ${testCase.method}`, () => {
      const schedule = amortisationSchedule(
        testCase.principal,
        testCase.rateBasisPoints,
        testCase.periods,
        testCase.method,
      );
      if (testCase.expected.levelPayment !== null) {
        expect(levelPayment(testCase.principal, testCase.rateBasisPoints, testCase.periods)).toBe(
          testCase.expected.levelPayment,
        );
      }
      expect(schedule.totalInterest).toBe(testCase.expected.totalInterest);
      expect(schedule.totalPaid).toBe(testCase.expected.totalPaid);
      expect(
        schedule.instalments.map((row) => ({
          number: row.number,
          openingBalance: row.openingBalance,
          interest: row.interest,
          principal: row.principal,
          payment: row.payment,
          closingBalance: row.closingBalance,
        })),
      ).toEqual(testCase.expected.instalments);
    });
  }
});

describe("shared vectors: banking", () => {
  const vectors = load<BankingVectors>("banking");
  for (const testCase of vectors.deposits) {
    it(`${testCase.amount} at ${testCase.rateBasisPoints} basis points`, () => {
      const economy = new EconomyEngine({ currencies: [createCurrency({ code: COIN })] });
      const owner = memberAccount(SCOPE, "ana", COIN);
      let held = openDeposit(
        "d",
        owner,
        createDepositTerms({ rateBasisPoints: testCase.rateBasisPoints }),
        T0,
      );
      const steps = [];
      const funded = deposit(economy, held, account(owner, 1_000_000), testCase.amount, {
        now: T0,
        operationId: "dep",
        reason: "shared vector",
      });
      held = funded.deposit;
      steps.push({
        kind: "deposit",
        amount: funded.booking.posting.amount,
        balance: depositBalance(held),
      });
      for (let index = 0; index < testCase.periods; index += 1) {
        const accrued = accrueDepositInterest(economy, held, 1, {
          now: T0,
          operationId: `acc-${index}`,
          reason: "shared vector",
        });
        held = accrued.deposit;
        steps.push({
          kind: "interest",
          amount: accrued.booking === null ? 0 : accrued.booking.posting.amount,
          balance: depositBalance(held),
        });
      }

      expect(steps).toEqual(testCase.expected.steps);
      expect(held.principal).toBe(testCase.expected.principal);
      expect(held.accruedInterest).toBe(testCase.expected.accruedInterest);
      expect(depositBalance(held)).toBe(testCase.expected.balance);
      expect(maturityValue(held, 2)).toBe(testCase.expected.maturityValue);
    });
  }
});

describe("shared vectors: credit", () => {
  const vectors = load<CreditVectors>("credit");
  for (const testCase of vectors.loans) {
    it(`${testCase.principal}@${testCase.rateBasisPoints} ${testCase.method}`, () => {
      const economy = new EconomyEngine({ currencies: [createCurrency({ code: COIN })] });
      const borrower = memberAccount(SCOPE, "ana", COIN);
      let creditBalance = -testCase.principal;
      let feeBalance = 0;

      let loan = openLoan(
        economy,
        "L",
        createLoanTerms({
          principal: testCase.principal,
          rateBasisPoints: testCase.rateBasisPoints,
          periods: testCase.periods,
          method: testCase.method,
        }),
        account(borrower, 0),
        { now: T0, operationId: "open", reason: "shared vector" },
      ).loan;

      const payments = [];
      let step = 0;
      while ((loan.state === LoanState.Active || loan.state === LoanState.InArrears) && step < 60) {
        step += 1;
        const due = amountDue(loan);
        const result = repay(economy, loan, account(borrower, 100_000_000), due, {
          now: T0,
          operationId: `r-${step}`,
          reason: "shared vector",
          creditAccount: account(
            systemAccount(SCOPE, COIN, SystemAccount.Credit),
            creditBalance,
          ),
          feeAccount: account(systemAccount(SCOPE, COIN, SystemAccount.Fee), feeBalance),
        });
        creditBalance += result.toPrincipal;
        feeBalance += result.toInterest + result.toFees;
        loan = result.loan;
        payments.push({
          amount: due,
          toFees: result.toFees,
          toInterest: result.toInterest,
          toPrincipal: result.toPrincipal,
          instalmentsCleared: result.instalmentsCleared,
        });
      }

      expect(loan.schedule.totalInterest).toBe(testCase.expected.totalInterest);
      expect(loan.schedule.totalPaid).toBe(testCase.expected.totalPaid);
      expect(payments).toEqual(testCase.expected.payments);
      expect(loan.state).toBe(testCase.expected.finalState);
      expect(creditBalance).toBe(testCase.expected.creditAccount);
      expect(feeBalance).toBe(testCase.expected.feeAccount);
    });
  }
});

describe("shared vectors: fees", () => {
  const vectors = load<FeeVectors>("fees");
  for (const testCase of vectors.rules) {
    it(`${testCase.key} quotes every amount the same`, () => {
      const rule = createFeeRule(testCase.key, {
        mode: testCase.rule.mode,
        flat: testCase.rule.flat,
        basisPoints: testCase.rule.basisPoints,
        tiers: testCase.rule.tiers.map((tier) => createTier(tier.threshold, tier.basisPoints)),
        minimum: testCase.rule.minimum,
        maximum: testCase.rule.maximum,
        rounding: testCase.rule.rounding,
      });
      for (const quoted of testCase.quotes) {
        const quote = quoteFee(rule, quoted.amount);
        expect({
          fee: quote.fee,
          payerPays: quote.payerPays,
          recipientReceives: quote.recipientReceives,
        }).toEqual(quoted.expected);
      }
    });
  }

  it("splits a fee the same way", () => {
    for (const testCase of vectors.splits) {
      expect(splitFee(testCase.fee, testCase.weights)).toEqual(testCase.expected);
    }
  });
});

describe("shared vectors: instruments", () => {
  const vectors = load<InstrumentVectors>("instruments");

  for (const [index, testCase] of vectors.trades.entries()) {
    it(`trade ${index}`, () => {
      const economy = new EconomyEngine({ currencies: [createCurrency({ code: COIN })] });
      const holder = memberAccount(SCOPE, "ana", COIN);
      const instrument = createInstrument("share", InstrumentKind.Share, COIN);
      let position = openPosition(holder, instrument);
      const steps = [];

      testCase.units.forEach((units, step) => {
        const outcome = buyUnits(
          economy,
          instrument,
          position,
          account(holder, 100_000_000),
          units,
          testCase.prices[step],
          { now: T0, operationId: `buy-${step}`, reason: "shared vector" },
        );
        position = outcome.position;
        steps.push({
          kind: "buy",
          units,
          unitPrice: testCase.prices[step],
          consideration: outcome.consideration,
          costBasis: position.costBasis,
        });
      });

      const sold = sellUnits(
        economy,
        instrument,
        position,
        account(holder, 0),
        testCase.sell[0],
        testCase.sell[1],
        { now: T0, operationId: "sell", reason: "shared vector" },
      );
      position = sold.position;
      steps.push({
        kind: "sell",
        units: testCase.sell[0],
        unitPrice: testCase.sell[1],
        consideration: sold.consideration,
        realisedGain: sold.realisedGain,
        costBasis: position.costBasis,
      });

      expect(steps).toEqual(testCase.expected.steps);
      expect(position.units).toBe(testCase.expected.units);
      expect(position.costBasis).toBe(testCase.expected.costBasis);
      expect(position.realisedGain).toBe(testCase.expected.realisedGain);
      expect(averageCost(position)).toBe(testCase.expected.averageCost);
      expect(valuePosition(position, 200).unrealisedGain).toBe(testCase.expected.valuation);
    });
  }

  it("pays the coupon its terms fix", () => {
    for (const testCase of vectors.coupons) {
      const bond = createInstrument("bond", InstrumentKind.Bond, COIN, {
        faceValue: testCase.faceValue,
        couponBasisPoints: testCase.couponBasisPoints,
      });
      expect(couponDue(bond, testCase.units, testCase.periods)).toBe(testCase.expected);
    }
  });

  it("splits a dividend the same way", () => {
    for (const testCase of vectors.dividends) {
      const positions = testCase.units.map((units, index) => ({
        holder: memberAccount(SCOPE, `m${index}`, COIN),
        instrumentId: "s",
        units,
        costBasis: 0,
        realisedGain: 0,
      }));
      expect(distributeDividend(positions, testCase.total).map((payout) => payout.amount)).toEqual(
        testCase.expected,
      );
    }
  });
});

describe("shared vectors: market", () => {
  const vectors = load<MarketVectors>("market");

  for (const testCase of vectors.books) {
    it(testCase.id, () => {
      const toOrder = ([orderId, owner, side, price, quantity, offset]) =>
        createOrder(
          orderId,
          memberAccount(SCOPE, owner, COIN),
          "ore",
          side,
          price,
          quantity,
          T0 + offset,
        );
      const result = matchOrder(toOrder(testCase.incoming), testCase.book.map(toOrder));
      expect(
        result.fills.map((fill) => ({
          buyOrderId: fill.buyOrderId,
          sellOrderId: fill.sellOrderId,
          quantity: fill.quantity,
          unitPrice: fill.unitPrice,
          consideration: fill.consideration,
        })),
      ).toEqual(testCase.expected.fills);
      expect(filledQuantity(result)).toBe(testCase.expected.filledQuantity);
      expect(totalConsideration(result)).toBe(testCase.expected.totalConsideration);
      expect(
        result.book.map((order) => ({
          orderId: order.orderId,
          filled: order.filled,
          state: order.state,
        })),
      ).toEqual(testCase.expected.book);
    });
  }

  it("exchanges at the rate and rounding the caller supplied", () => {
    for (const testCase of vectors.exchanges) {
      const economy = new EconomyEngine({
        currencies: [createCurrency({ code: COIN }), createCurrency({ code: "GEM" })],
      });
      const { received } = exchange(
        economy,
        account(memberAccount(SCOPE, "ana", COIN), 1_000_000),
        account(memberAccount(SCOPE, "ana", "GEM"), 0),
        testCase.amount,
        testCase.numerator,
        testCase.denominator,
        { now: T0, operationId: "x", reason: "shared vector", rounding: testCase.rounding },
      );
      expect(received).toBe(testCase.expected);
    }
  });
});

describe("shared vectors: billing", () => {
  const vectors = load<BillingVectors>("billing");

  it("charges each interval exactly once", () => {
    for (const testCase of vectors.subscriptions) {
      const subscription = startSubscription(
        "s",
        createPlan({
          planId: "p",
          payer: memberAccount(SCOPE, "ana", COIN),
          payee: memberAccount(SCOPE, "ben", COIN),
          amount: testCase.amount,
          intervalMs: testCase.intervalMs,
        }),
        T0,
      );
      expect(
        testCase.elapsedMs.map((elapsed) => ({
          elapsedMs: elapsed,
          due: chargesDue(subscription, T0 + elapsed),
        })),
      ).toEqual(testCase.expected);
      expect(nextChargeAt(subscription)).toBe(testCase.nextChargeAt);
    }
  });

  it("splits a payroll pot the same way", () => {
    for (const testCase of vectors.payrolls) {
      const recipients = Array.from({ length: testCase.count }, (_, index) =>
        memberAccount(SCOPE, `m${index}`, COIN),
      );
      const lines =
        testCase.weights === null
          ? splitPayroll(testCase.total, recipients)
          : splitPayroll(testCase.total, recipients, testCase.weights);
      expect(lines.map((line) => ({ owner: line.recipient.owner, amount: line.amount }))).toEqual(
        testCase.expected,
      );
    }
  });

  it("prices a financed purchase the same way", () => {
    for (const testCase of vectors.financed) {
      const economy = new EconomyEngine({ currencies: [createCurrency({ code: COIN })] });
      const { plan } = financePurchase(economy, {
        planId: "f",
        buyer: memberAccount(SCOPE, "ana", COIN),
        seller: account(memberAccount(SCOPE, "ben", COIN), 0),
        cashPrice: testCase.cashPrice,
        rateBasisPoints: testCase.rateBasisPoints,
        instalments: testCase.instalments,
        now: T0,
        operationId: "finance",
        reason: "shared vector",
      });
      expect(totalPayable(plan)).toBe(testCase.expected.totalPayable);
      expect(costOfCredit(plan)).toBe(testCase.expected.costOfCredit);
    }
  });
});

describe("shared vectors: reporting", () => {
  const vectors = load<ReportingVectors>("reporting");

  it("scores inequality the same way", () => {
    for (const testCase of vectors.gini) {
      expect(giniPermille(testCase.balances)).toBe(testCase.expected);
    }
  });

  it("describes a distribution the same way", () => {
    for (const testCase of vectors.distributions) {
      const balances = Object.fromEntries(
        Object.entries(testCase.balances).map(([owner, amount]) => [
          accountKey(memberAccount(SCOPE, owner, COIN)),
          amount,
        ]),
      );
      const distribution = wealthDistribution(balances);
      expect({
        holders: distribution.holders,
        total: distribution.total,
        median: distribution.median,
        mean: distribution.mean,
        giniPermille: distribution.giniPermille,
      }).toEqual(testCase.expected);
      expect(topHolders(balances, 3).map(([key, amount]) => ({ key, amount }))).toEqual(
        testCase.topHolders,
      );
    }
  });
});
