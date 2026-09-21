/**
 * Money that moves on a schedule: subscriptions, financing and payroll.
 *
 * # Periods are milliseconds, not calendar months
 *
 * There is no "monthly" here, because a month is a calendar question and a
 * calendar is a locale, a timezone and a set of rules about the 31st that this
 * package has no business holding an opinion about. A schedule has an interval
 * in milliseconds and a start; the caller decides what that means.
 *
 * # Missed charges are caught up, not skipped
 *
 * A bot that was down for three days owes three charges, not one.
 * {@link chargesDue} answers "how many are owed as of `now`" from the schedule
 * alone, so an outage costs the operator nothing and a member is billed exactly
 * what they agreed to — no more, because the count is bounded by the plan, and
 * no less, because it is computed rather than counted as they happen.
 *
 * That is why a subscription stores `chargesMade` rather than a "last charged"
 * flag: the number of charges owed is a function of the schedule and the clock,
 * and the two can be compared.
 *
 * # Financing pays the seller now and bills the buyer later
 *
 * An instalment plan is the seller being paid in full, immediately, out of
 * `system:credit` — and the buyer owing that credit account on a schedule. The
 * seller carries no risk and needs no special handling; the community carries
 * the debt, and it is on the books where it can be seen.
 *
 * That is a different thing from a cash loan (`credit.ts`), which pays the
 * borrower. Both use the same amortisation arithmetic, so the two agree about
 * what an instalment costs.
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
  CurrencyMismatchError,
  InsufficientFundsError,
  ScheduleError,
  ValidationError,
} from "./errors.js";
import {
  AmortisationMethod,
  type AmortisationSchedule,
  amortisationSchedule,
} from "./interest.js";
import {
  PostingKind,
  type PostingLine,
  createPosting,
  resultingBalances,
} from "./ledger.js";
import { assertPositiveAmount, assertWholeAmount, distribute } from "./money.js";
import { Rounding } from "./rounding.js";
import type { BookingResult } from "./types.js";

/**
 * Most charges one call will catch up on.
 *
 * A bot that has been down for a year should not silently take three hundred and
 * sixty-five payments out of a member's balance in one go. Past this the call
 * refuses and an operator has to decide what to do, which is the right outcome
 * for a situation nobody planned for.
 */
export const MAX_CATCH_UP = 100;

/** Where a recurring arrangement is in its life. */
export enum ScheduleState {
  Active = "ACTIVE",
  /** Temporarily stopped. Charges do not accrue while paused. */
  Paused = "PAUSED",
  /** Stopped for good by somebody. */
  Cancelled = "CANCELLED",
  /** Ran to the end of its term. */
  Ended = "ENDED",
}

/** What is charged, to whom, how often. */
export interface RecurringPlan {
  readonly planId: string;
  readonly payer: AccountRef;
  readonly payee: AccountRef;
  readonly amount: number;
  /** How long between charges, in milliseconds. */
  readonly intervalMs: number;
  /** How many times it charges in total. `null` runs until cancelled. */
  readonly occurrences: number | null;
}

/** A plan in progress, as the caller stores it. */
export interface Subscription {
  readonly subscriptionId: string;
  readonly plan: RecurringPlan;
  readonly state: ScheduleState;
  /** When the first charge became due. */
  readonly startedAt: number;
  /** How many charges have actually been taken. */
  readonly chargesMade: number;
  /** Everything charged so far. For a statement. */
  readonly totalCharged: number;
  /** When it was paused, so the pause can be subtracted from the schedule. */
  readonly pausedAt: number | null;
  /** Time spent paused, in milliseconds. Charges do not accrue during it. */
  readonly pausedMs: number;
}

/** What a run of charges did. Write both parts in one transaction. */
export interface ChargeResult {
  readonly booking: BookingResult | null;
  readonly subscription: Subscription;
  /** How many charges this call took. */
  readonly charges: number;
  readonly amount: number;
}

/** Goods bought now and paid for over time. */
export interface InstalmentPlan {
  readonly planId: string;
  readonly buyer: AccountRef;
  readonly seller: AccountRef;
  /** What the goods cost. What the seller was paid. */
  readonly cashPrice: number;
  readonly schedule: AmortisationSchedule;
  readonly openedAt: number;
  readonly paidInstalments: number;
}

/** One person's share of a payroll run. */
export interface PayrollLine {
  readonly recipient: AccountRef;
  readonly amount: number;
}

/**
 * True while a subscription is still charging.
 *
 * The Python edition reads this off the subscription as `subscription.is_active`.
 */
export function isSubscriptionActive(subscription: Subscription): boolean {
  return subscription.state === ScheduleState.Active;
}

/** What the buyer pays in the end, interest included. */
export function totalPayable(plan: InstalmentPlan): number {
  return plan.schedule.totalPaid;
}

