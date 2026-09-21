/**
 * Loans: currency lent, repaid on a schedule, and what happens when it is not.
 *
 * A loan is the one thing in an economy that lets a member spend currency they
 * do not have, and it is therefore the one thing most able to wreck the money
 * supply if it is done loosely. Three decisions keep it honest here.
 *
 * # The schedule is the agreement
 *
 * {@link openLoan} computes the whole amortisation schedule up front and stores
 * it on the loan. Every later question — what is owed, what an instalment costs,
 * what settling early would cost — is read off that schedule rather than
 * recomputed. A second computation that disagreed with the first by a unit would
 * be a dispute between a member and a bot with no way to settle it.
 *
 * # Lending is not minting
 *
 * The principal comes out of `system:credit`, whose balance is therefore the
 * scope's outstanding lending with a minus sign. Repayments go back to it. A
 * community that has lent 10,000 and been repaid 3,000 has a credit account at
 * -7,000, and that number can be checked against the sum of every open loan.
 *
 * **Interest is different, and this is the part worth being careful about.** A
 * repayment is booked as one posting with up to three lines: the capital goes
 * back to `system:credit`, and the interest and any fees go to `system:fee`,
 * because they are revenue rather than a return of principal. Sending the whole
 * payment to the credit account would leave it positive by exactly the interest
 * once every loan had been repaid, and a number that is supposed to mean
 * "currency currently lent out" would mean nothing at all.
 *
 * # Default is a booking, not a deletion
 *
 * Writing a debt off brings `system:credit` back to zero for that loan, and the
 * counter-line is the **mint**.
 *
 * That is worth a sentence, because the obvious choice is the sink and the
 * obvious choice is wrong. The sink is where currency is destroyed — and nothing
 * is destroyed here. The borrower still has what they were lent; they are simply
 * never going to give it back. So the currency that was a *claim* becomes
 * currency that was *issued*, the mint's balance says so, and the money supply
 * rises by exactly what was lost. Sending it to the sink instead would leave the
 * scope reporting a negative amount in circulation, which is not a thing.
 *
 * A loan that was simply deleted would leave the credit account permanently
 * wrong.
 *
 * # Nothing here is random
 *
 * Whether a borrower repays is the caller's news to deliver, not this package's
 * to decide. There is no default probability, no credit scoring model, no
 * chance.
 */
import {
  type Account,
  type AccountRef,
  SystemAccount,
  accountKey,
  emptyAccount,
  systemAccount,
} from "./accounts.js";
import type { EconomyEngine } from "./engine.js";
import {
  CreditLimitError,
  LoanStateError,
  ValidationError,
} from "./errors.js";
import {
  AmortisationMethod,
  type AmortisationSchedule,
  type Instalment,
  amortisationSchedule,
} from "./interest.js";
import {
  PostingKind,
  type PostingLine,
  createPosting,
  resultingBalances,
} from "./ledger.js";
import { applyBasisPoints, assertPositiveAmount, assertWholeAmount } from "./money.js";
import { Rounding } from "./rounding.js";
import type { BookingResult } from "./types.js";

/** Where a loan is in its life. */
export enum LoanState {
  /** Money has been paid out and the debt is being repaid. */
  Active = "ACTIVE",
  /** Repaid in full. Nothing further is owed. */
  Settled = "SETTLED",
  /** Behind on its instalments, but still owed and still collectable. */
  InArrears = "IN_ARREARS",
  /**
   * Given up on. The capital that never came back has been recognised as
   * permanent issuance, so the credit account is clear and the books close.
   */
  WrittenOff = "WRITTEN_OFF",
}

/** What is borrowed, at what price, over how long. */
export interface LoanTerms {
  readonly principal: number;
  /** Charged per period on the outstanding balance, in basis points. */
  readonly rateBasisPoints: number;
  readonly periods: number;
  readonly method: AmortisationMethod;
  readonly rounding: Rounding;
  /**
   * What a missed instalment costs, in basis points of the instalment. Charged
   * by {@link chargeLateFee}, never automatically — the decision that a payment
   * is late is the caller's, because only it knows the clock.
   */
  readonly lateFeeBasisPoints: number;
  /** How many instalments may be missed before the loan is in arrears. */
  readonly gracePeriods: number;
}

