import { describe, expect, it } from "vitest";
import {
  account,
  accountBalances,
  accountKey,
  accrueDepositInterest,
  AmortisationMethod,
  amountDue,
  assertBooksClose,
  buyUnits,
  chargeSubscription,
  createCurrency,
  createDepositTerms,
  createFeeRule,
  createInstrument,
  createLoanTerms,
  createOrder,
  createPlan,
  deposit,
  distributeDividend,
  EconomyEngine,
  EconomyError,
  exchange,
  FeeMode,
  InstrumentKind,
  isBalanced,
  LoanState,
  matchOrder,
  memberAccount,
  moneySupply,
  openDeposit,
  openLoan,
  openPosition,
  OrderSide,
  quoteFee,
  repay,
  Rounding,
  runPayroll,
  sellUnits,
  settleFill,
  splitFee,
  splitPayroll,
  startSubscription,
  SystemAccount,
  systemAccount,
  totalOutstanding,
  withdraw,
  writeOff,
  type Loan,
  type PayrollLine,
  type Position,
  type Posting,
} from "../src/index.js";
import { COIN, engine, MEMBERS, NOW, Rng, SCOPE, World } from "./support/world.js";

/**
 * The mirror of `python/tests/test_invariants_financial.py`.
 *
 * `invariants.test.ts` proves the engine itself conserves currency. Banking,
 * credit, investments, markets and billing all book through that same engine,
 * so they inherit the guarantee — but each of them decides *which* accounts a
 * posting touches, and getting that wrong is exactly how a subsystem quietly
 * issues currency nobody minted. These runs prove they do not.
 */

const BANK = SystemAccount.Bank;
const CREDIT = SystemAccount.Credit;
const FEE = SystemAccount.Fee;
const MARKET = SystemAccount.Market;
const MINT = SystemAccount.Mint;

const keyOf = (kind: SystemAccount) => accountKey(systemAccount(SCOPE, COIN, kind));

describe("banking", () => {
  it("never creates or destroys currency", () => {
    // Money on deposit is money that moved, not money that vanished.
    for (let seed = 1; seed <= 200; seed += 1) {
      const rng = new Rng(seed);
      const world = new World(MEMBERS, 50_000);
      const economy = engine();
      const grandBefore = world.grandTotal();

      const member = rng.pick(MEMBERS);
      let savings = openDeposit(
        `d${seed}`,
        memberAccount(SCOPE, member, COIN),
        createDepositTerms({
          rateBasisPoints: rng.int(0, 500),
          minimumBalance: rng.int(0, 100),
        }),
        NOW,
      );

      for (let step = 0; step < 20; step += 1) {
        const options = {
          now: NOW + step * 3_600_000,
          operationId: `d${seed}-${step}`,
          reason: "random",
        };
        try {
          const action = rng.int(0, 2);
          if (action === 0) {
            const result = deposit(economy, savings, world.account(member), rng.int(1, 2_000), {
              ...options,
              bankAccount: world.system(BANK),
            });
            savings = result.deposit;
            world.apply(result.booking.posting);
          } else if (action === 1) {
            const result = withdraw(economy, savings, world.account(member), rng.int(1, 2_000), {
              ...options,
              bankAccount: world.system(BANK),
            });
            savings = result.deposit;
            world.apply(result.booking.posting);
          } else {
            const result = accrueDepositInterest(economy, savings, rng.int(1, 4), {
              ...options,
              source: world.system(MINT),
              bankAccount: world.system(BANK),
            });
            savings = result.deposit;
            if (result.booking !== null) world.apply(result.booking.posting);
          }
        } catch (error) {
          if (error instanceof EconomyError) continue;
          throw error;
        }

        // The bank holds exactly what is on deposit, to the unit. A drift here
        // is a subsystem telling a member one number and the books another.
        expect(world.balances.get(keyOf(BANK)) ?? 0, `seed ${seed}, step ${step}`).toBe(
          savings.principal + savings.accruedInterest,
        );
      }

      expect(world.grandTotal(), `seed ${seed}`).toBe(grandBefore);
    }
  });
});

