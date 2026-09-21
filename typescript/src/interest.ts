/**
 * Interest, and the schedules built out of it.
 *
 * Everything a savings account, a term deposit, a loan or an instalment plan
 * needs, as pure integer arithmetic on whole minor units.
 *
 * # Rates are in basis points, per period
 *
 * A basis point is a hundredth of a percent, so 2.5 % is `250`. Permille could
 * not express that without losing the half, and a percentage as a float is how
 * two editions end up with two different balances.
 *
 * **A rate is per period, and a period is whatever the caller says it is.** This
 * package does not know whether your economy compounds daily, weekly or per
 * message; it knows how to apply a rate `n` times. Converting "5 % a year" into
 * a per-period figure is a decision about your economy, and it is yours.
 *
 * # Interest is computed period by period, not by a formula
 *
 * The closed form for compound interest is `P * (1 + r)^n`. Applied to money it
 * is subtly wrong, because it compounds fractions of a unit that were never
 * credited to anybody. A real account is credited a whole number of units each
 * period, and the next period's interest is charged on *that*.
 *
 * So every function here iterates:
 *
 * ```
 * balance += round(balance * rate / 10000)
 * ```
 *
 * once per period. Slower than a formula, exact by construction, identical in
 * both editions, and — the part that matters — it produces the schedule a member
 * can check against their own statement.
 *
 * # Nothing here is random
 *
 * The rate is an argument. There is no market, no volatility, no chance. That is
 * a legal boundary rather than a simplification: a return that varies by chance
 * is the mechanism behind gambling regulation, and this package stays on the
 * other side of it. See the README's "Deliberately absent".
 */
import { BASIS_POINTS_ONE, MAX_BALANCE } from "./constants.js";
import { RateError, ValidationError } from "./errors.js";
import { applyBasisPoints, assertWholeAmount, distributeEvenly } from "./money.js";
import { divideRounded, Rounding } from "./rounding.js";

/**
 * How many periods any one call will iterate over.
 *
 * A thousand years of monthly instalments, and a bound on the work a single call
 * can be asked to do. A schedule longer than this is a denial of service rather
 * than a loan, and `SECURITY.md` counts it as one.
 */
export const MAX_PERIODS = 12_000;

/** Whether interest earns interest. */
export enum AccrualBasis {
  /**
   * Interest is charged on the original principal every period. Ten periods at
   * 5 % is 50 % of the starting amount, exactly.
   */
  Simple = "SIMPLE",
  /**
   * Interest is charged on the balance including interest already credited.
   * What a savings account does, and what a loan left unpaid does.
   */
  Compound = "COMPOUND",
}

/** How a loan's principal is spread across its instalments. */
export enum AmortisationMethod {
  /**
   * Every instalment is the same size; the split between interest and principal
   * shifts across the term. What most consumer credit looks like.
   */
  EqualInstalment = "EQUAL_INSTALMENT",
  /**
   * Every instalment repays the same slice of principal, so the total falls as
   * the interest does. Cheaper overall, harder at the start.
   */
  EqualPrincipal = "EQUAL_PRINCIPAL",
  /** Interest only, with the whole principal due at the end. A bond. */
  InterestOnly = "INTEREST_ONLY",
}

/** One row of an amortisation schedule. */
export interface Instalment {
  /** 1 for the first instalment. */
  readonly number: number;
  /** What is owed at the start of the period. */
  readonly openingBalance: number;
  /** The whole payment due. `interest + principal`, always. */
  readonly payment: number;
  /** The part of the payment that is interest. */
  readonly interest: number;
  /** The part that reduces the debt. */
  readonly principal: number;
  /** What is owed after the payment. Zero on the last row, by construction. */
  readonly closingBalance: number;
}

/**
 * Every instalment of a loan, and what it adds up to.
 *
 * The invariant worth knowing: `sum(payment) === principal + totalInterest` and
 * the last row's `closingBalance` is zero. Both are checked before the schedule
 * leaves this module, because a schedule that does not add up is a loan that
 * quietly creates or destroys currency.
 */
