/**
 * Regenerate ../../shared/testcases/*.json from this edition.
 *
 * Run `npm run build` first, then `node scripts/generate-shared-vectors.mjs`.
 *
 * The vectors are the contract between the Python and the TypeScript edition.
 * Regenerating them is a deliberate act: if a vector changes, the behaviour of
 * the library changed, and the change belongs in the changelog with the
 * matching version bump. Never regenerate to make a failing test pass.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acceptTrade,
  account,
  accountKey,
  AccrualBasis,
  accrueDepositInterest,
  accrueInterest,
  addItem,
  AmortisationMethod,
  amortisationSchedule,
  amountDue,
  applyPermille,
  averageCost,
  buyUnits,
  chargesDue,
  costOfCredit,
  couponDue,
  createCurrency,
  createDepositTerms,
  createEarnRule,
  createEarnState,
  createFeeRule,
  createInstrument,
  createItem,
  createLoanTerms,
  createOffer,
  createOrder,
  createPlan,
  createTier,
  deposit,
  depositBalance,
  distributeDividend,
  divideRounded,
  EconomyEngine,
  emptyAccount,
  exchange,
  FeeMode,
  filledQuantity,
  financePurchase,
  giniPermille,
  InstrumentKind,
  Inventory,
  levelPayment,
  LoanState,
  matchOrder,
  maturityValue,
  maxPurchasable,
  memberAccount,
  nextChargeAt,
  openDeposit,
  openLoan,
  openPosition,
  OrderSide,
  projectBalance,
  proposeTrade,
  purchase,
  quoteFee,
  removeItem,
  repay,
  Rounding,
  sellUnits,
  settleTrade,
  splitFee,
  splitMinorUnits,
  splitPayroll,
  startSubscription,
  systemAccount,
  SystemAccount,
  topHolders,
  totalConsideration,
  totalPayable,
  valuePosition,
  wealthDistribution,
} from "../dist/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "shared", "testcases");
mkdirSync(outDir, { recursive: true });

const FORMAT_VERSION = 1;
const SCOPE = "guild-1";
const COIN = "COIN";
const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function write(name, payload) {
  const file = join(outDir, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`wrote ${file}`);
}

function lines(posting) {
  return posting.lines.map((line) => ({
    account: accountKey(line.account),
    delta: line.delta,
    balanceBefore: line.balanceBefore,
    balanceAfter: line.balanceAfter,
  }));
}

// --------------------------------------------------------------------------
// money
// --------------------------------------------------------------------------

write("money", {
  formatVersion: FORMAT_VERSION,
  description:
    "Integer arithmetic on minor units. Amounts are never floats, so the two editions cannot drift through rounding.",
  splits: [
    { amount: 0, minorUnits: 0 },
    { amount: 1234, minorUnits: 0 },
    { amount: 1234, minorUnits: 2 },
    { amount: -1234, minorUnits: 2 },
    { amount: 5, minorUnits: 2 },
    { amount: -5, minorUnits: 2 },
    { amount: 100000, minorUnits: 3 },
  ].map(({ amount, minorUnits }) => ({
    amount,
    minorUnits,
    expected: splitMinorUnits(amount, createCurrency({ code: "X", minorUnits })),
  })),
  permilleChains: [
    { amount: 100, permilles: [] },
    { amount: 100, permilles: [1500] },
    { amount: 100, permilles: [500] },
    { amount: 7, permilles: [1500, 1100] },
    { amount: 7, permilles: [1100, 1500] },
    { amount: 999, permilles: [1001, 1001, 1001] },
    { amount: 1, permilles: [1999] },
    { amount: 3, permilles: [333, 3000] },
  ].map(({ amount, permilles }) => ({
    amount,
    permilles,
    expected: applyPermille(amount, permilles),
  })),
});

// --------------------------------------------------------------------------
// bookings
// --------------------------------------------------------------------------

const engine = new EconomyEngine({
  currencies: [createCurrency({ code: COIN, maxBalance: 1_000_000 })],
  earnRules: [
    createEarnRule({
      key: "message",
      amount: 10,
      currency: COIN,
      cooldownSeconds: 60,
      periodCapAmount: 100,
    }),
    createEarnRule({
      key: "daily",
      amount: 250,
      currency: COIN,
      cooldownSeconds: 86400,
    }),
  ],
});

const ANA = memberAccount(SCOPE, "ana", COIN);
const BEN = memberAccount(SCOPE, "ben", COIN);

const bookingCases = [
  {
    id: "credit-issues-from-the-mint",
    description: "New currency enters the economy and the mint goes negative by exactly that much.",
    run: () => engine.credit(emptyAccount(ANA), 500, opts("op-credit")),
  },
  {
    id: "debit-removes-to-the-sink",
    description: "Currency leaves the economy into the sink.",
    run: () => engine.debit(account(ANA, 500), 200, opts("op-debit")),
  },
  {
    id: "transfer-between-members",
    description: "The most common booking: value moves, the total does not change.",
    run: () => engine.transfer(account(ANA, 500), account(BEN, 20), 300, opts("op-transfer")),
  },
  {
    id: "transfer-of-the-whole-balance",
    description: "Spending everything is allowed; spending more is not.",
    run: () => engine.transfer(account(ANA, 500), account(BEN, 0), 500, opts("op-all")),
  },
  {
    id: "credit-to-an-explicit-source",
    description: "The shop account pays out a refund rather than the mint issuing new currency.",
    run: () =>
      engine.credit(account(ANA, 100), 200, {
        ...opts("op-refund"),
        source: account(systemAccount(SCOPE, COIN, SystemAccount.Shop), 1000),
      }),
  },
];

function opts(operationId, now = T0) {
  return { now, operationId, reason: "shared vector" };
}

write("bookings", {
  formatVersion: FORMAT_VERSION,
  description:
    "Primitive bookings. Every posting is double-entry and its lines always sum to zero — the property that makes 'no currency appeared from nowhere' checkable rather than hoped for.",
  baseTimestampMs: T0,
  cases: bookingCases.map(({ id, description, run }) => {
    const result = run();
    return {
      id,
      description,
      expected: {
        kind: result.posting.kind,
        amount: result.posting.amount,
        scope: result.posting.scope,
        currency: result.posting.currency,
        occurredAt: result.posting.occurredAt,
        reverses: result.posting.reverses,
        lines: lines(result.posting),
        balances: result.balances,
      },
    };
  }),
});

// --------------------------------------------------------------------------
// earning
// --------------------------------------------------------------------------

const earnScenarios = [
  {
    id: "cooldown-blocks-then-releases",
    description: "A payout, a blocked repeat inside the cooldown, then a payout once it expires.",
    ruleKey: "message",
    initialBalance: 0,
    steps: [{ offsetMs: 0 }, { offsetMs: 30_000 }, { offsetMs: 60_000 }],
  },
  {
    id: "period-cap-trims-then-blocks",
    description: "The daily ceiling trims the last payout and refuses the next.",
    ruleKey: "message",
    initialBalance: 0,
    steps: [
      { offsetMs: 0 },
      { offsetMs: 60_000 },
      { offsetMs: 120_000 },
      { offsetMs: 180_000 },
      { offsetMs: 240_000 },
      { offsetMs: 300_000 },
      { offsetMs: 360_000 },
      { offsetMs: 420_000 },
      { offsetMs: 480_000 },
      { offsetMs: 540_000 },
      { offsetMs: 600_000 },
      { offsetMs: 660_000 },
    ],
  },
  {
    id: "period-resets-the-next-day",
    description: "A new period starts once the old one is over.",
    ruleKey: "daily",
    initialBalance: 0,
    steps: [{ offsetMs: 0 }, { offsetMs: HOUR }, { offsetMs: DAY }],
  },
  {
    id: "unknown-rule-pays-nothing",
    description: "An unknown key is a result, not an exception.",
    ruleKey: "nonsense",
    initialBalance: 100,
    steps: [{ offsetMs: 0 }],
  },
  {
    id: "headroom-trims-the-payout",
    description: "A nearly full account receives only what still fits.",
    ruleKey: "daily",
    initialBalance: 999_900,
    steps: [{ offsetMs: 0 }],
  },
];

write("earning", {
  formatVersion: FORMAT_VERSION,
  description:
    "Earning sequences with cooldowns and period ceilings. Amounts are fixed, never random: EconomyWorld contains no randomness at all, for the legal reasons set out in the README.",
  baseTimestampMs: T0,
  scenarios: earnScenarios.map((scenario) => {
    let state = createEarnState();
    let balance = scenario.initialBalance;

    const steps = scenario.steps.map((step, index) => {
      const result = engine.earn(
        account(ANA, balance),
        scenario.ruleKey,
        state,
        opts(`${scenario.id}-${index}`, T0 + step.offsetMs),
      );
      state = result.state;
      balance = result.newBalance;
      return {
        offsetMs: step.offsetMs,
        expected: {
          outcome: result.outcome,
          amount: result.amount,
          grossAmount: result.grossAmount,
          previousBalance: result.previousBalance,
          newBalance: result.newBalance,
          cooldownRemainingMs: result.cooldownRemainingMs,
          periodRemaining: result.periodRemaining,
          booked: result.posting !== null,
        },
      };
    });

    return { ...scenario, steps, finalBalance: balance };
  }),
});

// --------------------------------------------------------------------------
// decay
// --------------------------------------------------------------------------

const decayCases = [
  {
    id: "flat-after-grace",
    rule: { amountPerPeriod: 10, permillePerPeriod: 0, periodSeconds: 86400, floor: 0, graceSeconds: 604800 },
    balance: 1000,
    lastActivityAt: T0,
    offsets: [3 * DAY, 10 * DAY, 30 * DAY],
  },
  {
    id: "percentage-share",
    rule: { amountPerPeriod: 0, permillePerPeriod: 100, periodSeconds: 86400, floor: 0, graceSeconds: 0 },
    balance: 1000,
    lastActivityAt: T0,
    offsets: [DAY, 2 * DAY, 5 * DAY],
  },
  {
    id: "flat-and-share-with-a-floor",
    rule: { amountPerPeriod: 5, permillePerPeriod: 50, periodSeconds: 86400, floor: 500, graceSeconds: 0 },
    balance: 2000,
    lastActivityAt: T0,
    offsets: [DAY, 10 * DAY, 365 * DAY],
  },
];

write("decay", {
  formatVersion: FORMAT_VERSION,
  description:
    "Decay is charged per whole elapsed period, so running it nightly costs the same as running it once a month. The flat amount is taken first, then the permille share of what remains.",
  baseTimestampMs: T0,
  cases: decayCases.flatMap((testCase) =>
    testCase.offsets.map((offsetMs) => {
      const result = engine.applyDecay(account(ANA, testCase.balance), testCase.rule, {
        ...opts(`${testCase.id}-${offsetMs}`, T0 + offsetMs),
        lastActivityAt: testCase.lastActivityAt,
        lastAppliedAt: null,
      });
      return {
        id: `${testCase.id}@${offsetMs}`,
        rule: testCase.rule,
        balance: testCase.balance,
        lastActivityAt: testCase.lastActivityAt,
        offsetMs,
        expected: {
          amount: result.amount,
          periods: result.periods,
          previousBalance: result.previousBalance,
          newBalance: result.newBalance,
          appliedUpTo: result.appliedUpTo,
          booked: result.posting !== null,
        },
      };
    }),
  ),
});

// --------------------------------------------------------------------------
// inventory
// --------------------------------------------------------------------------

const POTION = createItem({ itemId: "potion", maxStack: 10 });
const SWORD = createItem({ itemId: "sword", stackable: false });

write("inventory", {
  formatVersion: FORMAT_VERSION,
  description:
    "Inventories are value objects: every operation returns a new one, so a failed booking cannot leave a half-applied change behind.",
  sequences: [
    {
      id: "add-and-remove",
      start: [],
      steps: [
        { op: "add", itemId: "potion", quantity: 3 },
        { op: "add", itemId: "potion", quantity: 4 },
        { op: "remove", itemId: "potion", quantity: 5 },
        { op: "add", itemId: "sword", quantity: 1 },
        { op: "remove", itemId: "potion", quantity: 2 },
      ],
    },
    {
      id: "fill-a-stack-exactly",
      start: [{ itemId: "potion", quantity: 8 }],
      steps: [{ op: "add", itemId: "potion", quantity: 2 }],
    },
  ].map((sequence) => {
    let inventory = new Inventory(sequence.start);
    const steps = sequence.steps.map((step) => {
      const item = step.itemId === "potion" ? POTION : SWORD;
      const change =
        step.op === "add"
          ? addItem(inventory, item, step.quantity)
          : removeItem(inventory, step.itemId, step.quantity);
      inventory = change.inventory;
      return {
        ...step,
        expected: {
          deltas: change.deltas,
          slots: change.inventory.toJSON(),
        },
      };
    });
    return { ...sequence, steps, finalSlots: inventory.toJSON() };
  }),
});

// --------------------------------------------------------------------------
// shop
// --------------------------------------------------------------------------

const shopCases = [
  { id: "single-unit", unitPrice: 50, quantity: 1, balance: 500, stock: 5 },
  { id: "several-units", unitPrice: 50, quantity: 3, balance: 500, stock: 10 },
  { id: "spends-the-whole-balance", unitPrice: 100, quantity: 5, balance: 500, stock: null },
  { id: "free-offer", unitPrice: 0, quantity: 2, balance: 0, stock: 10 },
];

write("shop", {
  formatVersion: FORMAT_VERSION,
  description:
    "A purchase changes three things together: the balance, the inventory and the stock. They belong in one database transaction.",
  baseTimestampMs: T0,
  cases: shopCases.map((testCase) => {
    const offer = createOffer({
      offerId: `offer-${testCase.id}`,
      itemId: "potion",
      unitPrice: testCase.unitPrice,
      currency: COIN,
      stock: testCase.stock,
    });
    const result = purchase(engine, {
      ...opts(`shop-${testCase.id}`),
      offer,
      item: POTION,
      buyer: account(ANA, testCase.balance),
      inventory: new Inventory(),
      quantity: testCase.quantity,
    });
    return {
      ...testCase,
      expected: {
        totalPrice: result.totalPrice,
        quantity: result.quantity,
        balances: result.booking.balances,
        remainingStock: result.offer.stock,
        slots: result.inventory.inventory.toJSON(),
        maxPurchasable: maxPurchasable(offer, testCase.balance, 0, T0),
      },
    };
  }),
});

// --------------------------------------------------------------------------
// trade
// --------------------------------------------------------------------------

const tradeCases = [
  {
    id: "currency-for-items",
    left: { owner: "ana", amount: 100, items: [] },
    right: { owner: "ben", amount: 0, items: [{ itemId: "potion", quantity: 3 }] },
    leftBalance: 500,
    rightBalance: 20,
    leftSlots: [],
    rightSlots: [{ itemId: "potion", quantity: 5 }],
  },
  {
    id: "netted-currency",
    left: { owner: "ana", amount: 100, items: [] },
    right: { owner: "ben", amount: 30, items: [] },
    leftBalance: 500,
    rightBalance: 500,
    leftSlots: [],
    rightSlots: [],
  },
  {
    id: "items-only",
    left: { owner: "ana", amount: 0, items: [{ itemId: "sword", quantity: 1 }] },
    right: { owner: "ben", amount: 0, items: [{ itemId: "potion", quantity: 2 }] },
    leftBalance: 100,
    rightBalance: 100,
    leftSlots: [{ itemId: "sword", quantity: 1 }],
    rightSlots: [{ itemId: "potion", quantity: 4 }],
  },
];

write("trade", {
  formatVersion: FORMAT_VERSION,
  description:
    "A settled trade moves both sides at once, with the currency netted into a single posting. An abandoned trade leaves no damage behind.",
  baseTimestampMs: T0,
  cases: tradeCases.map((testCase) => {
    const proposed = proposeTrade({
      tradeId: `trade-${testCase.id}`,
      scope: SCOPE,
      currency: COIN,
      left: testCase.left,
      right: testCase.right,
      now: T0,
    });
    const settled = settleTrade(engine, {
      ...opts(`trade-${testCase.id}-settle`, T0 + 1000),
      trade: acceptTrade(acceptTrade(proposed, "ana", T0), "ben", T0),
      leftAccount: account(ANA, testCase.leftBalance),
      rightAccount: account(BEN, testCase.rightBalance),
      leftInventory: new Inventory(testCase.leftSlots),
      rightInventory: new Inventory(testCase.rightSlots),
      items: { potion: POTION, sword: SWORD },
    });

    return {
      ...testCase,
      expiresAt: proposed.expiresAt,
      expected: {
        state: settled.trade.state,
        settledAt: settled.trade.settledAt,
        booked: settled.booking !== null,
        amount: settled.booking?.posting.amount ?? 0,
        balances: settled.booking?.balances ?? null,
        leftSlots: settled.leftInventory.inventory.toJSON(),
        rightSlots: settled.rightInventory.inventory.toJSON(),
      },
    };
  }),
});

// --------------------------------------------------------------------------
// The financial subsystems
//
// Everything above is the original engine. What follows is banking, credit,
// investments, markets, fees and billing: the parts where an amount is
// multiplied by a rate and then divided, which is exactly where two editions
// drift apart if they are ever allowed to.
// --------------------------------------------------------------------------

const ROUNDING_MODES = [Rounding.Down, Rounding.Up, Rounding.HalfUp, Rounding.HalfEven];

// The engine above carries a balance ceiling and earn rules that the financial
// cases have no use for; these want a plain one, and a fresh one per case so
// that no case can depend on another having run first.
const freshEngine = () =>
  new EconomyEngine({ currencies: [createCurrency({ code: COIN })] });

write("rounding", {
  formatVersion: FORMAT_VERSION,
  description:
    "Integer division under each rounding mode. Symmetric about zero, so the sign of an amount never changes how far it is rounded.",
  cases: [
    [7, 2],
    [-7, 2],
    [7, -2],
    [5, 2],
    [-5, 2],
    [1, 1000],
    [-1, 1000],
    [0, 7],
    [100, 4],
    [12_345, 100],
    [-12_345, 100],
    [9_007_199_254_740_991, 3],
    // The case the differential harness found: `Math.floor(a / b)` put the
    // quotient on the wrong side of an integer, and every mode but DOWN then
    // read a nonsense remainder. Pinned here so it can never come back.
    [9_007_199_254_737_658, 360],
    [9_007_199_254_740_991, 7],
    [9_007_199_254_740_991, 9973],
    [9_007_199_254_740_658, 12],
  ].flatMap(([numerator, denominator]) =>
    ROUNDING_MODES.map((mode) => ({
      numerator,
      denominator,
      mode,
      expected: divideRounded(numerator, denominator, mode),
    })),
  ),
});

write("interest", {
  formatVersion: FORMAT_VERSION,
  description:
    "Accrual and amortisation. Schedules are built by iterating whole units rather than from a closed form, so both editions charge the same instalment to the unit.",
  accruals: [
    [10_000, 500, 1],
    [10_000, 500, 2],
    [10_000, 500, 12],
    [100, 1, 1],
    [1_000, 333, 10],
    [7, 10_000, 3],
    [0, 500, 5],
    [10_000, 0, 5],
  ].flatMap(([principal, rate, periods]) =>
    [AccrualBasis.Compound, AccrualBasis.Simple].flatMap((basis) =>
      ROUNDING_MODES.map((rounding) => ({
        principal,
        rateBasisPoints: rate,
        periods,
        basis,
        rounding,
        expected: {
          interest: accrueInterest(principal, rate, periods, basis, rounding),
          balance: projectBalance(principal, rate, periods, basis, rounding),
        },
      })),
    ),
  ),
  schedules: [
    [120_000, 100, 12],
    [1_000, 0, 4],
    [1, 1000, 3],
    [987_654_321, 250, 24],
    [7, 1, 2],
    [100_000, 1500, 6],
  ].flatMap(([principal, rate, periods]) =>
    [
      AmortisationMethod.EqualInstalment,
      AmortisationMethod.EqualPrincipal,
      AmortisationMethod.InterestOnly,
    ].map((method) => {
      const schedule = amortisationSchedule(principal, rate, periods, method);
      return {
        principal,
        rateBasisPoints: rate,
        periods,
        method,
        expected: {
          levelPayment: method === AmortisationMethod.EqualInstalment ? levelPayment(principal, rate, periods) : null,
          totalInterest: schedule.totalInterest,
          totalPaid: schedule.totalPaid,
          instalments: schedule.instalments.map((row) => ({
            number: row.number,
            openingBalance: row.openingBalance,
            interest: row.interest,
            principal: row.principal,
            payment: row.payment,
            closingBalance: row.closingBalance,
          })),
        },
      };
    }),
  ),
});

write("banking", {
  formatVersion: FORMAT_VERSION,
  description:
    "Deposits, interest and holds. What the bank account holds equals what is on deposit, to the unit, after every step.",
  deposits: [
    { rateBasisPoints: 500, amount: 10_000, periods: 3 },
    { rateBasisPoints: 200, amount: 5_000, periods: 3 },
    { rateBasisPoints: 1, amount: 100, periods: 5 },
    { rateBasisPoints: 0, amount: 1_234, periods: 2 },
    { rateBasisPoints: 10_000, amount: 7, periods: 4 },
  ].map((testCase) => {
    const economy = freshEngine();
    let held = openDeposit("d", ANA, createDepositTerms({ rateBasisPoints: testCase.rateBasisPoints }), T0);
    const steps = [];
    const funded = deposit(economy, held, account(ANA, 1_000_000), testCase.amount, opts("dep"));
    held = funded.deposit;
    steps.push({ kind: "deposit", amount: funded.booking.posting.amount, balance: depositBalance(held) });
    for (let index = 0; index < testCase.periods; index += 1) {
      const accrued = accrueDepositInterest(economy, held, 1, opts(`acc-${index}`));
      held = accrued.deposit;
      steps.push({
        kind: "interest",
        amount: accrued.booking === null ? 0 : accrued.booking.posting.amount,
        balance: depositBalance(held),
      });
    }
    return {
      ...testCase,
      expected: {
        steps,
        principal: held.principal,
        accruedInterest: held.accruedInterest,
        balance: depositBalance(held),
        maturityValue: maturityValue(held, 2),
      },
    };
  }),
});

write("credit", {
  formatVersion: FORMAT_VERSION,
  description:
    "Loans repaid instalment by instalment. Capital returns to the credit account and interest becomes fee revenue, so the credit account reaches exactly zero.",
  loans: [
    { principal: 120_000, rateBasisPoints: 100, periods: 12, method: AmortisationMethod.EqualInstalment },
    { principal: 50_000, rateBasisPoints: 750, periods: 6, method: AmortisationMethod.EqualPrincipal },
    { principal: 9_999, rateBasisPoints: 1_250, periods: 4, method: AmortisationMethod.InterestOnly },
    { principal: 101, rateBasisPoints: 1, periods: 3, method: AmortisationMethod.EqualInstalment },
    { principal: 1_000_000, rateBasisPoints: 0, periods: 5, method: AmortisationMethod.EqualInstalment },
  ].map((testCase) => {
    const economy = freshEngine();
    const world = { credit: 0, fee: 0 };
    const start = openLoan(
      economy,
      "L",
      createLoanTerms({
        principal: testCase.principal,
        rateBasisPoints: testCase.rateBasisPoints,
        periods: testCase.periods,
        method: testCase.method,
      }),
      account(ANA, 0),
      opts("open"),
    );
    world.credit -= testCase.principal;
    let loan = start.loan;
    const payments = [];
    let step = 0;
    while ((loan.state === LoanState.Active || loan.state === LoanState.InArrears) && step < 60) {
      step += 1;
      const due = amountDue(loan);
      const result = repay(economy, loan, account(ANA, 100_000_000), due, {
        ...opts(`r-${step}`),
        creditAccount: account(systemAccount(SCOPE, COIN, SystemAccount.Credit), world.credit),
        feeAccount: account(systemAccount(SCOPE, COIN, SystemAccount.Fee), world.fee),
      });
      world.credit += result.toPrincipal;
      world.fee += result.toInterest + result.toFees;
      loan = result.loan;
      payments.push({
        amount: due,
        toFees: result.toFees,
        toInterest: result.toInterest,
        toPrincipal: result.toPrincipal,
        instalmentsCleared: result.instalmentsCleared,
      });
    }
    return {
      ...testCase,
      expected: {
        totalInterest: loan.schedule.totalInterest,
        totalPaid: loan.schedule.totalPaid,
        payments,
        finalState: loan.state,
        creditAccount: world.credit,
        feeAccount: world.fee,
      },
    };
  }),
});

write("fees", {
  formatVersion: FORMAT_VERSION,
  description:
    "Fee rules quoted on a range of amounts. A fee is the same number in both editions or a member is charged differently by the same bot.",
  rules: [
    { key: "flat", flat: 25 },
    { key: "rate", basisPoints: 250 },
    { key: "both", flat: 5, basisPoints: 175, minimum: 10, maximum: 900 },
    { key: "inclusive", mode: FeeMode.Inclusive, basisPoints: 250 },
    { key: "inclusive-flat", mode: FeeMode.Inclusive, flat: 50 },
    { key: "up", basisPoints: 1, rounding: Rounding.Up },
    { key: "half-even", basisPoints: 125, rounding: Rounding.HalfEven },
    { key: "tiered", tiers: [createTier(0, 0), createTier(1_000, 100), createTier(10_000, 250)] },
  ].map((options) => {
    const { key, ...rest } = options;
    const rule = createFeeRule(key, rest);
    return {
      key,
      rule: {
        mode: rule.mode,
        flat: rule.flat,
        basisPoints: rule.basisPoints,
        minimum: rule.minimum,
        maximum: rule.maximum,
        rounding: rule.rounding,
        tiers: rule.tiers.map((tier) => ({ threshold: tier.threshold, basisPoints: tier.basisPoints })),
      },
      quotes: [0, 1, 99, 100, 999, 1_000, 1_001, 9_999, 10_000, 55_555, 1_000_000].map((amount) => {
        const quote = quoteFee(rule, amount);
        return {
          amount,
          expected: {
            fee: quote.fee,
            payerPays: quote.payerPays,
            recipientReceives: quote.recipientReceives,
          },
        };
      }),
    };
  }),
  splits: [
    { fee: 10, weights: [1, 1, 1] },
    { fee: 100, weights: [70, 20, 10] },
    { fee: 1, weights: [1, 1] },
    { fee: 9_999, weights: [1, 0, 3, 5] },
    { fee: 0, weights: [5] },
  ].map((testCase) => ({ ...testCase, expected: splitFee(testCase.fee, testCase.weights) })),
});

write("instruments", {
  formatVersion: FORMAT_VERSION,
  description:
    "Positions bought and sold at prices the caller supplies. There is no price model here and never will be — see the module's opening note.",
  trades: [
    { units: [10, 10], prices: [100, 300], sell: [15, 250] },
    { units: [3, 7], prices: [333, 101], sell: [10, 50] },
    { units: [99, 1], prices: [7, 1], sell: [50, 9] },
    { units: [5, 5], prices: [0, 1_000], sell: [10, 500] },
  ].map((testCase) => {
    const economy = freshEngine();
    const instrument = createInstrument("share", InstrumentKind.Share, COIN);
    let position = openPosition(ANA, instrument);
    const steps = [];
    testCase.units.forEach((units, index) => {
      const outcome = buyUnits(
        economy,
        instrument,
        position,
        account(ANA, 100_000_000),
        units,
        testCase.prices[index],
        opts(`buy-${index}`),
      );
      position = outcome.position;
      steps.push({
        kind: "buy",
        units,
        unitPrice: testCase.prices[index],
        consideration: outcome.consideration,
        costBasis: position.costBasis,
      });
    });
    const sold = sellUnits(
      economy,
      instrument,
      position,
      account(ANA, 0),
      testCase.sell[0],
      testCase.sell[1],
      opts("sell"),
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
    return {
      ...testCase,
      expected: {
        steps,
        units: position.units,
        costBasis: position.costBasis,
        realisedGain: position.realisedGain,
        averageCost: averageCost(position),
        valuation: valuePosition(position, 200).unrealisedGain,
      },
    };
  }),
  coupons: [
    { faceValue: 1_000, couponBasisPoints: 500, units: 10, periods: 4 },
    { faceValue: 1, couponBasisPoints: 1, units: 1, periods: 1 },
    { faceValue: 250, couponBasisPoints: 333, units: 7, periods: 3 },
  ].map((testCase) => {
    const bond = createInstrument("bond", InstrumentKind.Bond, COIN, {
      faceValue: testCase.faceValue,
      couponBasisPoints: testCase.couponBasisPoints,
    });
    return { ...testCase, expected: couponDue(bond, testCase.units, testCase.periods) };
  }),
  dividends: [
    { units: [1, 1, 1], total: 10 },
    { units: [70, 30], total: 1_000 },
    { units: [1, 2, 3, 4], total: 9_999 },
  ].map((testCase) => ({
    ...testCase,
    expected: distributeDividend(
      testCase.units.map((units, index) => ({
        holder: memberAccount(SCOPE, `m${index}`, COIN),
        instrumentId: "s",
        units,
        costBasis: 0,
        realisedGain: 0,
      })),
      testCase.total,
    ).map((payout) => payout.amount),
  })),
});

write("market", {
  formatVersion: FORMAT_VERSION,
  description:
    "Order matching by price, then time, then id, and currency exchange at a rate the caller supplies. The tie-break is in the vectors because an order book whose ties depend on iteration order is not reproducible.",
  books: [
    {
      id: "sweeps-two-levels",
      book: [
        ["s1", "bob", OrderSide.Sell, 100, 5, 0],
        ["s2", "cai", OrderSide.Sell, 110, 5, 0],
        ["s3", "dee", OrderSide.Sell, 120, 5, 0],
      ],
      incoming: ["b1", "ana", OrderSide.Buy, 115, 20, 1],
    },
    {
      id: "time-breaks-a-price-tie",
      book: [
        ["second", "bob", OrderSide.Sell, 100, 5, 10],
        ["first", "cai", OrderSide.Sell, 100, 5, 0],
      ],
      incoming: ["b1", "ana", OrderSide.Buy, 100, 5, 20],
    },
    {
      id: "id-breaks-a-price-and-time-tie",
      book: [
        ["bbb", "bob", OrderSide.Sell, 100, 5, 0],
        ["aaa", "cai", OrderSide.Sell, 100, 5, 0],
      ],
      incoming: ["b1", "ana", OrderSide.Buy, 100, 5, 1],
    },
    {
      id: "no-self-trade",
      book: [["s1", "ana", OrderSide.Sell, 100, 5, 0]],
      incoming: ["b1", "ana", OrderSide.Buy, 100, 5, 1],
    },
    {
      id: "rests-when-it-does-not-cross",
      book: [["s1", "bob", OrderSide.Sell, 120, 5, 0]],
      incoming: ["b1", "ana", OrderSide.Buy, 100, 5, 1],
    },
  ].map((testCase) => {
    const toOrder = ([orderId, owner, side, price, quantity, offset]) =>
      createOrder(orderId, memberAccount(SCOPE, owner, COIN), "ore", side, price, quantity, T0 + offset);
    const result = matchOrder(toOrder(testCase.incoming), testCase.book.map(toOrder));
    return {
      ...testCase,
      expected: {
        fills: result.fills.map((fill) => ({
          buyOrderId: fill.buyOrderId,
          sellOrderId: fill.sellOrderId,
          quantity: fill.quantity,
          unitPrice: fill.unitPrice,
          consideration: fill.consideration,
        })),
        filledQuantity: filledQuantity(result),
        totalConsideration: totalConsideration(result),
        book: result.book.map((order) => ({
          orderId: order.orderId,
          filled: order.filled,
          state: order.state,
        })),
      },
    };
  }),
  exchanges: [
    { amount: 400, numerator: 1, denominator: 4 },
    { amount: 10, numerator: 1, denominator: 3 },
    { amount: 999, numerator: 7, denominator: 13 },
    { amount: 1, numerator: 100, denominator: 1 },
  ].flatMap((testCase) =>
    ROUNDING_MODES.map((rounding) => {
      const economy = new EconomyEngine({
        currencies: [createCurrency({ code: COIN }), createCurrency({ code: "GEM" })],
      });
      const { received } = exchange(
        economy,
        account(ANA, 1_000_000),
        account(memberAccount(SCOPE, "ana", "GEM"), 0),
        testCase.amount,
        testCase.numerator,
        testCase.denominator,
        { ...opts("x"), rounding },
      );
      return { ...testCase, rounding, expected: received };
    }),
  ),
});

write("billing", {
  formatVersion: FORMAT_VERSION,
  description:
    "Subscription schedules and payroll splits. A member pays for the time that passed and not a period more, however often the caller's scheduler runs.",
  subscriptions: [
    { intervalMs: DAY, amount: 100, elapsedMs: [0, DAY - 1, DAY, 3 * DAY, 10 * DAY] },
    { intervalMs: HOUR, amount: 7, elapsedMs: [HOUR / 2, HOUR, 5 * HOUR + 1] },
    { intervalMs: 7 * DAY, amount: 2_500, elapsedMs: [6 * DAY, 7 * DAY, 30 * DAY] },
  ].map((testCase) => {
    const plan = createPlan({
      planId: "p",
      payer: ANA,
      payee: BEN,
      amount: testCase.amount,
      intervalMs: testCase.intervalMs,
    });
    const subscription = startSubscription("s", plan, T0);
    return {
      ...testCase,
      expected: testCase.elapsedMs.map((elapsed) => ({
        elapsedMs: elapsed,
        due: chargesDue(subscription, T0 + elapsed),
      })),
      nextChargeAt: nextChargeAt(subscription),
    };
  }),
  payrolls: [
    { total: 1_000, count: 3, weights: null },
    { total: 10, count: 3, weights: [1, 1, 1] },
    { total: 1_000, count: 2, weights: [3, 1] },
    { total: 99_999, count: 7, weights: [5, 4, 3, 2, 1, 0, 9] },
  ].map((testCase) => {
    const recipients = Array.from({ length: testCase.count }, (_, index) =>
      memberAccount(SCOPE, `m${index}`, COIN),
    );
    const split = testCase.weights
      ? splitPayroll(testCase.total, recipients, testCase.weights)
      : splitPayroll(testCase.total, recipients);
    return {
      ...testCase,
      expected: split.map((line) => ({ owner: line.recipient.owner, amount: line.amount })),
    };
  }),
  financed: [
    { cashPrice: 120_000, rateBasisPoints: 100, instalments: 12 },
    { cashPrice: 1_200, rateBasisPoints: 0, instalments: 12 },
    { cashPrice: 999, rateBasisPoints: 1_500, instalments: 3 },
  ].map((testCase) => {
    const economy = freshEngine();
    const { plan } = financePurchase(economy, {
      planId: "f",
      buyer: ANA,
      seller: account(BEN, 0),
      cashPrice: testCase.cashPrice,
      rateBasisPoints: testCase.rateBasisPoints,
      instalments: testCase.instalments,
      ...opts("finance"),
    });
    return {
      ...testCase,
      expected: { totalPayable: totalPayable(plan), costOfCredit: costOfCredit(plan) },
    };
  }),
});

write("reporting", {
  formatVersion: FORMAT_VERSION,
  description:
    "Inequality and distribution, computed on integers. A community comparing its Gini figure with another's must be comparing the same number.",
  gini: [
    [100, 100, 100, 100],
    [50, 100, 100, 150],
    [1, 1, 1, 397],
    [0, 0, 0],
    [7],
    [],
    [5, 1, 90, 4],
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    [9_000_000_000_000, 9_000_000_000_001, 9_000_000_000_002],
  ].map((balances) => ({ balances, expected: giniPermille(balances) })),
  distributions: [
    { ana: 100, ben: 200, cai: 300 },
    { ana: 10, ben: 20, cai: 30, dee: 40 },
    { ana: 1 },
    { ana: 0, ben: 0 },
  ].map((balances) => {
    const keyed = Object.fromEntries(
      Object.entries(balances).map(([owner, amount]) => [
        accountKey(memberAccount(SCOPE, owner, COIN)),
        amount,
      ]),
    );
    const distribution = wealthDistribution(keyed);
    return {
      balances,
      expected: {
        holders: distribution.holders,
        total: distribution.total,
        median: distribution.median,
        mean: distribution.mean,
        giniPermille: distribution.giniPermille,
      },
      topHolders: topHolders(keyed, 3).map(([key, amount]) => ({ key, amount })),
    };
  }),
});

console.log("\nall shared vectors written");