describe("credit", () => {
  it("brings the credit account back to zero on a loan repaid in full", () => {
    // Interest is new currency and ends up as fee revenue; the capital is not,
    // and must come back to the account it left. Mix the two up and the credit
    // account keeps a balance for a loan nobody owes any more.
    for (let seed = 1; seed <= 200; seed += 1) {
      const rng = new Rng(seed);
      const world = new World(MEMBERS, 5_000_000);
      const economy = engine();
      const member = rng.pick(MEMBERS);
      const grandBefore = world.grandTotal();

      const start = openLoan(
        economy,
        `L${seed}`,
        createLoanTerms({
          principal: rng.int(100, 500_000),
          rateBasisPoints: rng.int(0, 1_500),
          periods: rng.int(1, 24),
          method: rng.pick([
            AmortisationMethod.EqualInstalment,
            AmortisationMethod.EqualPrincipal,
            AmortisationMethod.InterestOnly,
          ]),
        }),
        world.account(member),
        { now: NOW, operationId: `L${seed}-open`, reason: "random loan" },
      );
      world.apply(start.booking.posting);

      let loan: Loan = start.loan;
      let step = 0;
      while (
        (loan.state === LoanState.Active || loan.state === LoanState.InArrears) &&
        step < 80
      ) {
        step += 1;
        const result = repay(economy, loan, world.account(member), amountDue(loan), {
          now: NOW + step * 86_400_000,
          operationId: `L${seed}-${step}`,
          reason: "random repayment",
          creditAccount: world.system(CREDIT),
          feeAccount: world.system(FEE),
        });
        loan = result.loan;
        if (result.booking !== null) world.apply(result.booking.posting);
      }

      expect(loan.state, `seed ${seed}`).toBe(LoanState.Settled);
      expect(world.balances.get(keyOf(CREDIT)) ?? 0, `seed ${seed}`).toBe(0);
      // Every unit of interest the schedule charged is fee revenue, and not one
      // unit more: the capital went back to credit.
      expect(world.balances.get(keyOf(FEE)) ?? 0, `seed ${seed}`).toBe(
        loan.schedule.totalInterest,
      );
      expect(world.grandTotal(), `seed ${seed}`).toBe(grandBefore);
    }
  });

  it("treats a write-off as issuance rather than destruction", () => {
    // The borrower still has what they were lent. Somebody minted it. Sending
    // the loss to the sink instead would leave the scope reporting a negative
    // amount in circulation, which is not a thing.
    for (let seed = 1; seed <= 120; seed += 1) {
      const rng = new Rng(seed);
      const world = new World(MEMBERS, 1_000_000);
      const economy = engine();
      const member = rng.pick(MEMBERS);
      const principal = rng.int(1_000, 200_000);

      const start = openLoan(
        economy,
        `W${seed}`,
        createLoanTerms({
          principal,
          rateBasisPoints: rng.int(0, 1_000),
          periods: rng.int(2, 12),
        }),
        world.account(member),
        { now: NOW, operationId: `W${seed}-open`, reason: "random loan" },
      );
      world.apply(start.booking.posting);
      let loan: Loan = start.loan;

      if (rng.int(0, 1) === 1) {
        const result = repay(economy, loan, world.account(member), amountDue(loan), {
          now: NOW + 86_400_000,
          operationId: `W${seed}-r`,
          reason: "one payment",
          creditAccount: world.system(CREDIT),
          feeAccount: world.system(FEE),
        });
        loan = result.loan;
        if (result.booking !== null) world.apply(result.booking.posting);
      }

      const lost = loan.principalOutstanding;
      const written = writeOff(economy, loan, {
        now: NOW + 200 * 86_400_000,
        operationId: `W${seed}-off`,
        reason: "gave up",
        creditAccount: world.system(CREDIT),
        mintAccount: world.system(MINT),
      });
      if (written.booking !== null) {
        world.apply(written.booking.posting);
        expect(written.booking.posting.amount, `seed ${seed}`).toBe(lost);
      }

      expect(totalOutstanding(written.loan), `seed ${seed}`).toBe(0);
      expect(world.balances.get(keyOf(CREDIT)) ?? 0, `seed ${seed}`).toBe(0);
      // What was lent and never came back is permanently in circulation, and
      // the mint's balance says exactly that.
      expect(-(world.balances.get(keyOf(MINT)) ?? 0), `seed ${seed}`).toBe(lost);
      expect(lost, `seed ${seed}`).toBeLessThanOrEqual(principal);
    }
  });
});