export interface AmortisationSchedule {
  readonly principal: number;
  readonly rateBasisPoints: number;
  readonly method: AmortisationMethod;
  readonly instalments: readonly Instalment[];
  readonly totalInterest: number;
  readonly totalPaid: number;
}

/**
 * How many instalments a schedule has.
 *
 * The Python edition reads this off the schedule as `schedule.periods`. Here it
 * is a function, the way `totalOutstanding` and `depositBalance` are, so that
 * the two editions expose the same set of answers under the same names.
 */
export function schedulePeriods(schedule: AmortisationSchedule): number {
  return schedule.instalments.length;
}

/**
 * The interest earned or owed over `periods`, as a whole amount.
 *
 * Returns the *interest*, not the new balance — because that is the number that
 * has to be booked, and a booking needs an amount rather than a total.
 *
 * ```ts
 * accrueInterest(10_000, 500, 1);  // 500 — 5 % of 10,000 for one period
 * accrueInterest(10_000, 500, 2);  // 1025 — compounded
 * ```
 *
 * `Rounding.Down` by default, so an account never earns a unit the arithmetic
 * did not justify. A community that would rather round in the member's favour
 * passes `Rounding.Up` and knows it is doing so.
 */
export function accrueInterest(
  principal: number,
  rateBasisPoints: number,
  periods: number,
  basis: AccrualBasis = AccrualBasis.Compound,
  rounding: Rounding = Rounding.Down,
): number {
  return projectBalance(principal, rateBasisPoints, periods, basis, rounding) - principal;
}

/**
 * What a balance grows to over `periods`.
 *
 * The sibling of {@link accrueInterest} for the caller who wants the total
 * rather than the delta — a projection screen, a maturity figure.
 */
export function projectBalance(
  principal: number,
  rateBasisPoints: number,
  periods: number,
  basis: AccrualBasis = AccrualBasis.Compound,
  rounding: Rounding = Rounding.Down,
): number {
  assertPrincipal(principal);
  assertRate(rateBasisPoints);
  assertPeriods(periods);

  if (periods === 0 || rateBasisPoints === 0 || principal === 0) {
    return principal;
  }

  if (basis === AccrualBasis.Simple) {
    // One multiplication, not a loop: simple interest does not compound, so
    // every period charges the same amount on the same principal.
    const perPeriod = applyBasisPoints(principal, rateBasisPoints, rounding);
    const total = principal + perPeriod * periods;
    assertWholeAmount(total);
    return total;
  }

  let balance = principal;
  for (let period = 0; period < periods; period += 1) {
    balance += applyBasisPoints(balance, rateBasisPoints, rounding);
    // Checked every period rather than at the end: compounding runs away fast,
    // and the caller wants to know which period broke the ceiling.
    assertWholeAmount(balance);
  }
  return balance;
}

/**
 * The smallest equal payment that clears the loan in `periods`.
 *
 * **Found by search rather than by the annuity formula, and that is the point.**
 * The textbook formula assumes interest is charged on unrounded fractions of a
 * unit; this package charges it on whole units, because that is what an account
 * can actually hold. A payment derived from the formula can therefore leave a
 * few units outstanding after the final instalment — a "rounding tail" that has
 * to be swept up somewhere, and that members notice.
 *
 * So the payment is *defined* as the smallest one that works under the
 * arithmetic actually used: binary search on the payment, simulating the
 * schedule each time. It costs a few dozen iterations and it is exact by
 * construction, with no fractional power anywhere for the two editions to
 * disagree about.
 *
 * `rounding` says how each period's *interest* is rounded, exactly as it does
 * everywhere else — the payment itself is a whole number by construction. The
 * default matches {@link amortisationSchedule}'s, so the two always agree about
 * what an instalment is.
 *
 * ```ts
 * levelPayment(120_000, 100, 12);  // 10662 — 1 % a period over a year
 * ```
 */
