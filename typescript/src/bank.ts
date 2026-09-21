/**
 * Deposits, term accounts and holds.
 *
 * A current account is a balance. A **deposit** is a balance that has been put
 * somewhere for a reason: to earn interest, or to be locked until a date. This
 * module is the difference between the two.
 *
 * # A deposit is a real movement, not a flag
 *
 * When a member deposits, the currency leaves their account and arrives in the
 * scope's `system:bank` account. That is deliberate and it costs a posting,
 * because the alternative — a "savings" number stored beside the balance — makes
 * "how much is on deposit in this community?" a question you answer by summing
 * every member's row and hoping none of them is stale. Here it is one balance,
 * and the books close on it.
 *
 * # Interest is minted, and the posting says so
 *
 * Interest paid on a deposit is new currency: it comes from `system:mint`, like
 * every other issuance, and the mint's balance goes more negative by exactly the
 * amount paid. There is no other honest way to do it in a closed economy, and
 * pretending otherwise is how a community ends up unable to say where its money
 * came from.
 *
 * An operator who wants interest funded out of collected fees rather than minted
 * passes the fee account as the source. The posting then says *that*, and the
 * money supply does not move.
 *
 * # A hold is not a posting
 *
 * A hold reserves funds without moving them: an order placed, a bid made, a
 * purchase authorised but not captured. Nothing is booked until the hold is
 * captured, and a hold that expires releases itself.
 *
 * That is why {@link placeHold} returns a {@link Hold} rather than a posting.
 * The caller stores it, and every balance check that should respect it goes
 * through {@link availableBalance}.
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
  DepositError,
  HoldError,
  InsufficientFundsError,
  ValidationError,
} from "./errors.js";
import { AccrualBasis, accrueInterest } from "./interest.js";
import { PostingKind } from "./ledger.js";
import { applyBasisPoints, assertPositiveAmount, assertWholeAmount } from "./money.js";
import { Rounding } from "./rounding.js";
import type { BookingResult } from "./types.js";

/** What a deposit account pays, and what it asks in return. */
export interface DepositTerms {
  /** What the deposit earns each period, in basis points. */
  readonly rateBasisPoints: number;
  /** Whether interest earns interest. */
  readonly basis: AccrualBasis;
  /**
   * How each period's interest is rounded. `Down` favours the economy, `Up`
   * favours the member; whichever is chosen, both sides of the posting use the
   * same number.
   */
  readonly rounding: Rounding;
  /**
   * How long the money is locked, in milliseconds. `0` is an on-demand account:
   * deposit and withdraw whenever you like.
   */
  readonly termMs: number;
  /**
   * What withdrawing before maturity costs, in basis points of the interest
   * earned so far. `10000` forfeits all of it.
   *
   * The penalty is taken out of the *interest*, never out of the principal. A
   * term account that can hand a member back less than they put in is a product
   * nobody should ship by accident.
   */
  readonly earlyWithdrawalPenaltyBp: number;
  /**
   * The least that may be left on deposit. A withdrawal that would leave less
   * takes the whole balance instead.
   */
  readonly minimumBalance: number;
}

/** A member's deposit, as the caller stores it. */
export interface Deposit {
  readonly depositId: string;
  /** Whose it is. The account the money came from and returns to. */
  readonly owner: AccountRef;
  readonly terms: DepositTerms;
  /** The amount put in, less anything withdrawn. Never includes interest. */
  readonly principal: number;
  /** Interest credited so far and not yet withdrawn. */
  readonly accruedInterest: number;
  /** When the deposit was opened, in epoch milliseconds. */
  readonly openedAt: number;
  /** When interest was last credited. Interest accrues from here. */
  readonly lastAccruedAt: number;
  /** Periods already credited, so a caller can see the history line up. */
  readonly periodsAccrued: number;
}

/**
 * Funds reserved on an account without being moved.
 *
 * An authorisation, not a payment. It exists so that a member cannot spend the
 * same balance twice while an order sits on a book or a bid stands in an
 * auction, and it disappears on its own when it expires.
 */
