import { describe, expect, it } from "vitest";
import {
  AccrualBasis,
  accrueInterest,
  AmortisationMethod,
  amortisationSchedule,
  levelPayment,
  MAX_BALANCE,
  MAX_PERIODS,
  outstandingAfter,
  projectBalance,
  RateError,
  Rounding,
  totalInterest,
  ValidationError,
} from "../src/index.js";

/** The mirror of `python/tests/test_interest.py`. */

const METHODS = [
  AmortisationMethod.EqualInstalment,
  AmortisationMethod.EqualPrincipal,
  AmortisationMethod.InterestOnly,
];

describe("accrual", () => {
  it("charges the rate over one period", () => {
    expect(accrueInterest(10_000, 500, 1)).toBe(500);
  });

  it("compounds interest on interest", () => {
    // 10,000 -> 10,500 -> 11,025. The second period's 525 is 5 % of 10,500.
    expect(accrueInterest(10_000, 500, 2)).toBe(1025);
  });

  it("does not compound simple interest", () => {
    expect(accrueInterest(10_000, 500, 2, AccrualBasis.Simple)).toBe(1000);
    expect(accrueInterest(10_000, 500, 10, AccrualBasis.Simple)).toBe(5000);
  });

  it("accrues nothing at a zero rate or over no periods", () => {
    expect(accrueInterest(10_000, 0, 12)).toBe(0);
    expect(accrueInterest(10_000, 500, 0)).toBe(0);
    expect(accrueInterest(0, 500, 12)).toBe(0);
  });

  it("earns nothing on a rate too small to make a unit", () => {
    // A member who watches their balance not move deserves the honest answer
    // rather than a rounded-up one.
    expect(accrueInterest(100, 1, 1)).toBe(0);
    expect(accrueInterest(100, 1, 1, AccrualBasis.Compound, Rounding.Up)).toBe(1);
  });

  it("differs from the closed form, which is why it iterates", () => {
    const iterated = projectBalance(1_000, 333, 10);
    const closedForm = Math.round(1_000 * 1.0333 ** 10);
    expect(iterated).not.toBe(closedForm);
    expect(Math.abs(iterated - closedForm)).toBeLessThan(20);
  });

  it("projects a balance as the principal plus the accrual", () => {
    for (const periods of [0, 1, 5, 50]) {
      expect(projectBalance(7_777, 250, periods)).toBe(7_777 + accrueInterest(7_777, 250, periods));
    }
  });

  it("refuses impossible input", () => {
    expect(() => accrueInterest(-1, 500, 1)).toThrow(RateError);
    expect(() => accrueInterest(100, -1, 1)).toThrow(RateError);
    expect(() => accrueInterest(100, 500, -1)).toThrow(RateError);
    expect(() => accrueInterest(100, 500, MAX_PERIODS + 1)).toThrow(RateError);
    expect(() => accrueInterest(100, 1_000_001, 1)).toThrow(RateError);
  });

  it("refuses to compound past the ceiling", () => {
    expect(() => projectBalance(Math.floor(MAX_BALANCE / 2), 10_000, 10)).toThrow();
  });
});

describe("levelPayment", () => {
  it("matches the documented example", () => {
    expect(levelPayment(120_000, 100, 12)).toBe(10_662);
  });

  it("agrees with the schedule it builds", () => {
    for (const principal of [1_000, 120_000, 987_654]) {
      for (const rate of [0, 100, 250, 1000]) {
        for (const periods of [1, 6, 12, 60]) {
          const schedule = amortisationSchedule(principal, rate, periods);
          const first = schedule.instalments[0]!;
          const agrees =
            first.payment === levelPayment(principal, rate, periods) ||
            first.payment === first.openingBalance + first.interest;
          expect(agrees).toBe(true);
        }
      }
    }
  });

  it("splits the principal at a zero rate", () => {
    expect(levelPayment(1200, 0, 12)).toBe(100);
  });

  it("terminates on a payment that could never clear the debt", () => {
    expect(levelPayment(1_000_000, 5_000, 1)).toBeGreaterThan(0);
  });

  it("cannot overflow its own midpoint", () => {
    // `(low + high) / 2` adds two amounts that are each inside the safe range
    // and whose sum is not. This used to hang this edition for ever.
    expect(levelPayment(5_608_265_016_672_255, 0, 1)).toBe(5_608_265_016_672_255);
  });

  it("refuses a simulation that leaves the shared range", () => {
    // `balance + interest` can leave the range this edition holds exactly while
    // the principal, the interest and the answer all sit inside it. Python
    // would keep simulating and return a payment this edition disagrees with by
    // a unit — not a difference a borrower should discover. Both refuse.
    expect(() => levelPayment(9_007_199_254_737_658, 500, 360)).toThrow(RateError);
    expect(() => levelPayment(8_873_473_065_615_359, 1000, 12)).toThrow(RateError);
  });

  it("finds the same payment from the narrower bracket", () => {
    // `low` is `principal / periods` because `n` payments must come to at least
    // the principal; `high` is that plus one period's interest on the whole
    // principal, which always clears. Narrowing it cut about six bisection
    // steps and changed nothing, which is the only acceptable outcome here.
    for (const principal of [1, 7, 1_000, 120_000, 987_654_321]) {
      for (const rate of [0, 1, 100, 250, 1000, 5000]) {
        for (const periods of [1, 2, 12, 60, 360]) {
          const payment = levelPayment(principal, rate, periods);
          const schedule = amortisationSchedule(principal, rate, periods);
          // The schedule and the payment are two entry points into the same
          // arithmetic; they must not disagree about what an instalment is.
          const first = schedule.instalments[0]!;
          expect(
            first.payment === payment || first.payment === first.openingBalance + first.interest,
          ).toBe(true);
        }
      }
    }
  });

  it("refuses zero periods", () => {
    expect(() => levelPayment(1000, 100, 0)).toThrow(RateError);
  });
});