export function levelPayment(
  principal: number,
  rateBasisPoints: number,
  periods: number,
  rounding: Rounding = Rounding.Down,
): number {
  assertPrincipal(principal);
  assertRate(rateBasisPoints);
  assertPeriods(periods);
  if (periods === 0) {
    throw new RateError("A level payment needs at least one period", { periods });
  }
  if (principal === 0) return 0;

  // Both bounds are proved rather than guessed, because a bracket that is
  // merely "wide enough" costs a bisection step for every bit of slack:
  //
  //   low   Each period reduces the debt by at most the payment, so `n`
  //         payments must come to at least the principal. Anything below
  //         `principal / n` can never clear it, whatever the rate.
  //   high  A payment of `ceil(principal / n)` plus one period's interest on
  //         the *whole* principal clears it: the balance only ever falls, so no
  //         period's interest exceeds that first one, and every period
  //         therefore takes at least `ceil(principal / n)` off the capital.
  //
  // The gap between them is one period's interest rather than the whole
  // principal, which is where the iterations went: about eleven steps on a year
  // of 1 % monthly instead of seventeen.
  const firstInterest = applyBasisPoints(principal, rateBasisPoints, Rounding.Up);
  let low = divideRounded(principal, periods, Rounding.Down);
  let high = divideRounded(principal, periods, Rounding.Up) + firstInterest + 1;
  assertWholeAmount(high);

  while (low < high) {
    // `low + Math.floor((high - low) / 2)`, not `Math.floor((low + high) / 2)`.
    // The obvious form adds two amounts that are each inside the safe range and
    // whose sum is not: for a principal of 5.6 x 10^15 the sum passes 2^53, the
    // midpoint comes back inexact, and it lands on `low` or `high` for ever. The
    // search does not converge slowly in that case — it does not converge at
    // all, and a differential run hangs rather than fails.
    const middle = low + Math.floor((high - low) / 2);
    if (clears(principal, rateBasisPoints, periods, middle, rounding)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

/**
 * Whether this payment repays the loan within the term.
 *
 * The early exit is load-bearing, not an optimisation. A payment smaller than
 * one period's interest leaves a balance that grows every period, and the binary
 * search starts at a payment of one: without the check the simulation compounds
 * its way past the ceiling and throws, on the way to an answer that was only
 * ever going to be "no".
 */
function clears(
  principal: number,
  rateBasisPoints: number,
  periods: number,
  payment: number,
  rounding: Rounding,
): boolean {
  let balance = principal;
  for (let period = 0; period < periods; period += 1) {
    const interest = applyBasisPoints(balance, rateBasisPoints, rounding);
    if (payment <= interest && balance > 0) {
      // The debt cannot fall from here, so no number of further periods will
      // clear it.
      return false;
    }
    // `balance + interest` can leave the range this edition holds exactly while
    // the principal, the interest and the answer all sit inside it. Python
    // would keep simulating and return a payment this edition disagrees with by
    // a unit — not a difference a borrower should discover. Written as
    // `balance > MAX_BALANCE - interest` because the sum is the thing that
    // cannot be represented. Found by the differential harness on a principal
    // of 9,007,199,254,737,658 at 5 % over 360 periods.
    if (balance > MAX_BALANCE - interest) {
      throw new RateError(
        "The balance would leave the range both editions hold exactly before " +
          "this payment could clear it",
        { principal, rateBasisPoints, payment, limit: MAX_BALANCE },
      );
    }
    balance = balance + interest - payment;
    if (balance <= 0) return true;
  }
  return balance <= 0;
}

/**
 * Every instalment of a loan, adding up exactly.
 *
 * The last instalment absorbs whatever the rounding left over, which is what a
 * real lender does and the only way the totals can be exact. It is usually a
 * unit or two smaller than the others; occasionally larger.
 *
 * Interest is charged on the opening balance of each period, rounded once, to a
 * whole number of minor units. That is the same arithmetic {@link accrueInterest}
 * uses, so a loan and a savings account in the same economy agree about what a
 * rate means.
 */
export function amortisationSchedule(
  principal: number,
  rateBasisPoints: number,
  periods: number,
  method: AmortisationMethod = AmortisationMethod.EqualInstalment,
  rounding: Rounding = Rounding.Down,
): AmortisationSchedule {
  assertPrincipal(principal);
  assertRate(rateBasisPoints);
  assertPeriods(periods);
  if (periods === 0) {
    throw new RateError("A schedule needs at least one period", { periods });
  }

  const rows: Instalment[] = [];
  let balance = principal;

  if (method === AmortisationMethod.EqualInstalment) {
    const payment = levelPayment(principal, rateBasisPoints, periods, rounding);
    for (let number = 1; number <= periods; number += 1) {
      const interest = applyBasisPoints(balance, rateBasisPoints, rounding);
      const last = number === periods;
      // The final row pays whatever is actually left, so the schedule closes at
      // zero instead of at a rounding tail.
      const due = last ? balance + interest : Math.min(payment, balance + interest);
      rows.push(row(number, balance, due, interest));
      balance = balance + interest - due;
    }
  } else if (method === AmortisationMethod.EqualPrincipal) {
    // Distributed rather than divided: the slices add back up to exactly the
    // principal, so no unit is lost across the term.
    const slices = distributeEvenly(principal, periods);
    slices.forEach((sliceAmount, index) => {
      const number = index + 1;
      const interest = applyBasisPoints(balance, rateBasisPoints, rounding);
      const last = number === periods;
      const capital = last ? balance : sliceAmount;
      rows.push(row(number, balance, capital + interest, interest));
      balance -= capital;
    });
  } else {
    for (let number = 1; number <= periods; number += 1) {
      const interest = applyBasisPoints(balance, rateBasisPoints, rounding);
      const last = number === periods;
      const due = last ? interest + balance : interest;
      rows.push(row(number, balance, due, interest));
      balance = balance + interest - due;
    }
  }

  const schedule: AmortisationSchedule = {
    principal,
    rateBasisPoints,
    method,
    instalments: rows,
    totalInterest: rows.reduce((sum, item) => sum + item.interest, 0),
    totalPaid: rows.reduce((sum, item) => sum + item.payment, 0),
  };
  assertCloses(schedule);
  return schedule;
}

/** What a loan costs in interest over its whole term. */
export function totalInterest(
  principal: number,
  rateBasisPoints: number,
  periods: number,
  method: AmortisationMethod = AmortisationMethod.EqualInstalment,
  rounding: Rounding = Rounding.Down,
): number {
  return amortisationSchedule(principal, rateBasisPoints, periods, method, rounding)
    .totalInterest;
}

/**
 * What is still owed after a number of instalments have been paid.
 *
 * The figure an early-repayment quote is built on, and the one a statement
 * shows. Reading it off the schedule rather than recomputing it is deliberate:
 * the schedule is the agreement, and a second computation that disagreed with it
 * by a unit would be a dispute nobody could settle.
 */
export function outstandingAfter(
  schedule: AmortisationSchedule,
  paidInstalments: number,
): number {
  if (!Number.isSafeInteger(paidInstalments)) {
    throw new ValidationError("paidInstalments must be an integer", { paidInstalments });
  }
  if (paidInstalments < 0) {
    throw new ValidationError("paidInstalments cannot be negative", { paidInstalments });
  }
  if (paidInstalments === 0) return schedule.principal;
  if (paidInstalments >= schedule.instalments.length) return 0;
  return (schedule.instalments[paidInstalments - 1] as Instalment).closingBalance;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function row(
  number: number,
  opening: number,
  payment: number,
  interest: number,
): Instalment {
  return {
    number,
    openingBalance: opening,
    payment,
    interest,
    principal: payment - interest,
    closingBalance: opening + interest - payment,
  };
}

/**
 * The two properties that make a schedule a schedule rather than a guess.
 *
 * Checked here rather than trusted, because both failure modes are silent: a
 * schedule that does not close leaves a debt nobody bills for, and one whose
 * payments do not add up creates currency that no posting minted.
 */
function assertCloses(schedule: AmortisationSchedule): void {
  if (schedule.instalments.length === 0) {
    throw new RateError("A schedule cannot be empty", {});
  }

  // The totals have to be numbers both editions hold exactly, and a schedule is
  // the one place where they can leave the range while every individual
  // instalment stays inside it: a large principal at a real rate over a long
  // term adds up to several times what was borrowed. Python would return the
  // exact total and this edition a rounded one, so neither returns it.
  //
  // Checked before the sums are compared, because past 2^53 the comparison is
  // itself unreliable — this edition happened to refuse these schedules anyway,
  // through a mismatch between two inexact sums, which is the right answer for
  // the wrong reason and not something to rely on.
  for (const [name, value] of [
    ["totalPaid", schedule.totalPaid],
    ["totalInterest", schedule.totalInterest],
  ] as const) {
    if (value > MAX_BALANCE) {
      throw new RateError(
        `The schedule's ${name} is outside the range both editions hold exactly: shorten the term, lower the rate, or lend less`,
        { [name]: value, limit: MAX_BALANCE },
      );
    }
  }

  const final = schedule.instalments[schedule.instalments.length - 1] as Instalment;
  if (final.closingBalance !== 0) {
    throw new RateError(
      "The schedule does not close: the final instalment leaves a balance",
      { outstanding: final.closingBalance },
    );
  }

  const expected = schedule.principal + schedule.totalInterest;
  if (schedule.totalPaid !== expected) {
    throw new RateError(
      "The instalments do not add up to the principal plus the interest",
      { totalPaid: schedule.totalPaid, expected },
    );
  }

  for (const item of schedule.instalments) {
    if (item.interest + item.principal !== item.payment) {
      throw new RateError(
        "An instalment's interest and principal do not add up to its payment",
        { instalment: item.number },
      );
    }
    if (item.openingBalance + item.interest - item.payment !== item.closingBalance) {
      throw new RateError("An instalment's balances do not add up", {
        instalment: item.number,
      });
    }
  }
}

function assertPrincipal(principal: number): void {
  assertWholeAmount(principal);
  if (principal < 0) {
    throw new RateError("A principal cannot be negative", { principal });
  }
}

function assertRate(rateBasisPoints: number): void {
  if (!Number.isSafeInteger(rateBasisPoints)) {
    throw new RateError("A rate must be an integer number of basis points", {
      rateBasisPoints,
    });
  }
  if (rateBasisPoints < 0) {
    throw new RateError(
      "A negative rate is not supported: charge a fee instead, so the posting says what it is",
      { rateBasisPoints },
    );
  }
  // A rate above 10000 basis points is a factor above two per period. It is
  // allowed — a joke economy may want it — but a rate that doubles a balance
  // every period reaches the ceiling in fifty of them, and the caller should
  // find that out here rather than in a projection.
  if (rateBasisPoints > BASIS_POINTS_ONE * 100) {
    throw new RateError("A rate above 1,000,000 basis points is not a rate, it is a bug", {
      rateBasisPoints,
    });
  }
}

function assertPeriods(periods: number): void {
  if (!Number.isSafeInteger(periods)) {
    throw new RateError("periods must be an integer", { periods });
  }
  if (periods < 0) {
    throw new RateError("periods cannot be negative", { periods });
  }
  if (periods > MAX_PERIODS) {
    throw new RateError(
      `periods is capped at ${MAX_PERIODS}: a longer schedule is a denial of service rather than a loan`,
      { periods, limit: MAX_PERIODS },
    );
  }
}
