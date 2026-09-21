import { describe, expect, it } from "vitest";
import {
  account,
  accountKey,
  AmortisationMethod,
  cancelSubscription,
  chargeSubscription,
  chargesDue,
  costOfCredit,
  createCurrency,
  createPlan,
  CurrencyMismatchError,
  EconomyEngine,
  financePurchase,
  InsufficientFundsError,
  InvalidAmountError,
  memberAccount,
  nextChargeAt,
  pauseSubscription,
  PostingKind,
  resumeSubscription,
  runPayroll,
  ScheduleError,
  ScheduleState,
  schedulePeriods,
  splitPayroll,
  startSubscription,
  SystemAccount,
  systemAccount,
  totalPayable,
  ValidationError,
  type PayrollLine,
  type RecurringPlan,
  type Subscription,
} from "../src/index.js";

/** The mirror of `python/tests/test_billing.py`. */

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const MAX_CATCH_UP = 100;

function engine(): EconomyEngine {
  return new EconomyEngine({
    currencies: [createCurrency({ code: "COIN" }), createCurrency({ code: "GEM" })],
  });
}

function ref(name: string, currency = "COIN") {
  return memberAccount("g1", name, currency);
}

function plan(overrides: Partial<Parameters<typeof createPlan>[0]> = {}): RecurringPlan {
  return createPlan({
    planId: "p1",
    payer: ref("ada"),
    payee: ref("guild"),
    amount: 100,
    intervalMs: DAY,
    ...overrides,
  });
}

function subscription(overrides = {}): Subscription {
  return startSubscription("s1", plan(overrides), NOW);
}

describe("plans", () => {
  it("refuses a plan that charges nothing or never", () => {
    expect(() => plan({ amount: 0 })).toThrow(InvalidAmountError);
    expect(() => plan({ intervalMs: 0 })).toThrow(ScheduleError);
  });

  it("refuses paying yourself", () => {
    expect(() => plan({ payee: ref("ada") })).toThrow(ScheduleError);
  });

  it("refuses crossing currencies", () => {
    expect(() => plan({ payee: ref("guild", "GEM") })).toThrow(CurrencyMismatchError);
  });

  it("refuses a non-positive occurrence count", () => {
    expect(() => plan({ occurrences: 0 })).toThrow(ScheduleError);
  });

  it("starts active and owing nothing", () => {
    const sub = subscription();
    expect(sub.state).toBe(ScheduleState.Active);
    expect(sub.chargesMade).toBe(0);
    expect(chargesDue(sub, NOW)).toBe(0);
  });
});

describe("charges due", () => {
  it("falls due once each interval", () => {
    const sub = subscription();
    expect(chargesDue(sub, NOW + DAY - 1)).toBe(0);
    expect(chargesDue(sub, NOW + DAY)).toBe(1);
    expect(chargesDue(sub, NOW + 3 * DAY)).toBe(3);
  });

  it("gives the same answer twice", () => {
    // A scheduler that runs every minute must not bill every minute.
    const sub = subscription();
    expect(chargesDue(sub, NOW + DAY)).toBe(1);
    expect(chargesDue(sub, NOW + DAY)).toBe(1);
  });

  it("stops owing at the end of a fixed term", () => {
    expect(chargesDue(subscription({ occurrences: 3 }), NOW + 10 * DAY)).toBe(3);
  });

  it("owes nothing when the clock went backwards", () => {
    expect(chargesDue(subscription(), NOW - DAY)).toBe(0);
  });

  it("puts the next charge one interval after the last", () => {
    expect(nextChargeAt(subscription())).toBe(NOW + DAY);
  });

  it("has no next charge once the term is over", () => {
    const result = chargeSubscription(
      engine(),
      subscription({ occurrences: 1 }),
      account(ref("ada"), 1_000),
      { now: NOW + DAY, operationId: "c1", reason: "sub" },
    );
    expect(result.subscription.state).toBe(ScheduleState.Ended);
    expect(nextChargeAt(result.subscription)).toBeNull();
  });
});