export interface Hold {
  readonly holdId: string;
  readonly account: AccountRef;
  readonly amount: number;
  readonly placedAt: number;
  /**
   * When the hold stops reserving anything. `null` never expires, which should
   * be rare: a hold nobody releases is a member who cannot spend.
   */
  readonly expiresAt: number | null;
  readonly reason: string;
}

/** Principal plus interest: what the member would get back today. */
export function depositBalance(account: Deposit): number {
  return account.principal + account.accruedInterest;
}

/** Build validated deposit terms. */
export function createDepositTerms(options: Partial<DepositTerms> = {}): DepositTerms {
  const terms: DepositTerms = {
    rateBasisPoints: options.rateBasisPoints ?? 0,
    basis: options.basis ?? AccrualBasis.Compound,
    rounding: options.rounding ?? Rounding.Down,
    termMs: options.termMs ?? 0,
    earlyWithdrawalPenaltyBp: options.earlyWithdrawalPenaltyBp ?? 0,
    minimumBalance: options.minimumBalance ?? 0,
  };
  if (!Number.isSafeInteger(terms.termMs) || terms.termMs < 0) {
    throw new DepositError("termMs must be a non-negative integer", { termMs: terms.termMs });
  }
  if (
    !Number.isSafeInteger(terms.earlyWithdrawalPenaltyBp) ||
    terms.earlyWithdrawalPenaltyBp < 0 ||
    terms.earlyWithdrawalPenaltyBp > 10_000
  ) {
    throw new DepositError(
      "earlyWithdrawalPenaltyBp must be between 0 and 10000 basis points",
      { earlyWithdrawalPenaltyBp: terms.earlyWithdrawalPenaltyBp },
    );
  }
  if (terms.termMs === 0 && terms.earlyWithdrawalPenaltyBp !== 0) {
    throw new DepositError(
      "An on-demand account cannot have an early-withdrawal penalty: there is nothing to be early for",
      { termMs: terms.termMs, earlyWithdrawalPenaltyBp: terms.earlyWithdrawalPenaltyBp },
    );
  }
  assertWholeAmount(terms.minimumBalance);
  if (terms.minimumBalance < 0) {
    throw new DepositError("minimumBalance cannot be negative", {
      minimumBalance: terms.minimumBalance,
    });
  }
  return terms;
}

/** An empty deposit, before anything has been paid into it. */
export function openDeposit(
  depositId: string,
  owner: AccountRef,
  terms: DepositTerms,
  now: number,
): Deposit {
  if (typeof depositId !== "string" || depositId.length === 0) {
    throw new ValidationError("A deposit needs a non-empty id", { depositId });
  }
  assertTimestamp(now);
  return {
    depositId,
    owner,
    terms,
    principal: 0,
    accruedInterest: 0,
    openedAt: now,
    lastAccruedAt: now,
    periodsAccrued: 0,
  };
}

/**
 * Move currency out of a member's balance and onto deposit.
 *
 * Returns the posting *and* the updated deposit. Both belong in the same
 * database transaction, for the same reason every other pair in this package
 * does: a deposit whose principal grew but whose posting was never written is
 * currency invented by a crash.
 */
export function deposit(
  engine: EconomyEngine,
  account: Deposit,
  fromAccount: Account,
  amount: number,
  options: {
    now: number;
    operationId: string;
    reason: string;
    bankAccount?: Account;
    metadata?: Record<string, string>;
  },
): { booking: BookingResult; deposit: Deposit } {
  assertPositiveAmount(amount);
  assertTimestamp(options.now);
  assertOwner(account, fromAccount);

  const booking = engine.transfer(
    fromAccount,
    options.bankAccount ??
      emptyAccount(systemAccount(account.owner.scope, account.owner.currency, SystemAccount.Bank)),
    amount,
    {
      now: options.now,
      operationId: options.operationId,
      reason: options.reason,
      kind: PostingKind.Deposit,
      metadata: options.metadata,
    },
  );
  return { booking, deposit: { ...account, principal: account.principal + amount } };
}