describe("markets", () => {
  it("moves only what a settled fill says", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rng = new Rng(seed);
      const world = new World(MEMBERS, 100_000);
      const economy = engine();
      const grandBefore = world.grandTotal();

      const buyer = rng.pick(MEMBERS);
      const seller = rng.pick(MEMBERS.filter((member) => member !== buyer));
      const price = rng.int(1, 500);

      const resting = createOrder(
        `s${seed}`,
        memberAccount(SCOPE, seller, COIN),
        "ore",
        OrderSide.Sell,
        price,
        rng.int(1, 50),
        NOW,
      );
      const incoming = createOrder(
        `b${seed}`,
        memberAccount(SCOPE, buyer, COIN),
        "ore",
        OrderSide.Buy,
        price + rng.int(0, 100),
        rng.int(1, 50),
        NOW + 1,
      );
      const result = matchOrder(incoming, [resting]);

      result.fills.forEach((fill, index) => {
        // The resting order named the price, so a fill can never cost the buyer
        // more than their own limit.
        expect(fill.unitPrice).toBeLessThanOrEqual(incoming.unitPrice);
        expect(fill.consideration).toBe(fill.quantity * fill.unitPrice);
        try {
          const booking = settleFill(
            economy,
            fill,
            world.account(buyer),
            world.account(seller),
            { now: NOW + 2, operationId: `f${seed}-${index}`, reason: "random fill" },
          );
          world.apply(booking.posting);
        } catch (error) {
          if (!(error instanceof EconomyError)) throw error;
        }
      });

      // A fill is a transfer: two members, one currency, nothing issued.
      expect(world.grandTotal(), `seed ${seed}`).toBe(grandBefore);
      const filled = result.fills.reduce((total, fill) => total + fill.quantity, 0);
      expect(filled).toBeLessThanOrEqual(Math.min(incoming.quantity, resting.quantity));
    }
  });

  it("retires one currency and issues the other on an exchange", () => {
    // Two currencies, two postings, and both of them on the books.
    for (let seed = 1; seed <= 200; seed += 1) {
      const rng = new Rng(seed);
      const economy = new EconomyEngine({
        currencies: [createCurrency({ code: COIN }), createCurrency({ code: "GEM" })],
      });
      const member = rng.pick(MEMBERS);
      const balance = rng.int(1, 100_000);
      const amount = rng.int(1, balance);

      let swapped;
      try {
        swapped = exchange(
          economy,
          account(memberAccount(SCOPE, member, COIN), balance),
          account(memberAccount(SCOPE, member, "GEM"), 0),
          amount,
          rng.int(1, 100),
          rng.int(1, 100),
          { now: NOW, operationId: `x${seed}`, reason: "random exchange" },
        );
      } catch (error) {
        if (error instanceof EconomyError) continue;
        throw error;
      }

      expect(isBalanced(swapped.sold.posting)).toBe(true);
      expect(isBalanced(swapped.bought.posting)).toBe(true);
      expect(swapped.sold.posting.currency).toBe(COIN);
      expect(swapped.bought.posting.currency).toBe("GEM");
      // Two rows, two ids: a shared one would make the second insert fail for a
      // caller doing exactly what the docs ask.
      expect(swapped.sold.posting.operationId).not.toBe(swapped.bought.posting.operationId);
      expect(swapped.sold.balances[`${SCOPE}/${member}/${COIN}`]).toBe(balance - amount);
      expect(swapped.bought.balances[`${SCOPE}/${member}/GEM`]).toBe(swapped.received);
      expect(swapped.received).toBeGreaterThan(0);
    }
  });
});

