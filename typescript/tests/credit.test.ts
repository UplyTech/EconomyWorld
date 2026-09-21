import { describe, expect, it } from "vitest";
import {
  account,
  accountKey,
  AmortisationMethod,
  amountDue,
  assertWithinCreditLimit,
  chargeLateFee,
  createCurrency,
  createLoanTerms,
  CreditLimitError,
  EconomyEngine,
  isInArrears,
  LoanState,
  LoanStateError,
  memberAccount,
  nextInstalment,
  openLoan,
  PostingKind,
  repay,
  schedulePeriods,
  settleEarly,
  settlementQuote,
  SystemAccount,
  systemAccount,
  totalOutstanding,
  writeOff,
  type Loan,
  type LoanTerms,
  type Posting,
} from "../src/index.js";

/** The mirror of `python/tests/test_credit.py`. */

const NOW = 1_700_000_000_000;

function engine(): EconomyEngine {
  return new EconomyEngine({ currencies: [createCurrency({ code: "COIN" })] });
}

function ref(name = "ben") {
  return memberAccount("g1", name, "COIN");
}

function terms(overrides: Partial<LoanTerms> = {}): LoanTerms {
  return createLoanTerms({
    principal: 120_000,
    rateBasisPoints: 100,
    periods: 12,
    ...overrides,
  });
}

function opened(economy: EconomyEngine, overrides: Partial<LoanTerms> = {}) {
  return openLoan(economy, "L", terms(overrides), account(ref(), 0), {
    now: NOW,
    operationId: "o",
    reason: "loan",
  });
}

const CREDIT = accountKey(systemAccount("g1", "COIN", SystemAccount.Credit));
const FEE = accountKey(systemAccount("g1", "COIN", SystemAccount.Fee));
const MINT = accountKey(systemAccount("g1", "COIN", SystemAccount.Mint));

describe("opening a loan", () => {
  it("pays out of the credit account", () => {
    // The credit account's balance is the scope's outstanding lending, with a
    // minus sign, and that number can be checked against the open loans.
    const { booking, loan } = opened(engine());
    expect(booking.posting.kind).toBe(PostingKind.LoanDisbursement);
    expect(booking.balances[CREDIT]).toBe(-120_000);
    expect(booking.balances[accountKey(ref())]).toBe(120_000);
    expect(loan.state).toBe(LoanState.Active);
  });

  it("computes the schedule once and stores it", () => {
    const { loan } = opened(engine());
    expect(schedulePeriods(loan.schedule)).toBe(12);
    expect(loan.principalOutstanding).toBe(120_000);
    expect(loan.interestOutstanding).toBe(loan.schedule.totalInterest);
    expect(totalOutstanding(loan)).toBe(loan.schedule.totalPaid);
  });

  it("leaves the credit limit to the caller", () => {
    assertWithinCreditLimit(terms(), 0, null);
    assertWithinCreditLimit(terms(), 0, 200_000);
    expect(() => assertWithinCreditLimit(terms(), 100_000, 200_000)).toThrow(CreditLimitError);
  });
});