/**
 * Take currency back off deposit.
 *
 * Interest is drawn down before principal, which is the order every deposit
 * product uses and the one that makes an early-withdrawal penalty possible: the
 * penalty comes out of interest, so it has to be spent last.
 *
 * Withdrawing before maturity costs `earlyWithdrawalPenaltyBp` of the interest
 * earned. The penalty is *forfeited*, not paid to anybody — it never left the
 * mint, so the posting simply issues less.
 */
export function withdraw(
  engine: EconomyEngine,
  account: Deposit,
  toAccount: Account,
  amount: number,
  options: {
    now: number;
    operationId: string;
    reason: string;
    bankAccount?: Account;
    metadata?: Record<string, string>;
  },
): { booking: BookingResult; deposit: Deposit } {
  assertPositiveAmount(amount);
  assertTimestamp(options.now);
  assertOwner(account, toAccount);

  const penalty = earlyWithdrawalPenalty(account, options.now);
  const withdrawable = depositBalance(account) - penalty;

  if (amount > withdrawable) {
    throw new DepositError("The deposit does not hold that much", {
      depositId: account.depositId,
      available: withdrawable,
      requested: amount,
      penalty,
    });
  }

  const remaining = withdrawable - amount;
  if (remaining > 0 && remaining < account.terms.minimumBalance) {
    throw new DepositError(
      "That withdrawal would leave less than the minimum balance; withdraw everything or less",
      {
        depositId: account.depositId,
        minimumBalance: account.terms.minimumBalance,
        wouldLeave: remaining,
      },
    );
  }

  // Interest first, then principal. The penalty is taken off the interest before
  // any of it is drawn, so a member who forfeits it cannot also spend it in the
  // same call.
  const interestAvailable = Math.max(0, account.accruedInterest - penalty);
  const fromInterest = Math.min(amount, interestAvailable);
  const fromPrincipal = amount - fromInterest;

  const booking = engine.transfer(
    options.bankAccount ??
      emptyAccount(systemAccount(account.owner.scope, account.owner.currency, SystemAccount.Bank)),
    toAccount,
    amount,
    {
      now: options.now,
      operationId: options.operationId,
      reason: options.reason,
      kind: PostingKind.Withdrawal,
      allowNegative: true,
      metadata: options.metadata,
    },
  );

  return {
    booking,
    deposit: {
      ...account,
      principal: account.principal - fromPrincipal,
      // Whatever the penalty forfeited leaves with the withdrawal: it is not
      // kept on the books as interest the member no longer has a claim to.
      accruedInterest: account.accruedInterest - fromInterest - penalty,
    },
  };
}

/**
 * Credit interest for a number of periods.
 *
 * `null` comes back instead of a posting when there is nothing to credit — a
 * zero rate, an empty account, a rate too small to earn a whole unit. That is an
 * ordinary outcome and not an error, and a caller running this nightly across a
 * whole community will see a lot of it.
 *
 * **How long a period is, is yours.** This function applies a rate `periods`
 * times; whether that means a day or a message is a decision about your economy.
 * `now` is recorded so a caller can tell when interest was last paid, but it is
 * never used to work out how much: a function that read the clock could not be
 * tested.
 */
export function accrueDepositInterest(
  engine: EconomyEngine,
  account: Deposit,
  periods: number,
  options: {
    now: number;
    operationId: string;
    reason: string;
    source?: Account;
    bankAccount?: Account;
    metadata?: Record<string, string>;
  },
): { booking: BookingResult | null; deposit: Deposit } {
  assertTimestamp(options.now);
  if (!Number.isSafeInteger(periods) || periods < 0) {
    throw new ValidationError("periods must be a non-negative integer", { periods });
  }

  const interest = accrueInterest(
    depositBalance(account),
    account.terms.rateBasisPoints,
    periods,
    account.terms.basis,
    account.terms.rounding,
  );

  const updated: Deposit = {
    ...account,
    accruedInterest: account.accruedInterest + interest,
    lastAccruedAt: options.now,
    periodsAccrued: account.periodsAccrued + periods,
  };

  if (interest === 0) {
    return { booking: null, deposit: updated };
  }

  const booking = engine.transfer(
    options.source ??
      emptyAccount(systemAccount(account.owner.scope, account.owner.currency, SystemAccount.Mint)),
    options.bankAccount ??
      emptyAccount(systemAccount(account.owner.scope, account.owner.currency, SystemAccount.Bank)),
    interest,
    {
      now: options.now,
      operationId: options.operationId,
      reason: options.reason,
      kind: PostingKind.Interest,
      allowNegative: true,
      metadata: options.metadata,
    },
  );
  return { booking, deposit: updated };
}