describe("charging", () => {
  it("moves the money to the payee", () => {
    const result = chargeSubscription(engine(), subscription(), account(ref("ada"), 1_000), {
      now: NOW + DAY,
      operationId: "c1",
      reason: "sub",
    });
    expect(result.charges).toBe(1);
    expect(result.amount).toBe(100);
    expect(result.booking!.posting.kind).toBe(PostingKind.Recurring);
    expect(result.booking!.balances[accountKey(ref("ada"))]).toBe(900);
    expect(result.booking!.balances[accountKey(ref("guild"))]).toBe(100);
  });

  it("catches up missed intervals in one posting", () => {
    // Three missed weeks is one payment of three times the amount: what a member
    // sees on a statement, and what a single operation id can make idempotent.
    const result = chargeSubscription(engine(), subscription(), account(ref("ada"), 1_000), {
      now: NOW + 3 * DAY,
      operationId: "c1",
      reason: "sub",
    });
    expect(result.charges).toBe(3);
    expect(result.amount).toBe(300);
    expect(result.subscription.chargesMade).toBe(3);
    expect(result.subscription.totalCharged).toBe(300);
  });

  it("takes them one at a time under a limit", () => {
    const result = chargeSubscription(engine(), subscription(), account(ref("ada"), 1_000), {
      now: NOW + 3 * DAY,
      operationId: "c1",
      reason: "sub",
      limit: 1,
    });
    expect(result.charges).toBe(1);
    expect(chargesDue(result.subscription, NOW + 3 * DAY)).toBe(2);
  });

  it("books nothing when nothing is due", () => {
    // The normal result of a scheduler running more often than the interval.
    const result = chargeSubscription(engine(), subscription(), account(ref("ada"), 1_000), {
      now: NOW,
      operationId: "c1",
      reason: "sub",
    });
    expect(result.booking).toBeNull();
    expect(result.charges).toBe(0);
    expect(result.amount).toBe(0);
  });

  it("treats too big a gap as a decision rather than a charge", () => {
    // Coming back after a year should not empty an account in silence.
    expect(() =>
      chargeSubscription(engine(), subscription(), account(ref("ada"), 100_000_000), {
        now: NOW + (MAX_CATCH_UP + 1) * DAY,
        operationId: "c1",
        reason: "sub",
      }),
    ).toThrow(ScheduleError);
  });

  it("refuses a payer without the money", () => {
    expect(() =>
      chargeSubscription(engine(), subscription(), account(ref("ada"), 10), {
        now: NOW + DAY,
        operationId: "c1",
        reason: "sub",
      }),
    ).toThrow(InsufficientFundsError);
  });

  it("needs the account to be the payer", () => {
    expect(() =>
      chargeSubscription(engine(), subscription(), account(ref("eve"), 1_000), {
        now: NOW + DAY,
        operationId: "c1",
        reason: "sub",
      }),
    ).toThrow(ScheduleError);
  });

  it("refuses a limit that is not a positive count", () => {
    for (const limit of [0, -1]) {
      expect(() =>
        chargeSubscription(engine(), subscription(), account(ref("ada"), 1_000), {
          now: NOW + DAY,
          operationId: "c1",
          reason: "sub",
          limit,
        }),
      ).toThrow(ValidationError);
    }
  });

  it("never charges more than a fixed term allows", () => {
    const economy = engine();
    const result = chargeSubscription(
      economy,
      subscription({ occurrences: 2 }),
      account(ref("ada"), 10_000),
      { now: NOW + 99 * DAY, operationId: "c1", reason: "sub" },
    );
    expect(result.charges).toBe(2);
    expect(result.subscription.state).toBe(ScheduleState.Ended);
    const again = chargeSubscription(economy, result.subscription, account(ref("ada"), 10_000), {
      now: NOW + 200 * DAY,
      operationId: "c2",
      reason: "sub",
    });
    expect(again.charges).toBe(0);
  });
});