/** A loan as the caller stores it. */
export interface Loan {
  readonly loanId: string;
  readonly borrower: AccountRef;
  readonly terms: LoanTerms;
  readonly schedule: AmortisationSchedule;
  readonly state: LoanState;
  /** Instalments fully paid. Indexes into the schedule. */
  readonly paidInstalments: number;
  /**
   * Capital still owed. Tracked rather than recomputed, and that is the point: a
   * member who has part-paid an instalment has paid some of its interest, and a
   * figure derived from whole instalments would count that interest as still
   * owed. Writing a loan off on such a figure recognises the wrong amount of
   * issuance and leaves the credit account holding a balance for a loan nobody
   * owes — see the 2.0.0 changelog.
   */
  readonly principalOutstanding: number;
  /** Interest still owed, on the same basis. */
  readonly interestOutstanding: number;
  /** Paid so far against the current instalment, when a member pays in parts. */
  readonly partPaid: number;
  /**
   * Fees charged and not yet paid. Sit outside the schedule: a late fee is not
   * interest and must not be confused with it.
   */
  readonly feesOutstanding: number;
  readonly openedAt: number;
  /** Everything repaid so far, fees included. For a statement. */
  readonly totalRepaid: number;
}

/** What a repayment did. Write both parts in one transaction. */
export interface RepaymentResult {
  readonly booking: BookingResult;
  readonly loan: Loan;
  /**
   * How much of the payment went to fees, interest and principal. Adds up to the
   * payment, always — a statement line a member can check.
   */
  readonly toFees: number;
  readonly toInterest: number;
  readonly toPrincipal: number;
  /** How many instalments this payment completed. */
  readonly instalmentsCleared: number;
  /** True when this payment closed the loan. */
  readonly settled: boolean;
}

/** What the schedule still owes: capital and interest together. */
export function outstanding(loan: Loan): number {
  return loan.principalOutstanding + loan.interestOutstanding;
}

/** Everything still owed: schedule and fees together. */
export function totalOutstanding(loan: Loan): number {
  return outstanding(loan) + loan.feesOutstanding;
}

/** Whether the loan is over, one way or the other. */
export function isClosed(loan: Loan): boolean {
  return loan.state === LoanState.Settled || loan.state === LoanState.WrittenOff;
}

/** Build validated loan terms. */
export function createLoanTerms(
  options: Partial<LoanTerms> & {
    principal: number;
    rateBasisPoints: number;
    periods: number;
  },
): LoanTerms {
  const terms: LoanTerms = {
    principal: options.principal,
    rateBasisPoints: options.rateBasisPoints,
    periods: options.periods,
    method: options.method ?? AmortisationMethod.EqualInstalment,
    rounding: options.rounding ?? Rounding.Down,
    lateFeeBasisPoints: options.lateFeeBasisPoints ?? 0,
    gracePeriods: options.gracePeriods ?? 0,
  };
  assertPositiveAmount(terms.principal);
  if (!Number.isSafeInteger(terms.lateFeeBasisPoints) || terms.lateFeeBasisPoints < 0) {
    throw new ValidationError("lateFeeBasisPoints must be a non-negative integer", {
      lateFeeBasisPoints: terms.lateFeeBasisPoints,
    });
  }
  if (!Number.isSafeInteger(terms.gracePeriods) || terms.gracePeriods < 0) {
    throw new ValidationError("gracePeriods must be a non-negative integer", {
      gracePeriods: terms.gracePeriods,
    });
  }
  return terms;
}

/**
 * Refuse a loan that would take a member past what they may borrow.
 *
 * `existing` is what they already owe — the caller sums it, because only the
 * caller knows how many loans a member has. Passing `null` for the limit means
 * the community has not set one, which is a decision rather than an oversight
 * and so is allowed.
 */