describe("fees and shares", () => {
  it("never takes more than the payment it comes out of", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const rng = new Rng(seed);
      const rule = createFeeRule(`r${seed}`, {
        mode: rng.pick([FeeMode.OnTop, FeeMode.Inclusive]),
        flat: rng.int(0, 200),
        basisPoints: rng.int(0, 2_000),
        minimum: rng.int(0, 50),
        maximum: rng.int(50, 10_000),
        rounding: rng.pick([Rounding.Down, Rounding.Up, Rounding.HalfUp, Rounding.HalfEven]),
      });
      const amount = rng.int(0, 1_000_000);
      const quote = quoteFee(rule, amount);

      expect(quote.fee, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(quote.payerPays).toBeGreaterThanOrEqual(quote.recipientReceives);
      expect(quote.recipientReceives).toBeGreaterThanOrEqual(0);
      if (quote.mode === FeeMode.Inclusive) {
        // An inclusive fee comes out of the amount, so it can take all of it and
        // never more: the recipient gets nothing, not a debt.
        expect(quote.fee).toBeLessThanOrEqual(amount);
        expect(quote.payerPays).toBe(amount);
        expect(quote.recipientReceives + quote.fee).toBe(amount);
      } else {
        expect(quote.payerPays).toBe(amount + quote.fee);
        expect(quote.recipientReceives).toBe(amount);
      }
    }
  });

  it("adds every share of anything up to the whole", () => {
    // Fees, dividends and payroll all split a pot. None may lose a unit.
    for (let seed = 1; seed <= 400; seed += 1) {
      const rng = new Rng(seed);
      const total = rng.int(0, 1_000_000);
      const count = rng.int(1, 8);
      const weights = Array.from({ length: count }, () => rng.int(0, 100));
      if (weights.reduce((a, b) => a + b, 0) === 0) weights[0] = 1;

      expect(splitFee(total, weights).reduce((a, b) => a + b, 0), `seed ${seed}`).toBe(total);

      const recipients = Array.from({ length: count }, (_, index) =>
        memberAccount(SCOPE, `m${index}`, COIN),
      );
      expect(
        splitPayroll(total, recipients, weights).reduce((sum, line) => sum + line.amount, 0),
        `seed ${seed}`,
      ).toBe(total);

      const positions: Position[] = recipients
        .map((holder, index) => ({
          holder,
          instrumentId: "s",
          units: weights[index]!,
          costBasis: 0,
          realisedGain: 0,
        }))
        .filter((held) => held.units > 0);
      if (positions.length > 0) {
        expect(
          distributeDividend(positions, total).reduce((sum, payout) => sum + payout.amount, 0),
          `seed ${seed}`,
        ).toBe(total);
      }
    }
  });
});

describe("investments", () => {
  it("realises exactly what a position made", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const rng = new Rng(seed);
      const economy = engine();
      const instrument = createInstrument("share", InstrumentKind.Share, COIN);
      const holder = memberAccount(SCOPE, rng.pick(MEMBERS), COIN);
      let position = openPosition(holder, instrument);

      let spent = 0;
      let received = 0;
      for (let step = 0; step < 10; step += 1) {
        const price = rng.int(0, 1_000);
        const units = rng.int(1, 100);
        const options = {
          now: NOW + step,
          operationId: `i${seed}-${step}`,
          reason: "random trade",
        };
        try {
          if (rng.int(0, 1) === 0 || position.units === 0) {
            const outcome = buyUnits(
              economy,
              instrument,
              position,
              account(holder, 100_000_000),
              units,
              price,
              options,
            );
            spent += outcome.consideration;
            position = outcome.position;
          } else {
            const outcome = sellUnits(
              economy,
              instrument,
              position,
              account(holder, 0),
              Math.min(units, position.units),
              price,
              options,
            );
            received += outcome.consideration;
            position = outcome.position;
          }
        } catch (error) {
          if (error instanceof EconomyError) continue;
          throw error;
        }
        expect(position.costBasis, `seed ${seed}, step ${step}`).toBeGreaterThanOrEqual(0);
        expect(position.costBasis).toBeLessThanOrEqual(spent);
      }

      if (position.units > 0) {
        const outcome = sellUnits(
          economy,
          instrument,
          position,
          account(holder, 0),
          position.units,
          rng.int(0, 1_000),
          { now: NOW + 100, operationId: `i${seed}-final`, reason: "close out" },
        );
        received += outcome.consideration;
        position = outcome.position;
      }

      // Everything sold, so nothing is left: no stranded cost, and the gain is
      // exactly what came back minus what went out.
      expect(position.units, `seed ${seed}`).toBe(0);
      expect(position.costBasis, `seed ${seed}`).toBe(0);
      expect(position.realisedGain, `seed ${seed}`).toBe(received - spent);
    }
  });
});