describe("pausing and cancelling", () => {
  it("does not merely postpone the bill", () => {
    // Remembering the paused time is what separates pausing from deferring;
    // without it the bill arrives anyway, just later.
    let sub = pauseSubscription(subscription(), NOW + DAY / 2);
    expect(chargesDue(sub, NOW + 10 * DAY)).toBe(0);
    sub = resumeSubscription(sub, NOW + 10 * DAY);
    // Half a day had been earned before the pause; half a day after resuming
    // completes the first interval and no more.
    expect(chargesDue(sub, NOW + 10 * DAY + DAY / 2)).toBe(1);
  });

  it("pauses only what is active and resumes only what is paused", () => {
    const sub = subscription();
    expect(() => resumeSubscription(sub, NOW)).toThrow(ScheduleError);
    const paused = pauseSubscription(sub, NOW);
    expect(() => pauseSubscription(paused, NOW)).toThrow(ScheduleError);
  });

  it("charges nothing while paused", () => {
    const result = chargeSubscription(
      engine(),
      pauseSubscription(subscription(), NOW),
      account(ref("ada"), 1_000),
      { now: NOW + 5 * DAY, operationId: "c1", reason: "sub" },
    );
    expect(result.booking).toBeNull();
  });

  it("stops for good when cancelled", () => {
    const sub = cancelSubscription(subscription(), NOW + DAY);
    expect(sub.state).toBe(ScheduleState.Cancelled);
    expect(chargesDue(sub, NOW + 10 * DAY)).toBe(0);
    expect(() => cancelSubscription(sub, NOW + DAY)).toThrow(ScheduleError);
    expect(nextChargeAt(sub)).toBeNull();
  });
});

describe("financing", () => {
  function financed(overrides: Record<string, unknown> = {}) {
    return financePurchase(engine(), {
      planId: "f1",
      buyer: ref("ada"),
      seller: account(ref("shop"), 0),
      cashPrice: 120_000,
      rateBasisPoints: 100,
      instalments: 12,
      now: NOW,
      operationId: "op1",
      reason: "sofa",
      ...overrides,
    });
  }

  it("pays the seller in full while the buyer pays nothing yet", () => {
    // That is the point of financing, and it is why credit funds it.
    const { booking, plan: instalmentPlan } = financed();
    expect(booking.posting.kind).toBe(PostingKind.LoanDisbursement);
    expect(booking.balances[accountKey(ref("shop"))]).toBe(120_000);
    expect(booking.balances[accountKey(systemAccount("g1", "COIN", SystemAccount.Credit))]).toBe(
      -120_000,
    );
    expect(booking.balances[accountKey(ref("ada"))]).toBeUndefined();
    expect(instalmentPlan.cashPrice).toBe(120_000);
    expect(schedulePeriods(instalmentPlan.schedule)).toBe(12);
  });

  it("costs more than the goods at a rate", () => {
    const { plan: instalmentPlan } = financed();
    expect(totalPayable(instalmentPlan)).toBeGreaterThan(120_000);
    expect(totalPayable(instalmentPlan)).toBe(instalmentPlan.schedule.totalPaid);
    expect(costOfCredit(instalmentPlan)).toBe(totalPayable(instalmentPlan) - 120_000);
  });

  it("costs the cash price when the credit is interest free", () => {
    const { plan: instalmentPlan } = financed({ cashPrice: 1_200, rateBasisPoints: 0 });
    expect(totalPayable(instalmentPlan)).toBe(1_200);
    expect(costOfCredit(instalmentPlan)).toBe(0);
  });

  it("offers every method to a purchase", () => {
    for (const method of [
      AmortisationMethod.EqualInstalment,
      AmortisationMethod.EqualPrincipal,
      AmortisationMethod.InterestOnly,
    ]) {
      const { plan: instalmentPlan } = financed({ method });
      expect(instalmentPlan.schedule.instalments.at(-1)!.closingBalance).toBe(0);
    }
  });

  it("refuses financing from yourself and across currencies", () => {
    expect(() => financed({ seller: account(ref("ada"), 0) })).toThrow(ScheduleError);
    expect(() => financed({ buyer: ref("ada", "GEM") })).toThrow(CurrencyMismatchError);
  });
});

