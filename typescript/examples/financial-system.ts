/**
 * A whole community economy, run for a year.
 *
 *     npx vite-node examples/financial-system.ts
 *
 * The other two examples show single operations. This one shows the parts
 * working together, because that is where the questions actually are: what does
 * the bank account hold, where did the interest come from, what is the credit
 * account supposed to say, and does the whole thing still add up at the end.
 *
 * Nothing here is stored. The world below is a map standing in for your
 * database, and every posting the library returns is applied to it the way a
 * real caller must apply one: **every line, in a single transaction**.
 *
 * Its Python twin, `python/examples/financial_system.py`, prints the same
 * numbers. That is not a coincidence and it is not decorative — if the two ever
 * diverged, that is a bug in the library, and the shared vectors would already
 * have gone red.
 */
import {
  account,
  accountBalances,
  accountKey,
  accrueDepositInterest,
  AmortisationMethod,
  amountDue,
  assertBooksClose,
  buyUnits,
  chargeFee,
  chargeSubscription,
  createCurrency,
  createDepositTerms,
  createFeeRule,
  createInstrument,
  createLoanTerms,
  createPlan,
  createTier,
  deposit,
  depositBalance,
  EconomyEngine,
  InstrumentKind,
  LoanState,
  memberAccount,
  moneySupply,
  openDeposit,
  openLoan,
  openPosition,
  quoteFee,
  repay,
  runPayroll,
  schedulePeriods,
  sellUnits,
  splitPayroll,
  startSubscription,
  statementFor,
  SystemAccount,
  systemAccount,
  topHolders,
  totalOutstanding,
  trialBalance,
  wealthDistribution,
  type Account,
  type PayrollLine,
  type Posting,
} from "../src/index.js";

const SCOPE = "guild-1";
const COIN = "COIN";
const DAY = 86_400_000;
const MONTH = 30 * DAY;
const START = 1_735_689_600_000; // 1 January 2025, as epoch milliseconds

const MEMBERS = ["ana", "ben", "cai", "dee"] as const;

// ---------------------------------------------------------------------------
// The world: your database, standing in for itself
// ---------------------------------------------------------------------------

/**
 * Balances the library never sees between calls.
 *
 * A real caller loads these from a database and writes them back inside one
 * transaction. The point of the class is that `apply` refuses to write a posting
 * whose `balanceBefore` disagrees with what the world holds — a stale read is
 * the failure this design is most exposed to, and it should be loud rather than
 * silent.
 */
class World {
  public readonly balances = new Map<string, number>();
  public readonly postings: Posting[] = [];

  public account(owner: string): Account {
    const ref = memberAccount(SCOPE, owner, COIN);
    return account(ref, this.balances.get(accountKey(ref)) ?? 0);
  }

  public system(kind: SystemAccount): Account {
    const ref = systemAccount(SCOPE, COIN, kind);
    return account(ref, this.balances.get(accountKey(ref)) ?? 0);
  }

  public apply(posting: Posting | null): void {
    if (posting === null) return;
    for (const line of posting.lines) {
      const key = accountKey(line.account);
      const current = this.balances.get(key) ?? 0;
      if (current !== line.balanceBefore) {
        throw new Error(
          `stale read on ${key}: world has ${current}, the posting expected ${line.balanceBefore}`,
        );
      }
      this.balances.set(key, line.balanceAfter);
    }
    this.postings.push(posting);
  }

  public of(owner: string): number {
    return this.balances.get(accountKey(memberAccount(SCOPE, owner, COIN))) ?? 0;
  }

  public systemBalance(kind: SystemAccount): number {
    return this.balances.get(accountKey(systemAccount(SCOPE, COIN, kind))) ?? 0;
  }
}

/** Two decimal places, from an integer. The library never formats. */
function money(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  const magnitude = Math.abs(amount);
  const whole = Math.floor(magnitude / 100);
  const fraction = magnitude % 100;
  return `${sign}${whole.toLocaleString("en-GB")}.${String(fraction).padStart(2, "0")}`;
}

const pad = (text: string, width: number) => text.padEnd(width);
const rightPad = (text: string, width: number) => text.padStart(width);