describe("billing", () => {
  it("charges each interval exactly once", () => {
    // A scheduler running every minute must not bill every minute.
    for (let seed = 1; seed <= 200; seed += 1) {
      const rng = new Rng(seed);
      const world = new World(MEMBERS, 10_000_000);
      const economy = engine();
      const payer = rng.pick(MEMBERS);
      const payee = rng.pick(MEMBERS.filter((member) => member !== payer));
      const grandBefore = world.grandTotal();

      const interval = rng.int(1, 24) * 3_600_000;
      const amount = rng.int(1, 500);
      let subscription = startSubscription(
        `s${seed}`,
        createPlan({
          planId: `p${seed}`,
          payer: memberAccount(SCOPE, payer, COIN),
          payee: memberAccount(SCOPE, payee, COIN),
          amount,
          intervalMs: interval,
        }),
        NOW,
      );

      let elapsed = 0;
      for (let step = 0; step < 30; step += 1) {
        elapsed += rng.int(0, interval);
        try {
          const result = chargeSubscription(economy, subscription, world.account(payer), {
            now: NOW + elapsed,
            operationId: `c${seed}-${step}`,
            reason: "random charge",
            payee: world.account(payee),
          });
          subscription = result.subscription;
          if (result.booking !== null) world.apply(result.booking.posting);
          expect(result.amount).toBe(result.charges * amount);
        } catch (error) {
          if (error instanceof EconomyError) continue;
          throw error;
        }
      }

      // However often the scheduler ran, the member paid for the time that
      // passed and not a period more.
      expect(subscription.chargesMade, `seed ${seed}`).toBe(Math.floor(elapsed / interval));
      expect(subscription.totalCharged).toBe(subscription.chargesMade * amount);
      expect(world.grandTotal(), `seed ${seed}`).toBe(grandBefore);
    }
  });

  it("pays everybody or nobody in a payroll run", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rng = new Rng(seed);
      const world = new World(MEMBERS, 100_000);
      const economy = engine();
      const employerMember = rng.pick(MEMBERS);
      const recipients = MEMBERS.filter((member) => member !== employerMember);
      const grandBefore = world.grandTotal();

      const lines: PayrollLine[] = recipients.map((member) => ({
        recipient: memberAccount(SCOPE, member, COIN),
        amount: rng.int(1, 40_000),
      }));
      const employer = world.account(employerMember);
      const total = lines.reduce((sum, line) => sum + line.amount, 0);

      let booking;
      try {
        booking = runPayroll(economy, employer, lines, {
          now: NOW,
          operationId: `pay${seed}`,
          reason: "random payroll",
          recipients: Object.fromEntries(
            lines.map((line) => [accountKey(line.recipient), world.account(line.recipient.owner)]),
          ),
        });
      } catch (error) {
        if (!(error instanceof EconomyError)) throw error;
        // Refused for want of funds -- and nobody was paid, which is the whole
        // point of the run being one posting.
        expect(employer.balance, `seed ${seed}`).toBeLessThan(total);
        continue;
      }

      world.apply(booking.posting);
      expect(isBalanced(booking.posting)).toBe(true);
      expect(booking.posting.amount, `seed ${seed}`).toBe(total);
      expect(booking.posting.lines).toHaveLength(lines.length + 1);
      expect(world.grandTotal(), `seed ${seed}`).toBe(grandBefore);
    }
  });
});