export function assertWithinCreditLimit(
  terms: LoanTerms,
  existing: number,
  creditLimit: number | null,
): void {
  if (creditLimit === null) return;
  assertWholeAmount(existing);
  assertWholeAmount(creditLimit);
  if (creditLimit < 0) {
    throw new ValidationError("A credit limit cannot be negative", { creditLimit });
  }
  if (existing + terms.principal > creditLimit) {
    throw new CreditLimitError("That loan would take the borrower past their credit limit", {
      existing,
      requested: terms.principal,
      creditLimit,
    });
  }
}

/**
 * Pay a loan out and start its schedule.
 *
 * The whole schedule is computed here, once, and stored. Everything that happens
 * to the loan afterwards is read off it.
 */
export function openLoan(
  engine: EconomyEngine,
  loanId: string,
  terms: LoanTerms,
  borrower: Account,
  options: {
    now: number;
    operationId: string;
    reason: string;
    creditAccount?: Account;
    metadata?: Record<string, string>;
  },
): { booking: BookingResult; loan: Loan } {
  if (typeof loanId !== "string" || loanId.length === 0) {
    throw new ValidationError("A loan needs a non-empty id", { loanId });
  }
  assertTimestamp(options.now);

  const schedule = amortisationSchedule(
    terms.principal,
    terms.rateBasisPoints,
    terms.periods,
    terms.method,
    terms.rounding,
  );

  const booking = engine.transfer(
    options.creditAccount ??
      emptyAccount(
        systemAccount(borrower.ref.scope, borrower.ref.currency, SystemAccount.Credit),
      ),
    borrower,
    terms.principal,
    {
      now: options.now,
      operationId: options.operationId,
      reason: options.reason,
      kind: PostingKind.LoanDisbursement,
      // The credit account is a system account and is meant to go negative: its
      // balance *is* the outstanding lending.
      allowNegative: true,
      metadata: options.metadata,
    },
  );

  return {
    booking,
    loan: {
      loanId,
      borrower: borrower.ref,
      terms,
      schedule,
      state: LoanState.Active,
      paidInstalments: 0,
      principalOutstanding: schedule.principal,
      interestOutstanding: schedule.totalInterest,
      partPaid: 0,
      feesOutstanding: 0,
      openedAt: options.now,
      totalRepaid: 0,
    },
  };
}

/**
 * What the next `instalments` payments come to, fees first.
 *
 * The number to put in front of a member before they press pay.
 */
export function amountDue(loan: Loan, instalments = 1): number {
  if (!Number.isSafeInteger(instalments) || instalments < 1) {
    throw new ValidationError("instalments must be a positive integer", { instalments });
  }
  if (isClosed(loan)) return 0;

  let due = loan.feesOutstanding;
  const remaining = loan.schedule.instalments.slice(loan.paidInstalments);
  for (const item of remaining.slice(0, instalments)) {
    due += item.payment;
  }
  return due - loan.partPaid;
}

/** The next unpaid row of the schedule, or `null` when there is none. */
export function nextInstalment(loan: Loan): Instalment | null {
  if (isClosed(loan) || loan.paidInstalments >= loan.schedule.instalments.length) {
    return null;
  }
  return loan.schedule.instalments[loan.paidInstalments] as Instalment;
}

/**
 * Pay something towards a loan.
 *
 * Any amount is accepted up to what is owed; a part payment is recorded against
 * the current instalment and the loan does not advance until that instalment is
 * complete. Paying more than is owed is refused rather than silently credited,
 * because an overpayment a member cannot get back is worse than an error
 * message.
 *
 * **The payment is split fees, then interest, then principal.** That order is a
 * decision and it is the conventional one: it means a member who pays late
 * clears the penalty first and their debt last, which is what the schedule they
 * agreed to says. The three parts come back on the result so a statement can
 * show them.
 */