describe("payroll", () => {
  function lines(...pairs: [string, number][]): PayrollLine[] {
    return pairs.map(([name, amount]) => ({ recipient: ref(name), amount }));
  }

  it("is one posting with a line each", () => {
    // Half a payroll is the worst possible outcome, so there is no half.
    const booking = runPayroll(
      engine(),
      account(ref("guild"), 10_000),
      lines(["ada", 300], ["bob", 200]),
      { now: NOW, operationId: "p1", reason: "wages" },
    );
    expect(booking.posting.amount).toBe(500);
    expect(booking.posting.lines).toHaveLength(3);
    expect(booking.balances[accountKey(ref("guild"))]).toBe(9_500);
    expect(booking.balances[accountKey(ref("ada"))]).toBe(300);
    expect(booking.balances[accountKey(ref("bob"))]).toBe(200);
  });

  it("sums the lines of the posting to zero", () => {
    const booking = runPayroll(
      engine(),
      account(ref("guild"), 10_000),
      lines(["ada", 1], ["bob", 2], ["cat", 3]),
      { now: NOW, operationId: "p1", reason: "w" },
    );
    expect(booking.posting.lines.reduce((total, line) => total + line.delta, 0)).toBe(0);
  });

  it("carries known balances into the posting", () => {
    const booking = runPayroll(engine(), account(ref("guild"), 10_000), lines(["ada", 300]), {
      now: NOW,
      operationId: "p1",
      reason: "w",
      recipients: { [accountKey(ref("ada"))]: account(ref("ada"), 50) },
    });
    expect(booking.balances[accountKey(ref("ada"))]).toBe(350);
  });

  it("pays nobody when the employer cannot afford it", () => {
    expect(() =>
      runPayroll(engine(), account(ref("guild"), 100), lines(["ada", 300], ["bob", 200]), {
        now: NOW,
        operationId: "p1",
        reason: "w",
      }),
    ).toThrow(InsufficientFundsError);
  });

  it("refuses an empty run, a self payment and a repeated recipient", () => {
    const employer = account(ref("guild"), 10_000);
    const options = { now: NOW, operationId: "p1", reason: "w" };
    expect(() => runPayroll(engine(), employer, [], options)).toThrow(ScheduleError);
    expect(() => runPayroll(engine(), employer, lines(["guild", 100]), options)).toThrow(
      ScheduleError,
    );
    expect(() =>
      runPayroll(engine(), employer, lines(["ada", 100], ["ada", 200]), options),
    ).toThrow(ScheduleError);
  });

  it("refuses a run that crosses currencies or scopes", () => {
    const employer = account(ref("guild"), 10_000);
    const options = { now: NOW, operationId: "p1", reason: "w" };
    expect(() =>
      runPayroll(engine(), employer, [{ recipient: ref("ada", "GEM"), amount: 100 }], options),
    ).toThrow(CurrencyMismatchError);
    expect(() =>
      runPayroll(
        engine(),
        employer,
        [{ recipient: memberAccount("g2", "ada", "COIN"), amount: 100 }],
        options,
      ),
    ).toThrow(ValidationError);
  });

  it("adds a split pot up to the pot", () => {
    const recipients = [ref("ada"), ref("bob"), ref("cat")];
    for (const total of [0, 1, 2, 10, 1_000, 99_999]) {
      const split = splitPayroll(total, recipients);
      expect(split.reduce((sum, line) => sum + line.amount, 0)).toBe(total);
    }
  });

  it("can weight a split", () => {
    expect(splitPayroll(1_000, [ref("ada"), ref("bob")], [3, 1]).map((l) => l.amount)).toEqual([
      750, 250,
    ]);
  });

  it("leaves a share of nothing out rather than paying zero", () => {
    // A zero-amount line would be a posting line that moves nothing.
    expect(splitPayroll(1, [ref("ada"), ref("bob")])).toHaveLength(1);
  });

  it("refuses a split with nobody to pay", () => {
    expect(() => splitPayroll(100, [])).toThrow(ScheduleError);
  });

  it("runs a split pot straight through payroll", () => {
    const booking = runPayroll(
      engine(),
      account(ref("guild"), 10_000),
      splitPayroll(1_000, [ref("ada"), ref("bob"), ref("cat")]),
      { now: NOW, operationId: "p1", reason: "share" },
    );
    expect(booking.posting.amount).toBe(1_000);
    expect(booking.balances[accountKey(ref("guild"))]).toBe(9_000);
  });
});