/** What financing it costs over paying cash. */
export function costOfCredit(plan: InstalmentPlan): number {
  return plan.schedule.totalPaid - plan.cashPrice;
}

/** Build a validated recurring plan. */
export function createPlan(options: {
  planId: string;
  payer: AccountRef;
  payee: AccountRef;
  amount: number;
  intervalMs: number;
  occurrences?: number | null;
}): RecurringPlan {
  const occurrences = options.occurrences ?? null;
  if (typeof options.planId !== "string" || options.planId.length === 0) {
    throw new ScheduleError("A plan needs a non-empty id", { planId: options.planId });
  }
  assertPositiveAmount(options.amount);
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new ScheduleError(
      "intervalMs must be a positive integer number of milliseconds",
      { intervalMs: options.intervalMs },
    );
  }
  if (occurrences !== null && (!Number.isSafeInteger(occurrences) || occurrences <= 0)) {
    throw new ScheduleError("occurrences must be a positive integer or null", {
      occurrences,
    });
  }
  if (accountKey(options.payer) === accountKey(options.payee)) {
    throw new ScheduleError("A plan cannot charge an account to itself", {
      account: accountKey(options.payer),
    });
  }
  if (options.payer.currency !== options.payee.currency) {
    throw new CurrencyMismatchError({
      expected: options.payer.currency,
      received: options.payee.currency,
    });
  }
  return {
    planId: options.planId,
    payer: options.payer,
    payee: options.payee,
    amount: options.amount,
    intervalMs: options.intervalMs,
    occurrences,
  };
}

/**
 * Begin a plan.
 *
 * The first charge falls due one interval after the start, not immediately. A
 * caller who wants to charge on sign-up books that themselves — making the
 * schedule do it would mean the first period is billed twice by anybody who also
 * takes a joining payment.
 */
export function startSubscription(
  subscriptionId: string,
  plan: RecurringPlan,
  now: number,
): Subscription {
  if (typeof subscriptionId !== "string" || subscriptionId.length === 0) {
    throw new ScheduleError("A subscription needs a non-empty id", { subscriptionId });
  }
  assertTimestamp(now);
  return {
    subscriptionId,
    plan,
    state: ScheduleState.Active,
    startedAt: now,
    chargesMade: 0,
    totalCharged: 0,
    pausedAt: null,
    pausedMs: 0,
  };
}

/**
 * How many charges are owed as of `now`.
 *
 * A function of the schedule, not a counter. A bot that missed a week comes
 * back, asks this, and gets the number it owes — and a bot that asks twice in
 * the same second gets the same answer both times and charges once.
 */
export function chargesDue(subscription: Subscription, now: number): number {
  assertTimestamp(now);
  if (subscription.state !== ScheduleState.Active) return 0;

  const elapsed = now - subscription.startedAt - subscription.pausedMs;
  if (elapsed < 0) return 0;

  let earned = Math.floor(elapsed / subscription.plan.intervalMs);
  if (subscription.plan.occurrences !== null) {
    earned = Math.min(earned, subscription.plan.occurrences);
  }
  return Math.max(0, earned - subscription.chargesMade);
}

/** When the next charge falls due, or `null` when there is no next one. */
export function nextChargeAt(subscription: Subscription): number | null {
  const plan = subscription.plan;
  if (subscription.state !== ScheduleState.Active) return null;
  if (plan.occurrences !== null && subscription.chargesMade >= plan.occurrences) {
    return null;
  }
  return (
    subscription.startedAt +
    subscription.pausedMs +
    (subscription.chargesMade + 1) * plan.intervalMs
  );
}

/**
 * Take every charge that is due, as one posting.
 *
 * One posting rather than one per charge: three missed weeks is one payment of
 * three times the amount, which is what a member sees on their statement and
 * what a single `operationId` can make idempotent. A caller who wants them
 * separate calls this once per charge with `limit: 1`.
 *
 * `null` comes back as the booking when nothing is due, which is the normal
 * result of a scheduler that runs more often than the interval.
 */