export function repay(
  engine: EconomyEngine,
  loan: Loan,
  borrower: Account,
  amount: number,
  options: {
    now: number;
    operationId: string;
    reason: string;
    creditAccount?: Account;
    feeAccount?: Account;
    metadata?: Record<string, string>;
  },
): RepaymentResult {
  assertPositiveAmount(amount);
  assertTimestamp(options.now);
  assertBorrower(loan, borrower);
  if (isClosed(loan)) {
    throw new LoanStateError("That loan is closed", {
      loanId: loan.loanId,
      state: loan.state,
    });
  }
  engine.currency(borrower.ref.currency); // the currency must be configured

  const owed = totalOutstanding(loan);
  if (amount > owed) {
    throw new LoanStateError("That is more than the loan owes; settle it instead", {
      loanId: loan.loanId,
      outstanding: owed,
      offered: amount,
    });
  }

  // Fees first.
  const toFees = Math.min(amount, loan.feesOutstanding);
  let left = amount - toFees;

  // Then interest and principal, instalment by instalment, so the split reported
  // is the split the schedule actually describes.
  let toInterest = 0;
  let toPrincipal = 0;
  let paid = loan.paidInstalments;
  let part = loan.partPaid;

  while (left > 0 && paid < loan.schedule.instalments.length) {
    const item = loan.schedule.instalments[paid] as Instalment;
    const stillOwedOnRow = item.payment - part;
    const paying = Math.min(left, stillOwedOnRow);

    // Within one instalment the same order applies: interest before capital.
    const interestLeft = Math.max(0, item.interest - Math.min(part, item.interest));
    const interestPart = Math.min(paying, interestLeft);
    toInterest += interestPart;
    toPrincipal += paying - interestPart;

    part += paying;
    left -= paying;
    if (part >= item.payment) {
      paid += 1;
      part = 0;
    }
  }

  const booking = bookRepayment(loan, borrower, toPrincipal, toInterest + toFees, {
    now: options.now,
    operationId: options.operationId,
    reason: options.reason,
    creditAccount: options.creditAccount,
    feeAccount: options.feeAccount,
    metadata: options.metadata,
  });

  const settled = paid >= loan.schedule.instalments.length && part === 0;
  const updated: Loan = {
    ...loan,
    paidInstalments: paid,
    partPaid: part,
    principalOutstanding: loan.principalOutstanding - toPrincipal,
    interestOutstanding: loan.interestOutstanding - toInterest,
    feesOutstanding: loan.feesOutstanding - toFees,
    totalRepaid: loan.totalRepaid + amount,
    state: settled && loan.feesOutstanding === toFees ? LoanState.Settled : loan.state,
  };
  return {
    booking,
    loan: updated,
    toFees,
    toInterest,
    toPrincipal,
    instalmentsCleared: paid - loan.paidInstalments,
    settled: updated.state === LoanState.Settled,
  };
}

/**
 * What it would cost to clear the loan today.
 *
 * Everything still owed, less a rebate on the interest that has not been reached
 * yet. A community that wants early repayment to be worth doing sets a rebate;
 * one that does not, leaves it at zero and the quote is simply the outstanding
 * balance.
 *
 * The rebate applies only to *future* interest — the interest inside instalments
 * already reached is owed and is not given back.
 */
export function settlementQuote(loan: Loan, rebateBasisPoints = 0): number {
  if (isClosed(loan)) return 0;
  if (
    !Number.isSafeInteger(rebateBasisPoints) ||
    rebateBasisPoints < 0 ||
    rebateBasisPoints > 10_000
  ) {
    throw new ValidationError("rebateBasisPoints must be between 0 and 10000", {
      rebateBasisPoints,
    });
  }

  // Only interest beyond the instalment currently being paid is rebated: the one
  // in progress has been reached, so its interest is owed.
  let futureInterest = loan.schedule.instalments
    .slice(loan.paidInstalments + 1)
    .reduce((sum, item) => sum + item.interest, 0);
  // Never rebate more interest than is actually still owed. A part payment can
  // already have cleared some of it, and a rebate larger than the debt would
  // hand the borrower currency for closing their loan.
  futureInterest = Math.min(futureInterest, loan.interestOutstanding);
  const rebate = applyBasisPoints(futureInterest, rebateBasisPoints, Rounding.Down);
  return totalOutstanding(loan) - rebate;
}

/**
 * Clear the whole loan in one payment.
 *
 * The rebate is forgiven interest: currency the member never has to find. It is
 * simply not charged, so nothing is booked for it and the money supply does not
 * move.
 */