describe("repayment", () => {
  it("settles exactly when every instalment is paid", () => {
    const economy = engine();
    let { loan } = opened(economy);
    const borrower = account(ref(), 500_000);
    let paid = 0;
    for (let index = 0; index < 12; index += 1) {
      const due = amountDue(loan);
      loan = repay(economy, loan, borrower, due, {
        now: NOW,
        operationId: `r${index}`,
        reason: "instalment",
      }).loan;
      paid += due;
    }
    expect(loan.state).toBe(LoanState.Settled);
    expect(totalOutstanding(loan)).toBe(0);
    expect(paid).toBe(120_000 + loan.schedule.totalInterest);
  });

  it("always splits a payment into parts that add up to it", () => {
    // The line a member reads on their statement. If it does not add up they
    // will notice, and they will be right.
    const economy = engine();
    let loan = chargeLateFee(opened(economy, { lateFeeBasisPoints: 500 }).loan, 1);
    const borrower = account(ref(), 500_000);
    for (let index = 0; index < 5; index += 1) {
      const due = Math.min(amountDue(loan), 4_000);
      const outcome = repay(economy, loan, borrower, due, {
        now: NOW,
        operationId: `r${index}`,
        reason: "part",
      });
      expect(outcome.toFees + outcome.toInterest + outcome.toPrincipal).toBe(due);
      loan = outcome.loan;
    }
  });

  it("pays fees first, then interest, then principal", () => {
    const economy = engine();
    const loan = chargeLateFee(opened(economy, { lateFeeBasisPoints: 500 }).loan, 1);
    const fees = loan.feesOutstanding;
    expect(fees).toBeGreaterThan(0);
    const outcome = repay(economy, loan, account(ref(), 500_000), fees + 10, {
      now: NOW,
      operationId: "r",
      reason: "x",
    });
    expect(outcome.toFees).toBe(fees);
    expect(outcome.toInterest).toBe(10);
    expect(outcome.toPrincipal).toBe(0);
  });

  it("sends capital and revenue to different accounts", () => {
    // Sending the whole payment to the credit account would leave it positive
    // by exactly the interest once every loan had been repaid, and a number
    // that means "currency currently lent out" would mean nothing at all.
    const economy = engine();
    const { loan } = opened(economy);
    const outcome = repay(economy, loan, account(ref(), 500_000), amountDue(loan), {
      now: NOW,
      operationId: "r",
      reason: "x",
    });
    expect(outcome.booking!.posting.lines).toHaveLength(3);
    expect(outcome.booking!.balances[CREDIT]).toBe(outcome.toPrincipal);
    expect(outcome.booking!.balances[FEE]).toBe(outcome.toInterest);
  });

  it("brings the credit account back to zero over a whole loan", () => {
    const economy = engine();
    const start = opened(economy);
    let loan = start.loan;
    const postings: Posting[] = [start.booking.posting];
    const borrower = account(ref(), 500_000);
    for (let index = 0; index < 12; index += 1) {
      const outcome = repay(economy, loan, borrower, amountDue(loan), {
        now: NOW,
        operationId: `r${index}`,
        reason: "x",
      });
      loan = outcome.loan;
      postings.push(outcome.booking!.posting);
    }

    const balances: Record<string, number> = {};
    for (const posting of postings) {
      for (const line of posting.lines) {
        const key = accountKey(line.account);
        balances[key] = (balances[key] ?? 0) + line.delta;
      }
    }
    expect(balances[CREDIT]).toBe(0); // lent 120,000, got 120,000 back
    expect(balances[FEE]).toBe(loan.schedule.totalInterest);
    expect(Object.values(balances).reduce((a, b) => a + b, 0)).toBe(0); // and the books close
  });

  it("does not advance the schedule on a part payment", () => {
    const economy = engine();
    const { loan } = opened(economy);
    const due = amountDue(loan);
    const first = repay(economy, loan, account(ref(), 500_000), due - 1, {
      now: NOW,
      operationId: "r",
      reason: "x",
    });
    expect(first.instalmentsCleared).toBe(0);
    expect(first.loan.partPaid).toBe(due - 1);
    // One more unit completes it.
    const second = repay(economy, first.loan, account(ref(), 500_000), 1, {
      now: NOW,
      operationId: "r2",
      reason: "x",
    });
    expect(second.instalmentsCleared).toBe(1);
  });

  it("refuses an overpayment rather than crediting it", () => {
    const economy = engine();
    const { loan } = opened(economy);
    expect(() =>
      repay(economy, loan, account(ref(), 500_000), totalOutstanding(loan) + 1, {
        now: NOW,
        operationId: "r",
        reason: "x",
      }),
    ).toThrow(LoanStateError);
  });

  it("takes nothing more once the loan is closed", () => {
    const economy = engine();
    const { loan } = opened(economy);
    const settled = settleEarly(economy, loan, account(ref(), 500_000), {
      now: NOW,
      operationId: "s",
      reason: "x",
    }).loan;
    expect(() =>
      repay(economy, settled, account(ref(), 500_000), 1, {
        now: NOW,
        operationId: "r",
        reason: "x",
      }),
    ).toThrow(LoanStateError);
  });

  it("lets only the borrower repay", () => {
    const economy = engine();
    const { loan } = opened(economy);
    expect(() =>
      repay(economy, loan, account(memberAccount("g1", "someone-else", "COIN"), 500_000), 100, {
        now: NOW,
        operationId: "r",
        reason: "x",
      }),
    ).toThrow(LoanStateError);
  });
});