export function chargeSubscription(
  engine: EconomyEngine,
  subscription: Subscription,
  payer: Account,
  options: {
    now: number;
    operationId: string;
    reason: string;
    payee?: Account;
    limit?: number;
    metadata?: Record<string, string>;
  },
): ChargeResult {
  assertTimestamp(options.now);
  let due = chargesDue(subscription, options.now);
  if (options.limit !== undefined) {
    if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
      throw new ValidationError("limit must be a positive integer", { limit: options.limit });
    }
    due = Math.min(due, options.limit);
  }

  if (due === 0) {
    return { booking: null, subscription, charges: 0, amount: 0 };
  }
  if (due > MAX_CATCH_UP) {
    throw new ScheduleError(
      `${due} charges are due, which is past the ${MAX_CATCH_UP} this will take at once. Decide what to do about the gap, then charge with a limit.`,
      { subscriptionId: subscription.subscriptionId, due, limit: MAX_CATCH_UP },
    );
  }

  if (accountKey(payer.ref) !== accountKey(subscription.plan.payer)) {
    throw new ScheduleError("That account is not the payer", {
      expected: accountKey(subscription.plan.payer),
      given: accountKey(payer.ref),
    });
  }

  const amount = subscription.plan.amount * due;
  assertWholeAmount(amount);

  const booking = engine.transfer(
    payer,
    options.payee ?? emptyAccount(subscription.plan.payee),
    amount,
    {
      now: options.now,
      operationId: options.operationId,
      reason: options.reason,
      kind: PostingKind.Recurring,
      metadata: options.metadata,
    },
  );

  const chargesMade = subscription.chargesMade + due;
  const ended =
    subscription.plan.occurrences !== null && chargesMade >= subscription.plan.occurrences;
  return {
    booking,
    subscription: {
      ...subscription,
      chargesMade,
      totalCharged: subscription.totalCharged + amount,
      state: ended ? ScheduleState.Ended : subscription.state,
    },
    charges: due,
    amount,
  };
}

/**
 * Stop charges accruing, without ending the arrangement.
 *
 * The paused time is remembered and subtracted from the schedule, so a member
 * who pauses for a month is not billed for it when they come back. Without that
 * the pause would only postpone the bill, which is not what anybody means by
 * pausing.
 */
export function pauseSubscription(subscription: Subscription, now: number): Subscription {
  assertTimestamp(now);
  if (subscription.state !== ScheduleState.Active) {
    throw new ScheduleError("Only an active subscription can be paused", {
      subscriptionId: subscription.subscriptionId,
      state: subscription.state,
    });
  }
  return { ...subscription, state: ScheduleState.Paused, pausedAt: now };
}

/** Start charges accruing again. */
export function resumeSubscription(subscription: Subscription, now: number): Subscription {
  assertTimestamp(now);
  if (subscription.state !== ScheduleState.Paused) {
    throw new ScheduleError("Only a paused subscription can be resumed", {
      subscriptionId: subscription.subscriptionId,
      state: subscription.state,
    });
  }
  const pausedFor = Math.max(0, now - (subscription.pausedAt ?? now));
  return {
    ...subscription,
    state: ScheduleState.Active,
    pausedAt: null,
    pausedMs: subscription.pausedMs + pausedFor,
  };
}

/** End it. Charges already due are still due until they are taken. */
export function cancelSubscription(subscription: Subscription, now: number): Subscription {
  assertTimestamp(now);
  if (
    subscription.state === ScheduleState.Cancelled ||
    subscription.state === ScheduleState.Ended
  ) {
    throw new ScheduleError("That subscription is already over", {
      subscriptionId: subscription.subscriptionId,
      state: subscription.state,
    });
  }
  return { ...subscription, state: ScheduleState.Cancelled };
}

// ---------------------------------------------------------------------------
// Financing
// ---------------------------------------------------------------------------

/**
 * Buy now, pay over time: the seller is paid in full today.
 *
 * The currency goes from `system:credit` to the seller, and the buyer owes the
 * credit account on the returned schedule. Repayments go through `repay` in
 * `credit.ts` with a loan built from the same schedule, or through the caller's
 * own booking — what matters is that the debt is on the books from the moment
 * the goods change hands.
 *
 * The buyer's balance is untouched here. That is the point of financing.
 */