export function settleEarly(
  engine: EconomyEngine,
  loan: Loan,
  borrower: Account,
  options: {
    now: number;
    operationId: string;
    reason: string;
    rebateBasisPoints?: number;
    creditAccount?: Account;
    feeAccount?: Account;
    metadata?: Record<string, string>;
  },
): RepaymentResult {
  assertTimestamp(options.now);
  assertBorrower(loan, borrower);
  if (isClosed(loan)) {
    throw new LoanStateError("That loan is closed", {
      loanId: loan.loanId,
      state: loan.state,
    });
  }
  engine.currency(borrower.ref.currency); // the currency must be configured

  const quote = settlementQuote(loan, options.rebateBasisPoints ?? 0);
  const toPrincipal = Math.min(
    loan.principalOutstanding,
    Math.max(0, quote - loan.feesOutstanding),
  );
  const booking = bookRepayment(loan, borrower, toPrincipal, quote - toPrincipal, {
    now: options.now,
    operationId: options.operationId,
    reason: options.reason,
    creditAccount: options.creditAccount,
    feeAccount: options.feeAccount,
    metadata: options.metadata,
  });

  const updated: Loan = {
    ...loan,
    state: LoanState.Settled,
    paidInstalments: loan.schedule.instalments.length,
    partPaid: 0,
    principalOutstanding: 0,
    interestOutstanding: 0,
    feesOutstanding: 0,
    totalRepaid: loan.totalRepaid + quote,
  };
  return {
    booking,
    loan: updated,
    toFees: loan.feesOutstanding,
    toInterest: quote - loan.feesOutstanding - toPrincipal,
    toPrincipal,
    instalmentsCleared: loan.schedule.instalments.length - loan.paidInstalments,
    settled: true,
  };
}

/**
 * Add a late fee to what the loan owes. Nothing is booked yet.
 *
 * A fee is charged to the *loan*, not to the member's balance: they owe it, they
 * have not paid it. It is booked when they do, out of {@link repay}, which is
 * why this function returns a loan and no posting.
 *
 * Marking a loan late is the caller's call. This package reads no clock, so it
 * cannot know that an instalment is overdue — only the caller's scheduler does.
 */
export function chargeLateFee(loan: Loan, missedInstalments = 1): Loan {
  if (!Number.isSafeInteger(missedInstalments) || missedInstalments < 1) {
    throw new ValidationError("missedInstalments must be a positive integer", {
      missedInstalments,
    });
  }
  if (isClosed(loan)) {
    throw new LoanStateError("A closed loan cannot be charged a fee", {
      loanId: loan.loanId,
      state: loan.state,
    });
  }

  const item = nextInstalment(loan);
  if (item === null) return loan;

  const fee = applyBasisPoints(
    item.payment * missedInstalments,
    loan.terms.lateFeeBasisPoints,
    Rounding.Down,
  );
  const inArrears = missedInstalments > loan.terms.gracePeriods;
  return {
    ...loan,
    feesOutstanding: loan.feesOutstanding + fee,
    state: inArrears ? LoanState.InArrears : loan.state,
  };
}

/**
 * Whether the borrower is further behind than the grace allows.
 *
 * `instalmentsExpected` is how many should have been paid by now, which only the
 * caller can work out — it depends on a clock and on what a period means in that
 * economy.
 */
export function isInArrears(loan: Loan, instalmentsExpected: number): boolean {
  if (isClosed(loan)) return false;
  return instalmentsExpected - loan.paidInstalments > loan.terms.gracePeriods;
}

/**
 * Give up on a debt, and say so on the books.
 *
 * The principal that is still out there stops being a claim and becomes an
 * issuance: `system:credit` returns to zero for this loan and the mint goes
 * negative by the same amount. The money supply rises by what was lost, which is
 * exactly what happened — the borrower kept it.
 *
 * Unpaid *interest and fees* are not written off, because they were never
 * issued: nobody minted them, so nothing has to be un-minted. They simply stop
 * being owed.
 *
 * `null` comes back instead of a posting when there was no principal left to
 * write off — a loan that had been fully repaid in capital and was only behind
 * on interest.
 */