/** Whether the lock-up has run out. Always true for an on-demand account. */
export function isMature(account: Deposit, now: number): boolean {
  assertTimestamp(now);
  if (account.terms.termMs === 0) return true;
  return now >= account.openedAt + account.terms.termMs;
}

/**
 * What the deposit would be worth after another `periods` of interest.
 *
 * A projection, for a screen that tells a member what locking their money up is
 * worth. It books nothing and reads no clock.
 */
export function maturityValue(account: Deposit, periods: number): number {
  return (
    depositBalance(account) +
    accrueInterest(
      depositBalance(account),
      account.terms.rateBasisPoints,
      periods,
      account.terms.basis,
      account.terms.rounding,
    )
  );
}

/**
 * What withdrawing right now would forfeit.
 *
 * Zero once the deposit is mature, and zero for an on-demand account. Always a
 * share of the *interest*, never of the principal.
 */
export function earlyWithdrawalPenalty(account: Deposit, now: number): number {
  if (isMature(account, now) || account.terms.earlyWithdrawalPenaltyBp === 0) return 0;
  if (account.accruedInterest <= 0) return 0;
  return applyBasisPoints(
    account.accruedInterest,
    account.terms.earlyWithdrawalPenaltyBp,
    Rounding.Down,
  );
}

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

/**
 * Reserve funds without moving them.
 *
 * Checked against what is *available* rather than against the balance, so two
 * holds cannot reserve the same currency twice. That check is the entire reason
 * holds exist: without it a member can place an order, bid in an auction and buy
 * from a shop with one balance, and two of the three fail at settlement when the
 * money has already gone.
 */
export function placeHold(
  holdId: string,
  account: Account,
  amount: number,
  options: {
    now: number;
    reason: string;
    existing?: readonly Hold[];
    expiresAt?: number | null;
  },
): Hold {
  if (typeof holdId !== "string" || holdId.length === 0) {
    throw new ValidationError("A hold needs a non-empty id", { holdId });
  }
  assertPositiveAmount(amount);
  assertTimestamp(options.now);
  const existing = options.existing ?? [];
  const expiresAt = options.expiresAt ?? null;
  if (expiresAt !== null) {
    assertTimestamp(expiresAt);
    if (expiresAt <= options.now) {
      throw new HoldError("A hold cannot expire before it is placed", {
        placedAt: options.now,
        expiresAt,
      });
    }
  }
  for (const held of existing) {
    if (held.holdId === holdId) {
      throw new HoldError("That hold id is already in use", { holdId });
    }
  }

  const available = availableBalance(account, existing, options.now);
  if (amount > available) {
    throw new InsufficientFundsError({
      account: accountKey(account.ref),
      balance: available,
      required: amount,
      currency: account.ref.currency,
    });
  }

  return {
    holdId,
    account: account.ref,
    amount,
    placedAt: options.now,
    expiresAt,
    reason: options.reason,
  };
}

/** Drop a hold, freeing the funds. Nothing is booked. */
export function releaseHold(holds: readonly Hold[], holdId: string): Hold[] {
  const remaining = holds.filter((held) => held.holdId !== holdId);
  if (remaining.length === holds.length) {
    throw new HoldError("No such hold", { holdId });
  }
  return remaining;
}

/**
 * Turn a hold into a real movement.
 *
 * Capturing for less than was held is allowed and is the normal case for
 * anything priced at the time it is authorised: the difference is simply
 * released. Capturing for more is not — that would spend currency the hold never
 * reserved.
 */