describe("early settlement", () => {
  it("quotes the outstanding balance when there is no rebate", () => {
    const { loan } = opened(engine());
    expect(settlementQuote(loan, 0)).toBe(totalOutstanding(loan));
  });

  it("forgives future interest only", () => {
    const economy = engine();
    let { loan } = opened(economy);
    const borrower = account(ref(), 500_000);
    for (let index = 0; index < 3; index += 1) {
      loan = repay(economy, loan, borrower, amountDue(loan), {
        now: NOW,
        operationId: `r${index}`,
        reason: "x",
      }).loan;
    }

    const full = settlementQuote(loan, 0);
    const half = settlementQuote(loan, 5000);
    expect(half).toBeLessThan(full);
    // The interest inside the instalment already reached is still owed.
    const future = loan.schedule.instalments
      .slice(loan.paidInstalments + 1)
      .reduce((total, row) => total + row.interest, 0);
    expect(full - half).toBe(Math.floor(future / 2));
  });

  it("closes the loan and repays the capital in full", () => {
    const economy = engine();
    const { loan } = opened(economy);
    const outcome = settleEarly(economy, loan, account(ref(), 500_000), {
      now: NOW,
      operationId: "s",
      reason: "x",
      rebateBasisPoints: 10_000,
    });
    expect(outcome.settled).toBe(true);
    expect(outcome.loan.state).toBe(LoanState.Settled);
    expect(totalOutstanding(outcome.loan)).toBe(0);
    // A full rebate forgives every unreached period's interest; the capital is
    // still repaid in full.
    expect(outcome.toPrincipal).toBe(120_000);
  });

  it("never rebates more interest than is actually owed", () => {
    // A part payment can already have cleared some of it, and a rebate larger
    // than the debt would pay the borrower for closing their loan.
    const economy = engine();
    const { loan } = opened(economy);
    const after = repay(economy, loan, account(ref(), 500_000), 5_000, {
      now: NOW,
      operationId: "r",
      reason: "x",
    }).loan;
    expect(settlementQuote(after, 10_000)).toBeGreaterThanOrEqual(after.principalOutstanding);
  });
});