describe("schedules", () => {
  it("closes every schedule at zero", () => {
    for (const method of METHODS) {
      for (const principal of [1, 7, 1000, 120_000, 987_654_321]) {
        for (const rate of [0, 1, 250, 1000]) {
          for (const periods of [1, 2, 12, 60]) {
            const schedule = amortisationSchedule(principal, rate, periods, method);
            expect(schedule.instalments.at(-1)!.closingBalance).toBe(0);
          }
        }
      }
    }
  });

  it("adds the payments up exactly", () => {
    for (const method of METHODS) {
      for (const principal of [1, 7, 1000, 120_000, 987_654_321]) {
        for (const rate of [0, 1, 250, 1000]) {
          for (const periods of [1, 2, 12, 60]) {
            const schedule = amortisationSchedule(principal, rate, periods, method);
            expect(schedule.totalPaid).toBe(principal + schedule.totalInterest);
            const summed = schedule.instalments.reduce((total, row) => total + row.payment, 0);
            expect(summed).toBe(schedule.totalPaid);
          }
        }
      }
    }
  });

  it("makes every row add up", () => {
    for (const method of METHODS) {
      const schedule = amortisationSchedule(100_000, 250, 6, method);
      for (const row of schedule.instalments) {
        expect(row.interest + row.principal).toBe(row.payment);
        expect(row.openingBalance + row.interest - row.payment).toBe(row.closingBalance);
      }
    }
  });

  it("keeps an equal instalment level except for the last", () => {
    const payments = amortisationSchedule(100_000, 250, 6).instalments.map((row) => row.payment);
    expect(new Set(payments.slice(0, -1)).size).toBe(1);
    // The last absorbs the rounding, which is what a real lender does.
    expect(payments.at(-1)).not.toBe(payments[0]);
  });

  it("lets an equal-principal payment fall over the term", () => {
    const payments = amortisationSchedule(
      100_000,
      250,
      6,
      AmortisationMethod.EqualPrincipal,
    ).instalments.map((row) => row.payment);
    expect(payments).toEqual([...payments].sort((a, b) => b - a));
  });

  it("defers the whole principal on an interest-only schedule", () => {
    const schedule = amortisationSchedule(100_000, 250, 6, AmortisationMethod.InterestOnly);
    expect(schedule.instalments.slice(0, -1).every((row) => row.principal === 0)).toBe(true);
    expect(schedule.instalments.at(-1)!.principal).toBe(100_000);
  });

  it("costs less on equal principal than on equal instalments", () => {
    const level = totalInterest(100_000, 250, 6, AmortisationMethod.EqualInstalment);
    const linear = totalInterest(100_000, 250, 6, AmortisationMethod.EqualPrincipal);
    const balloon = totalInterest(100_000, 250, 6, AmortisationMethod.InterestOnly);
    expect(linear).toBeLessThan(level);
    expect(level).toBeLessThan(balloon);
  });

  it("costs nothing at a zero rate", () => {
    for (const method of METHODS) {
      const schedule = amortisationSchedule(1200, 0, 12, method);
      expect(schedule.totalInterest).toBe(0);
      expect(schedule.totalPaid).toBe(1200);
    }
  });

  it("refuses a schedule whose totals leave the shared range", () => {
    // Every instalment stays inside the range; the total does not. Python would
    // return the exact figure and this edition a rounded one, so both refuse.
    expect(() =>
      amortisationSchedule(9_007_199_254_740_084, 2500, 2, AmortisationMethod.InterestOnly),
    ).toThrow(RateError);
  });

  it("refuses zero periods", () => {
    expect(() => amortisationSchedule(1000, 100, 0)).toThrow(RateError);
  });
});

describe("outstandingAfter", () => {
  it("reads the schedule rather than recomputing it", () => {
    const schedule = amortisationSchedule(120_000, 100, 12);
    expect(outstandingAfter(schedule, 0)).toBe(120_000);
    expect(outstandingAfter(schedule, 12)).toBe(0);
    expect(outstandingAfter(schedule, 20)).toBe(0);
    expect(outstandingAfter(schedule, 1)).toBe(schedule.instalments[0]!.closingBalance);
  });

  it("refuses a negative count", () => {
    const schedule = amortisationSchedule(120_000, 100, 12);
    expect(() => outstandingAfter(schedule, -1)).toThrow(ValidationError);
  });
});