export function captureHold(
  engine: EconomyEngine,
  hold: Hold,
  source: Account,
  target: Account,
  options: {
    now: number;
    operationId: string;
    reason: string;
    amount?: number;
    holds?: readonly Hold[];
    kind?: PostingKind;
    metadata?: Record<string, string>;
  },
): { booking: BookingResult; holds: Hold[] } {
  assertTimestamp(options.now);
  const taking = options.amount ?? hold.amount;
  assertPositiveAmount(taking);
  if (taking > hold.amount) {
    throw new HoldError("A capture cannot take more than the hold reserved", {
      holdId: hold.holdId,
      held: hold.amount,
      requested: taking,
    });
  }
  if (accountKey(source.ref) !== accountKey(hold.account)) {
    throw new HoldError("The hold is on a different account", {
      hold: accountKey(hold.account),
      source: accountKey(source.ref),
    });
  }
  if (hold.expiresAt !== null && options.now >= hold.expiresAt) {
    throw new HoldError("The hold has expired", {
      holdId: hold.holdId,
      expiresAt: hold.expiresAt,
    });
  }

  const booking = engine.transfer(source, target, taking, {
    now: options.now,
    operationId: options.operationId,
    reason: options.reason,
    kind: options.kind ?? PostingKind.Transfer,
    allowNegative: false,
    metadata: options.metadata,
  });
  return {
    booking,
    holds: (options.holds ?? []).filter((held) => held.holdId !== hold.holdId),
  };
}

/** The holds that still reserve anything at `now`. */
export function activeHolds(holds: readonly Hold[], now: number): Hold[] {
  assertTimestamp(now);
  return holds.filter((held) => held.expiresAt === null || now < held.expiresAt);
}

/** How much the active holds reserve in total. */
export function heldAmount(holds: readonly Hold[], now: number): number {
  return activeHolds(holds, now).reduce((total, held) => total + held.amount, 0);
}

/**
 * The balance minus what is held: what the member can actually spend.
 *
 * The number a bot should show and a spend should be checked against. It can be
 * negative if the balance fell below what was held — through a fee, or a decay
 * run — and that is reported rather than clamped, because a caller that sees it
 * needs to decide what to do about it.
 */