export function financePurchase(
  engine: EconomyEngine,
  options: {
    planId: string;
    buyer: AccountRef;
    seller: Account;
    cashPrice: number;
    rateBasisPoints: number;
    instalments: number;
    now: number;
    operationId: string;
    reason: string;
    method?: AmortisationMethod;
    rounding?: Rounding;
    creditAccount?: Account;
    metadata?: Record<string, string>;
  },
): { booking: BookingResult; plan: InstalmentPlan } {
  assertTimestamp(options.now);
  assertPositiveAmount(options.cashPrice);
  if (options.buyer.currency !== options.seller.ref.currency) {
    throw new CurrencyMismatchError({
      expected: options.seller.ref.currency,
      received: options.buyer.currency,
    });
  }
  if (accountKey(options.buyer) === accountKey(options.seller.ref)) {
    throw new ScheduleError("A member cannot finance a purchase from themselves", {
      account: accountKey(options.buyer),
    });
  }

  const schedule = amortisationSchedule(
    options.cashPrice,
    options.rateBasisPoints,
    options.instalments,
    options.method ?? AmortisationMethod.EqualInstalment,
    options.rounding ?? Rounding.Down,
  );

  const booking = engine.transfer(
    options.creditAccount ??
      emptyAccount(
        systemAccount(
          options.seller.ref.scope,
          options.seller.ref.currency,
          SystemAccount.Credit,
        ),
      ),
    options.seller,
    options.cashPrice,
    {
      now: options.now,
      operationId: options.operationId,
      reason: options.reason,
      kind: PostingKind.LoanDisbursement,
      allowNegative: true,
      metadata: options.metadata,
    },
  );

  return {
    booking,
    plan: {
      planId: options.planId,
      buyer: options.buyer,
      seller: options.seller.ref,
      cashPrice: options.cashPrice,
      schedule,
      openedAt: options.now,
      paidInstalments: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

/**
 * Pay several members at once, as one posting.
 *
 * One posting because it is one event: a payroll run either happens or it does
 * not, and half a payroll is the worst possible outcome. That is also why it is
 * one posting rather than a list of transfers — the caller writes it in a single
 * transaction, and the "all or nothing" is the database's to enforce.
 *
 * `recipients` gives the current balances, keyed by account key, when the caller
 * stores them and wants the posting's before-and-after figures to be right.
 * Leave it out and they are computed from zero, exactly as the system accounts
 * are elsewhere.
 */
export function runPayroll(
  engine: EconomyEngine,
  employer: Account,
  lines: readonly PayrollLine[],
  options: {
    now: number;
    operationId: string;
    reason: string;
    recipients?: Readonly<Record<string, Account>>;
    metadata?: Record<string, string>;
  },
): BookingResult {
  assertTimestamp(options.now);
  if (lines.length === 0) {
    throw new ScheduleError("A payroll run needs at least one line", {});
  }

  let total = 0;
  for (const line of lines) {
    assertPositiveAmount(line.amount);
    if (line.recipient.currency !== employer.ref.currency) {
      throw new CurrencyMismatchError({
        expected: employer.ref.currency,
        received: line.recipient.currency,
      });
    }
    if (line.recipient.scope !== employer.ref.scope) {
      throw new ValidationError("A payroll run cannot cross scopes", {
        employer: employer.ref.scope,
        recipient: line.recipient.scope,
      });
    }
    if (accountKey(line.recipient) === accountKey(employer.ref)) {
      throw new ScheduleError("A payroll run cannot pay the employer", {
        account: accountKey(employer.ref),
      });
    }
    total += line.amount;
  }
  assertWholeAmount(total);

  const seen = new Set<string>();
  for (const line of lines) {
    const key = accountKey(line.recipient);
    if (seen.has(key)) {
      throw new ScheduleError(
        "A payroll run must not pay the same account twice: add the amounts together instead",
        { account: key },
      );
    }
    seen.add(key);
  }

  engine.currency(employer.ref.currency);
  if (employer.balance < total) {
    throw new InsufficientFundsError({
      account: accountKey(employer.ref),
      balance: employer.balance,
      required: total,
      currency: employer.ref.currency,
    });
  }

  const postingLines: PostingLine[] = [
    {
      account: employer.ref,
      delta: -total,
      balanceBefore: employer.balance,
      balanceAfter: employer.balance - total,
    },
  ];
  for (const line of lines) {
    const key = accountKey(line.recipient);
    const before = options.recipients?.[key]?.balance ?? 0;
    postingLines.push({
      account: line.recipient,
      delta: line.amount,
      balanceBefore: before,
      balanceAfter: before + line.amount,
    });
  }

  const posting = createPosting({
    operationId: options.operationId,
    kind: PostingKind.Recurring,
    scope: employer.ref.scope,
    currency: employer.ref.currency,
    amount: total,
    reason: options.reason,
    occurredAt: options.now,
    lines: postingLines,
    metadata: options.metadata,
  });
  return { posting, balances: resultingBalances(posting) };
}

/**
 * Divide a pot between recipients, exactly.
 *
 * For a community that pays out a fixed budget rather than fixed salaries. The
 * shares add up to the pot; see {@link distribute} for why that needs saying.
 */
export function splitPayroll(
  total: number,
  recipients: readonly AccountRef[],
  weights?: readonly number[],
): PayrollLine[] {
  if (recipients.length === 0) {
    throw new ScheduleError("There is nobody to pay", {});
  }
  const shares = distribute(
    total,
    weights ?? new Array<number>(recipients.length).fill(1),
  );
  return recipients
    .map((recipient, index) => ({ recipient, amount: shares[index] as number }))
    .filter((line) => line.amount > 0);
}

function assertTimestamp(now: number): void {
  if (!Number.isSafeInteger(now)) {
    throw new ValidationError("Timestamps are epoch milliseconds as integers", {
      timestamp: now,
    });
  }
}