export function writeOff(
  engine: EconomyEngine,
  loan: Loan,
  options: {
    now: number;
    operationId: string;
    reason: string;
    creditAccount?: Account;
    mintAccount?: Account;
    metadata?: Record<string, string>;
  },
): { booking: BookingResult | null; loan: Loan } {
  assertTimestamp(options.now);
  if (isClosed(loan)) {
    throw new LoanStateError("That loan is already closed", {
      loanId: loan.loanId,
      state: loan.state,
    });
  }

  const lostPrincipal = loan.principalOutstanding;
  const updated: Loan = {
    ...loan,
    state: LoanState.WrittenOff,
    principalOutstanding: 0,
    interestOutstanding: 0,
    feesOutstanding: 0,
    partPaid: 0,
  };
  if (lostPrincipal === 0) {
    return { booking: null, loan: updated };
  }

  const booking = engine.transfer(
    options.mintAccount ??
      emptyAccount(
        systemAccount(loan.borrower.scope, loan.borrower.currency, SystemAccount.Mint),
      ),
    options.creditAccount ??
      emptyAccount(
        systemAccount(loan.borrower.scope, loan.borrower.currency, SystemAccount.Credit),
      ),
    lostPrincipal,
    {
      now: options.now,
      operationId: options.operationId,
      reason: options.reason,
      kind: PostingKind.WriteOff,
      allowNegative: true,
      metadata: options.metadata,
    },
  );
  return { booking, loan: updated };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * One posting, up to three lines: capital back, revenue collected.
 *
 * **Capital and revenue go to different places, and that is the whole point of
 * booking this by hand rather than as a transfer.** The principal returns to
 * `system:credit`, which lent it; the interest and any fees are revenue and go to
 * `system:fee`. Sending the whole payment to the credit account would leave it
 * positive by exactly the interest once every loan in the community had been
 * repaid, and the number that is supposed to mean "currency currently lent out"
 * would instead mean nothing at all.
 *
 * The three lines are one posting because they are one event. A member pays
 * once; the books record where the money went.
 */
function bookRepayment(
  loan: Loan,
  borrower: Account,
  toPrincipal: number,
  toRevenue: number,
  options: {
    now: number;
    operationId: string;
    reason: string;
    creditAccount?: Account;
    feeAccount?: Account;
    metadata?: Record<string, string>;
  },
): BookingResult {
  const scope = loan.borrower.scope;
  const currency = loan.borrower.currency;
  const amount = toPrincipal + toRevenue;

  const credit =
    options.creditAccount ??
    emptyAccount(systemAccount(scope, currency, SystemAccount.Credit));
  const fees =
    options.feeAccount ?? emptyAccount(systemAccount(scope, currency, SystemAccount.Fee));

  const lines: PostingLine[] = [
    {
      account: borrower.ref,
      delta: -amount,
      balanceBefore: borrower.balance,
      balanceAfter: borrower.balance - amount,
    },
  ];
  if (toPrincipal > 0) {
    lines.push({
      account: credit.ref,
      delta: toPrincipal,
      balanceBefore: credit.balance,
      balanceAfter: credit.balance + toPrincipal,
    });
  }
  if (toRevenue > 0) {
    lines.push({
      account: fees.ref,
      delta: toRevenue,
      balanceBefore: fees.balance,
      balanceAfter: fees.balance + toRevenue,
    });
  }

  const posting = createPosting({
    operationId: options.operationId,
    kind: PostingKind.LoanRepayment,
    scope,
    currency,
    amount,
    reason: options.reason,
    occurredAt: options.now,
    lines,
    metadata: options.metadata,
  });
  return { posting, balances: resultingBalances(posting) };
}

function assertBorrower(loan: Loan, account: Account): void {
  if (accountKey(account.ref) !== accountKey(loan.borrower)) {
    throw new LoanStateError("That account is not the borrower", {
      loanId: loan.loanId,
      borrower: accountKey(loan.borrower),
      given: accountKey(account.ref),
    });
  }
  // No currency check follows: an AccountRef carries its currency, so the
  // comparison above has already settled it.
}

function assertTimestamp(now: number): void {
  if (!Number.isSafeInteger(now)) {
    throw new ValidationError("Timestamps are epoch milliseconds as integers", {
      timestamp: now,
    });
  }
}