function heading(text: string): void {
  console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

const world = new World();
const engine = new EconomyEngine({
  currencies: [createCurrency({ code: COIN, minorUnits: 2 })],
});

// ---------------------------------------------------------------------------
// January: the guild pays its staff
// ---------------------------------------------------------------------------

heading("January - payroll");

// The treasury is funded by the mint, which is what "the guild issued currency"
// means on a double-entry ledger.
world.apply(
  engine.credit(world.account("treasury"), 5_000_000, {
    now: START,
    operationId: "mint-treasury",
    reason: "opening float",
    source: world.system(SystemAccount.Mint),
  }).posting,
);

const wages: PayrollLine[] = MEMBERS.map((member) => ({
  recipient: memberAccount(SCOPE, member, COIN),
  amount: 120_000,
}));
world.apply(
  runPayroll(engine, world.account("treasury"), wages, {
    now: START,
    operationId: "payroll-jan",
    reason: "January wages",
    recipients: Object.fromEntries(
      wages.map((line) => [accountKey(line.recipient), world.account(line.recipient.owner)]),
    ),
  }).posting,
);

console.log(`treasury            ${rightPad(money(world.of("treasury")), 12)}`);
for (const member of MEMBERS) {
  console.log(`${pad(member, 20)}${rightPad(money(world.of(member)), 12)}`);
}
console.log("\nOne posting, five lines. A payroll run either happens or it does not;");
console.log("half a payroll is the worst possible outcome.");

// ---------------------------------------------------------------------------
// February: ana saves, ben borrows
// ---------------------------------------------------------------------------

heading("February - a deposit and a loan");

let savings = openDeposit(
  "savings-ana",
  memberAccount(SCOPE, "ana", COIN),
  createDepositTerms({ rateBasisPoints: 50 }), // 0.5 % a month
  START + MONTH,
);
{
  const result = deposit(engine, savings, world.account("ana"), 100_000, {
    now: START + MONTH,
    operationId: "dep-ana",
    reason: "ana saves",
    bankAccount: world.system(SystemAccount.Bank),
  });
  savings = result.deposit;
  world.apply(result.booking.posting);
}

let loan = (() => {
  const result = openLoan(
    engine,
    "loan-ben",
    createLoanTerms({
      principal: 240_000,
      rateBasisPoints: 100, // 1 % a month
      periods: 10,
      method: AmortisationMethod.EqualInstalment,
      lateFeeBasisPoints: 200,
      gracePeriods: 1,
    }),
    world.account("ben"),
    { now: START + MONTH, operationId: "loan-ben", reason: "ben borrows for a workshop" },
  );
  world.apply(result.booking.posting);
  return result.loan;
})();

console.log(`ana's balance       ${rightPad(money(world.of("ana")), 12)}`);
console.log(`on deposit          ${rightPad(money(depositBalance(savings)), 12)}   (in system:bank)`);
console.log(`ben's balance       ${rightPad(money(world.of("ben")), 12)}`);
console.log(
  `ben owes            ${rightPad(money(totalOutstanding(loan)), 12)}   over ${schedulePeriods(loan.schedule)} instalments`,
);
console.log(
  `system:credit       ${rightPad(money(world.systemBalance(SystemAccount.Credit)), 12)}   <- what the guild has lent`,
);

// ---------------------------------------------------------------------------
// The year: interest, repayments, a subscription
// ---------------------------------------------------------------------------

heading("March to December - the months pass");

let subscription = startSubscription(
  "sub-cai",
  createPlan({
    planId: "guild-membership",
    payer: memberAccount(SCOPE, "cai", COIN),
    payee: memberAccount(SCOPE, "treasury", COIN),
    amount: 2_500,
    intervalMs: MONTH,
  }),
  START + MONTH,
);

for (let month = 2; month < 12; month += 1) {
  const now = START + month * MONTH;

  // The bank credits interest. It comes from the mint: in a closed economy a
  // payment nobody funds is new currency, and the posting says so.
  const accrued = accrueDepositInterest(engine, savings, 1, {
    now,
    operationId: `interest-${month}`,
    reason: "monthly interest",
    source: world.system(SystemAccount.Mint),
    bankAccount: world.system(SystemAccount.Bank),
  });
  savings = accrued.deposit;
  world.apply(accrued.booking === null ? null : accrued.booking.posting);

  // Ben pays his instalment. Capital goes back to credit, interest to fees.
  if (loan.state === LoanState.Active) {
    const result = repay(engine, loan, world.account("ben"), amountDue(loan), {
      now,
      operationId: `repay-${month}`,
      reason: `instalment ${loan.paidInstalments + 1}`,
      creditAccount: world.system(SystemAccount.Credit),
      feeAccount: world.system(SystemAccount.Fee),
    });
    loan = result.loan;
    world.apply(result.booking === null ? null : result.booking.posting);
  }

  // Cai's membership is charged for however many months have passed since the
  // last charge — once each, however often this loop runs.
  const charge = chargeSubscription(engine, subscription, world.account("cai"), {
    now,
    operationId: `sub-${month}`,
    reason: "guild membership",
    payee: world.account("treasury"),
  });
  subscription = charge.subscription;
  world.apply(charge.booking === null ? null : charge.booking.posting);
}

console.log(
  `ana on deposit      ${rightPad(money(depositBalance(savings)), 12)}   (principal ${money(savings.principal)})`,
);
console.log(`ben still owes      ${rightPad(money(totalOutstanding(loan)), 12)}`);
console.log(
  `cai paid            ${rightPad(money(subscription.totalCharged), 12)}   over ${subscription.chargesMade} months`,
);
console.log(
  `system:fee          ${rightPad(money(world.systemBalance(SystemAccount.Fee)), 12)}   <- interest earned on the loan`,
);

// ---------------------------------------------------------------------------
// December: dee buys a share, and the market takes a commission
// ---------------------------------------------------------------------------

heading("December - an investment, and what it costs");

const share = createInstrument("guild-share", InstrumentKind.Share, COIN, {
  name: "Guild share",
});
let position = openPosition(memberAccount(SCOPE, "dee", COIN), share);

// The price is ours to decide. The library will not invent one — see the README.
{
  const outcome = buyUnits(engine, share, position, world.account("dee"), 20, 2_500, {
    now: START + 11 * MONTH,
    operationId: "buy-dee",
    reason: "dee buys into the guild",
    counterparty: world.system(SystemAccount.Market),
  });
  position = outcome.position;
  world.apply(outcome.booking === null ? null : outcome.booking.posting);

  const commission = createFeeRule("market-commission", {
    // free under 100.00, then 2.5 %
    tiers: [createTier(0, 0), createTier(10_000, 250)],
  });
  const quote = quoteFee(commission, outcome.consideration);
  console.log(`dee bought          ${rightPad(String(position.units), 12)} units at ${money(2_500)} each`);
  console.log(`consideration       ${rightPad(money(outcome.consideration), 12)}`);
  console.log(
    `commission quoted   ${rightPad(money(quote.fee), 12)}   (nothing on the first ${money(10_000)}, then 2.5 %)`,
  );
  world.apply(
    chargeFee(engine, world.account("dee"), quote, {
      now: START + 11 * MONTH,
      operationId: "fee-dee",
      reason: "market commission",
      feeAccount: world.system(SystemAccount.Fee),
    })?.posting ?? null,
  );
}

// Later the same month, at a price the community set, dee sells half.
{
  const sold = sellUnits(engine, share, position, world.account("dee"), 10, 3_100, {
    now: START + 11 * MONTH + DAY,
    operationId: "sell-dee",
    reason: "dee takes some profit",
    counterparty: world.system(SystemAccount.Market),
  });
  position = sold.position;
  world.apply(sold.booking === null ? null : sold.booking.posting);
  console.log(
    `sold 10 at          ${rightPad(money(3_100), 12)}  ->  realised ${money(sold.realisedGain)}`,
  );
  console.log(
    `still holding       ${rightPad(String(position.units), 12)} units, cost basis ${money(position.costBasis)}`,
  );
}

// A year-end bonus: a fixed pot rather than fixed salaries. The shares add up to
// the pot exactly, which is not automatic — 1000 split three ways is 333 each
// and one unit left over, and somebody has to get it.
const bonus = splitPayroll(
  100_000,
  MEMBERS.map((member) => memberAccount(SCOPE, member, COIN)),
  [3, 2, 2, 1],
);
world.apply(
  runPayroll(engine, world.account("treasury"), bonus, {
    now: START + 11 * MONTH + 2 * DAY,
    operationId: "bonus-dec",
    reason: "year-end bonus",
    recipients: Object.fromEntries(
      bonus.map((line) => [accountKey(line.recipient), world.account(line.recipient.owner)]),
    ),
  }).posting,
);
console.log(`\nyear-end bonus of ${money(100_000)} split 3:2:2:1`);
for (const line of bonus) {
  console.log(`  ${pad(line.recipient.owner, 18)}${rightPad(money(line.amount), 12)}`);
}

// ---------------------------------------------------------------------------
// The year end: does it all add up?
// ---------------------------------------------------------------------------

heading("Year end - the books");

const result = trialBalance(world.postings);
console.log(`postings            ${rightPad(String(result.postings), 12)}`);
console.log(
  `sum of every line   ${rightPad(String(result.total), 12)}   <- zero, or something is wrong`,
);
console.log(`booked twice        ${rightPad(String(result.duplicates.length), 12)}`);
assertBooksClose(world.postings);

const supply = moneySupply(world.postings, SCOPE, COIN);
console.log(`\nissued              ${rightPad(money(supply.issued), 12)}`);
console.log(`retired             ${rightPad(money(supply.retired), 12)}`);
console.log(`circulating         ${rightPad(money(supply.circulating), 12)}`);
console.log(`  held by members   ${rightPad(money(supply.heldByMembers), 12)}`);
console.log(`  held by system    ${rightPad(money(supply.heldBySystem), 12)}`);

console.log("\nsystem accounts");
for (const kind of [
  SystemAccount.Mint,
  SystemAccount.Bank,
  SystemAccount.Credit,
  SystemAccount.Fee,
  SystemAccount.Market,
]) {
  console.log(`  ${pad(kind, 20)}${rightPad(money(world.systemBalance(kind)), 12)}`);
}

for (const [key, balance] of Object.entries(accountBalances(world.postings))) {
  if ((world.balances.get(key) ?? 0) !== balance) {
    throw new Error(`the world and the postings disagree about ${key}`);
  }
}
console.log("\nEvery balance in the world matches what the postings imply.");
console.log("That is the check to run nightly: if the two ever disagree, one of them");
console.log("is wrong, and you now know to look.");

const distribution = wealthDistribution(Object.fromEntries(world.balances));
console.log(`\nholders             ${rightPad(String(distribution.holders), 12)}`);
console.log(`median              ${rightPad(money(distribution.median), 12)}`);
console.log(`mean                ${rightPad(money(distribution.mean), 12)}`);
console.log(
  `gini (permille)     ${rightPad(String(distribution.giniPermille), 12)}   0 = equal, 1000 = one member holds everything`,
);

console.log("\ntop holders");
for (const [key, balance] of topHolders(Object.fromEntries(world.balances), 3)) {
  console.log(`  ${pad(key, 28)}${rightPad(money(balance), 12)}`);
}

console.log("\nben's statement");
const statement = statementFor(world.postings, memberAccount(SCOPE, "ben", COIN));
for (const line of statement.lines.slice(0, 4)) {
  console.log(
    `  ${pad(line.kind, 20)}${rightPad(money(line.delta), 12)}   -> ${money(line.balanceAfter)}`,
  );
}
console.log(`  ... ${statement.lines.length - 4} more`);
console.log(
  `  in ${money(statement.totalIn)}, out ${money(statement.totalOut)}, closing ${money(statement.closingBalance)}`,
);

heading("What this example is really showing");

console.log(`Six subsystems ran against one ledger for a year: payroll, banking, credit,
billing, investments and fees. Nobody had to reconcile them against each other,
because they were never separate to begin with -- every one of them produced a
posting whose lines sum to zero, and the trial balance above is the proof.

Three numbers are worth looking at twice:

  system:credit reached zero as the loan was repaid. It is the amount the guild
  currently has lent out, and it is checkable against the open loans.

  system:fee holds exactly the interest and commission earned. Interest is
  revenue, not returned capital, and keeping them apart is why the credit
  account means anything.

  system:mint, negated, is every unit of currency that has ever existed here.
  Nothing appeared from nowhere. If it had, the trial balance would say so.`);