describe("the whole economy", () => {
  it("closes the books across every subsystem at once", () => {
    // Each subsystem above is checked on its own. This one runs them together
    // and then asks the reporting module the questions that matter: does the
    // ledger close, was anything booked twice, and does the money supply agree
    // with what everybody is actually holding.
    for (let seed = 1; seed <= 120; seed += 1) {
      const rng = new Rng(seed);
      const world = new World(MEMBERS, 200_000);
      const economy = engine();
      const postings: Posting[] = [];
      // What everybody started with, which no posting accounts for: the replay
      // below checks the movement, not the opening position.
      const opening = new Map(world.balances);

      const member = rng.pick(MEMBERS);
      const holder = memberAccount(SCOPE, member, COIN);
      let savings = openDeposit(
        `d${seed}`,
        holder,
        createDepositTerms({ rateBasisPoints: 200 }),
        NOW,
      );
      const instrument = createInstrument("share", InstrumentKind.Share, COIN);
      let position = openPosition(holder, instrument);
      let loan: Loan | null = null;

      for (let step = 0; step < 40; step += 1) {
        const options = {
          now: NOW + step * 86_400_000,
          operationId: `all${seed}-${step}`,
          reason: "random",
        };
        try {
          const action = rng.int(0, 6);
          if (action === 0) {
            const result = economy.credit(world.account(member), rng.int(1, 5_000), {
              ...options,
              source: world.system(MINT),
            });
            world.apply(result.posting);
            postings.push(result.posting);
          } else if (action === 1) {
            const result = deposit(economy, savings, world.account(member), rng.int(1, 5_000), {
              ...options,
              bankAccount: world.system(BANK),
            });
            savings = result.deposit;
            world.apply(result.booking.posting);
            postings.push(result.booking.posting);
          } else if (action === 2) {
            const result = withdraw(economy, savings, world.account(member), rng.int(1, 5_000), {
              ...options,
              bankAccount: world.system(BANK),
            });
            savings = result.deposit;
            world.apply(result.booking.posting);
            postings.push(result.booking.posting);
          } else if (action === 3 && loan === null) {
            const result = openLoan(
              economy,
              `L${seed}`,
              createLoanTerms({
                principal: rng.int(1_000, 50_000),
                rateBasisPoints: rng.int(0, 800),
                periods: rng.int(1, 12),
              }),
              world.account(member),
              options,
            );
            loan = result.loan;
            world.apply(result.booking.posting);
            postings.push(result.booking.posting);
          } else if (action === 4 && loan !== null) {
            const result = repay(economy, loan, world.account(member), amountDue(loan), {
              ...options,
              creditAccount: world.system(CREDIT),
              feeAccount: world.system(FEE),
            });
            if (result.booking !== null) {
              world.apply(result.booking.posting);
              postings.push(result.booking.posting);
            }
            loan =
              result.loan.state === LoanState.Active || result.loan.state === LoanState.InArrears
                ? result.loan
                : null;
          } else if (action === 5) {
            const outcome = buyUnits(
              economy,
              instrument,
              position,
              world.account(member),
              rng.int(1, 20),
              rng.int(1, 200),
              { ...options, counterparty: world.system(MARKET) },
            );
            position = outcome.position;
            if (outcome.booking !== null) {
              world.apply(outcome.booking.posting);
              postings.push(outcome.booking.posting);
            }
          } else if (position.units > 0) {
            const outcome = sellUnits(
              economy,
              instrument,
              position,
              world.account(member),
              rng.int(1, position.units),
              rng.int(1, 200),
              { ...options, counterparty: world.system(MARKET) },
            );
            position = outcome.position;
            if (outcome.booking !== null) {
              world.apply(outcome.booking.posting);
              postings.push(outcome.booking.posting);
            }
          }
        } catch (error) {
          if (error instanceof EconomyError) continue;
          throw error;
        }
      }

      expect(() => assertBooksClose(postings)).not.toThrow();

      // Replaying the history must reproduce the balances the caller stored
      // along the way. If the two ever disagree, one of them is wrong -- and
      // the operator now knows to look.
      for (const [key, moved] of Object.entries(accountBalances(postings))) {
        expect(world.balances.get(key) ?? 0, `seed ${seed}, ${key}`).toBe(
          (opening.get(key) ?? 0) + moved,
        );
      }

      const supply = moneySupply(postings, SCOPE, COIN);
      expect(supply.circulating, `seed ${seed}`).toBe(supply.heldByMembers + supply.heldBySystem);
      expect(supply.circulating, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      // Nothing leaked: every posting moved currency between accounts the world
      // knows about, so the sum across all of them never moved.
      let openingTotal = 0;
      for (const value of opening.values()) openingTotal += value;
      expect(world.grandTotal(), `seed ${seed}`).toBe(openingTotal);
    }
  });
});