describe("arrears and default", () => {
  it("owes a late fee without booking it", () => {
    // A fee is charged to the loan, not to the balance: they owe it, they have
    // not paid it.
    const { loan } = opened(engine(), { lateFeeBasisPoints: 500, gracePeriods: 1 });
    const after = chargeLateFee(loan, 1);
    expect(after.feesOutstanding).toBeGreaterThan(0);
    expect(totalOutstanding(after)).toBe(totalOutstanding(loan) + after.feesOutstanding);
  });

  it("lets grace decide when a loan is in arrears", () => {
    const { loan } = opened(engine(), { lateFeeBasisPoints: 500, gracePeriods: 1 });
    expect(chargeLateFee(loan, 1).state).toBe(LoanState.Active);
    expect(chargeLateFee(loan, 2).state).toBe(LoanState.InArrears);
  });

  it("asks the caller for the clock", () => {
    // Only the caller knows how many instalments should have been paid.
    const { loan } = opened(engine(), { gracePeriods: 1 });
    expect(isInArrears(loan, 1)).toBe(false);
    expect(isInArrears(loan, 2)).toBe(true);
  });

  it("writes off exactly the unpaid capital", () => {
    // A member who has part-paid an instalment has paid some of its interest. A
    // figure derived from whole instalments would count that interest as still
    // owed and recognise the wrong amount of issuance.
    const economy = engine();
    const loan = chargeLateFee(opened(economy, { lateFeeBasisPoints: 500 }).loan, 1);
    const outcome = repay(economy, loan, account(ref(), 500_000), 5_000, {
      now: NOW,
      operationId: "r",
      reason: "x",
    });

    const { booking, loan: closed } = writeOff(economy, outcome.loan, {
      now: NOW,
      operationId: "w",
      reason: "uncollectable",
    });
    expect(booking).not.toBeNull();
    expect(booking!.posting.amount).toBe(120_000 - outcome.toPrincipal);
    expect(booking!.posting.kind).toBe(PostingKind.WriteOff);
    expect(closed.state).toBe(LoanState.WrittenOff);
    expect(totalOutstanding(closed)).toBe(0);
  });

  it("recognises a write-off as issuance rather than destruction", () => {
    const economy = engine();
    const { loan } = opened(economy);
    const { booking } = writeOff(economy, loan, { now: NOW, operationId: "w", reason: "gone" });
    // The credit account comes back to zero for this loan; the mint goes
    // negative, because the currency the borrower kept is now issued for good
    // rather than lent.
    expect(booking!.balances[CREDIT]).toBe(120_000);
    expect(booking!.balances[MINT]).toBe(-120_000);
  });

  it("refuses to write off a settled loan", () => {
    const economy = engine();
    const { loan } = opened(economy);
    const settled = settleEarly(economy, loan, account(ref(), 500_000), {
      now: NOW,
      operationId: "s",
      reason: "x",
    }).loan;
    expect(() => writeOff(economy, settled, { now: NOW, operationId: "w", reason: "x" })).toThrow(
      LoanStateError,
    );
  });

  it("writes off the capital and nothing else", () => {
    // Unpaid interest and fees were never issued -- nobody minted them, so
    // nothing has to be un-minted. They simply stop being owed.
    for (const method of [
      AmortisationMethod.EqualInstalment,
      AmortisationMethod.EqualPrincipal,
      AmortisationMethod.InterestOnly,
    ]) {
      const economy = engine();
      const start = opened(economy, { method, periods: 4 });
      const borrower = account(ref(), 500_000);
      const loan: Loan = repay(economy, start.loan, borrower, amountDue(start.loan), {
        now: NOW,
        operationId: "r1",
        reason: "x",
      }).loan;
      const expected = loan.principalOutstanding;
      const { booking, loan: closed } = writeOff(economy, loan, {
        now: NOW,
        operationId: "w",
        reason: "x",
      });
      expect(booking === null ? 0 : booking.posting.amount).toBe(expected);
      expect(closed.state).toBe(LoanState.WrittenOff);
      expect(totalOutstanding(closed)).toBe(0);
    }
  });
});

describe("queries", () => {
  it("puts fees first in what is due", () => {
    const economy = engine();
    const { loan } = opened(economy, { lateFeeBasisPoints: 500 });
    const plain = amountDue(loan);
    const late = chargeLateFee(loan, 1);
    expect(amountDue(late)).toBe(plain + late.feesOutstanding);
  });

  it("has no next instalment once it is over", () => {
    const economy = engine();
    const { loan } = opened(economy);
    expect(nextInstalment(loan)).toBe(loan.schedule.instalments[0]);
    const settled = settleEarly(economy, loan, account(ref(), 500_000), {
      now: NOW,
      operationId: "s",
      reason: "x",
    }).loan;
    expect(nextInstalment(settled)).toBeNull();
    expect(amountDue(settled)).toBe(0);
  });
});