export function availableBalance(
  account: Account,
  holds: readonly Hold[],
  now: number,
): number {
  const key = accountKey(account.ref);
  const relevant = holds.filter((held) => accountKey(held.account) === key);
  return account.balance - heldAmount(relevant, now);
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function assertOwner(account: Deposit, member: Account): void {
  if (accountKey(member.ref) !== accountKey(account.owner)) {
    throw new DepositError("That account does not own this deposit", {
      depositId: account.depositId,
      owner: accountKey(account.owner),
      given: accountKey(member.ref),
    });
  }
  // No currency check follows: an AccountRef carries its currency, so the
  // comparison above has already settled it.
}

// ---------------------------------------------------------------------------
// Escrow
//
// A hold reserves a balance where it is. Escrow moves it. Both stop a member
// promising the same currency twice; they differ in what the counterparty can
// see and in what happens if the caller crashes half way through.
// ---------------------------------------------------------------------------

/**
 * Move currency out of a member's balance and into the scope's escrow.
 *
 * The heavier sibling of {@link placeHold}, and the choice is a real one:
 *
 * | | |
 * |---|---|
 * | {@link placeHold} | Nothing is booked. The balance stays where it is and is merely not spendable. Cheap, reversible, and invisible to anybody but the caller — a counterparty has to take the caller's word that the funds exist. |
 * | `placeInEscrow` | A posting. The currency is really in a third account, which both sides can see, and it is out of the payer's reach even if the caller's process dies. |
 *
 * Use a hold for an order on a book that may never fill. Use escrow for a
 * high-value trade where the seller wants to see the money before they hand
 * anything over.
 *
 * Escrow is *not* used by {@link settleTrade}: a trade moves nothing until it
 * settles, which is what makes an abandoned trade harmless. A caller who wants
 * funds escrowed while a trade is open books it here, and releases or settles
 * it themselves.
 */
export function placeInEscrow(
  engine: EconomyEngine,
  source: Account,
  amount: number,
  options: {
    now: number;
    operationId: string;
    reason: string;
    escrowAccount?: Account;
    metadata?: Record<string, string>;
  },
): BookingResult {
  assertPositiveAmount(amount);
  assertTimestamp(options.now);
  return engine.transfer(
    source,
    options.escrowAccount ??
      emptyAccount(systemAccount(source.ref.scope, source.ref.currency, SystemAccount.Escrow)),
    amount,
    {
      now: options.now,
      operationId: options.operationId,
      reason: options.reason,
      kind: PostingKind.Escrow,
      metadata: options.metadata,
    },
  );
}

/**
 * Give escrowed currency back: the deal fell through.
 *
 * Books `PostingKind.EscrowRelease` rather than `Escrow`, so a statement reads
 * "went into escrow, came back out" instead of two identical lines a member has
 * to work out for themselves.
 *
 * **Pass `escrowAccount` if you store system balances.** Doing so is what stops
 * a release exceeding what is actually in escrow: the engine lets a system
 * account go negative on purpose, so without the account this function has
 * nothing to check against.
 */
export function releaseFromEscrow(
  engine: EconomyEngine,
  target: Account,
  amount: number,
  options: {
    now: number;
    operationId: string;
    reason: string;
    escrowAccount?: Account;
    metadata?: Record<string, string>;
  },
): BookingResult {
  assertPositiveAmount(amount);
  assertTimestamp(options.now);
  assertEscrowCovers(options.escrowAccount, amount);
  return engine.transfer(
    options.escrowAccount ??
      emptyAccount(systemAccount(target.ref.scope, target.ref.currency, SystemAccount.Escrow)),
    target,
    amount,
    {
      now: options.now,
      operationId: options.operationId,
      reason: options.reason,
      kind: PostingKind.EscrowRelease,
      metadata: options.metadata,
    },
  );
}

/**
 * Pay escrowed currency to the counterparty: the deal went through.
 *
 * The same posting shape as {@link releaseFromEscrow} and a different kind,
 * because "the seller was paid" and "the buyer got their money back" are the two
 * outcomes an operator will be asked to tell apart six months later. Pass
 * `escrowAccount` for the same reason as there.
 */
export function settleFromEscrow(
  engine: EconomyEngine,
  target: Account,
  amount: number,
  options: {
    now: number;
    operationId: string;
    reason: string;
    escrowAccount?: Account;
    metadata?: Record<string, string>;
  },
): BookingResult {
  assertPositiveAmount(amount);
  assertTimestamp(options.now);
  assertEscrowCovers(options.escrowAccount, amount);
  return engine.transfer(
    options.escrowAccount ??
      emptyAccount(systemAccount(target.ref.scope, target.ref.currency, SystemAccount.Escrow)),
    target,
    amount,
    {
      now: options.now,
      operationId: options.operationId,
      reason: options.reason,
      kind: PostingKind.Settlement,
      metadata: options.metadata,
    },
  );
}

/**
 * Refuse to take more out of escrow than the caller says is in it.
 *
 * The engine lets a system account go negative on purpose — the mint issues,
 * the market pays a seller before anybody has paid it, and a caller who does
 * not store system balances passes nothing and gets a zero it is meant to
 * ignore. That rule is right for those accounts and wrong for this one: escrow
 * holds what was put in it, and a negative escrow balance is currency paid out
 * that nobody ever escrowed.
 *
 * So the check is here rather than in the engine, and it is conditional on the
 * caller having handed the account over. Pass the escrow account and this will
 * not let a release exceed it; pass nothing and it cannot know, which is the
 * same bargain the rest of the library strikes about system balances.
 */
function assertEscrowCovers(escrow: Account | undefined, amount: number): void {
  if (escrow !== undefined && escrow.balance < amount) {
    throw new InsufficientFundsError({
      account: accountKey(escrow.ref),
      balance: escrow.balance,
      required: amount,
      currency: escrow.ref.currency,
    });
  }
}

function assertTimestamp(now: number): void {
  if (!Number.isSafeInteger(now)) {
    throw new ValidationError("Timestamps are epoch milliseconds as integers", {
      timestamp: now,
    });
  }
}
