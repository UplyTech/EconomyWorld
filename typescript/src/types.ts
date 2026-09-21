import type { Account, AccountRef } from "./accounts.js";
import type { Posting } from "./ledger.js";
import type { Currency } from "./money.js";

/**
 * What an activity is worth.
 *
 * Note what is *not* here: a random span. RankMode deliberately randomises XP
 * awards to make farming pointless, but EconomyWorld does not, and the reason
 * is legal rather than technical. Random payouts are the mechanism behind loot
 * boxes, and several EU jurisdictions treat those as gambling even without real
 * money involved. This package contains no randomness at all — see the
 * "Deliberately absent" section of the README.
 */
export interface EarnRule {
  /** Identifier the caller passes to `EconomyEngine.earn`. */
  readonly key: string;
  /** How much this activity pays, in minor units. Fixed, never random. */
  readonly amount: number;
  /** Which currency it pays in. */
  readonly currency: string;
  /** Minimum distance between two paying events of this kind, per member. */
  readonly cooldownSeconds: number;
  /** Ceiling per period, or `null` for no ceiling. */
  readonly periodCapAmount: number | null;
  /** Length of the capping period. */
  readonly periodSeconds: number;
  /** A disabled rule pays nothing and reports `EarnOutcome.RuleDisabled`. */
  readonly enabled: boolean;
}

/** Loose input for `createEarnRule`. */
export interface EarnRuleInput {
  readonly key: string;
  readonly amount: number;
  readonly currency: string;
  readonly cooldownSeconds?: number;
  readonly periodCapAmount?: number | null;
  readonly periodSeconds?: number;
  readonly enabled?: boolean;
}

/**
 * What the caller has to remember about a member's earning.
 *
 * Small enough to live in one JSON column next to the balance. The caller owns
 * it: load it, hand it in, store the copy that comes back.
 */
export interface EarnState {
  /** rule key -> epoch milliseconds of the last payout. */
  lastEarnedAt: Record<string, number>;
  /** rule key -> start of the running period. */
  periodStartAt: Record<string, number>;
  /** rule key -> how much has been paid inside the running period. */
  periodEarned: Record<string, number>;
}

/** Why an earning attempt turned out the way it did. */
export enum EarnOutcome {
  /** Currency was paid out. */
  Earned = "EARNED",
  /** The cooldown for this rule has not expired yet. */
  Cooldown = "COOLDOWN",
  /** The period ceiling for this rule is exhausted. */
  PeriodCap = "PERIOD_CAP",
  /** The rule exists but is switched off. */
  RuleDisabled = "RULE_DISABLED",
  /** No rule matched the key. */
  UnknownRule = "UNKNOWN_RULE",
  /** The account is already at the currency's ceiling. */
  MaxBalanceReached = "MAX_BALANCE_REACHED",
  /** The rule matched but the payable amount came to zero. */
  NoAmount = "NO_AMOUNT",
}

/** The result of a booking that always happens. */
export interface BookingResult {
  /**
   * The complete booking.
   *
   * **Write every line of it in one database transaction.** See the module
   * comment in `ledger.ts` for why this is your obligation and not the
   * library's.
   */
  readonly posting: Posting;
  /** Resulting balance per account key, for convenience. */
  readonly balances: Readonly<Record<string, number>>;
}

/** The result of an earning attempt, which may legitimately pay nothing. */
export interface EarnResult {
  readonly outcome: EarnOutcome;
  /** The booking, or `null` when nothing was paid. */
  readonly posting: Posting | null;
  /** What was actually paid, after the cap was applied. */
  readonly amount: number;
  /** What the rule would have paid without caps. */
  readonly grossAmount: number;
  readonly previousBalance: number;
  readonly newBalance: number;
  /** Milliseconds until the cooldown expires. `0` when it is not active. */
  readonly cooldownRemainingMs: number;
  /** What is left of the period ceiling, or `null` when uncapped. */
  readonly periodRemaining: number | null;
  /** The rule that was applied, or `null`. */
  readonly rule: EarnRule | null;
  /** The new earning state. Persist it; the input is left untouched. */
  readonly state: EarnState;
}

/** Optional shrinkage, so hoarded balances do not freeze an economy. */
export interface DecayRule {
  /** A flat amount removed per elapsed period. */
  readonly amountPerPeriod: number;
  /**
   * A share of the balance removed per elapsed period, in permille.
   *
   * Applied after the flat amount. `10` means one percent per period.
   */
  readonly permillePerPeriod: number;
  readonly periodSeconds: number;
  /** Decay never pushes a balance below this. */
  readonly floor: number;
  /** No decay until this much time has passed since the last activity. */
  readonly graceSeconds: number;
}

/** The result of a decay run. */
export interface DecayResult {
  /** The booking, or `null` when nothing was due. */
  readonly posting: Posting | null;
  readonly amount: number;
  readonly periods: number;
  readonly previousBalance: number;
  readonly newBalance: number;
  /** Pass this back as `lastAppliedAt` on the next run. */
  readonly appliedUpTo: number;
}

/** Configuration handed to `EconomyEngine` once, at construction. */
export interface EconomyConfigInput {
  readonly currencies: readonly (Currency | { code: string })[];
  readonly earnRules?: readonly (EarnRule | EarnRuleInput)[];
  /**
   * Let member accounts go below zero.
   *
   * Off by default. A negative balance is almost always a bug, and a debt
   * nobody agreed to is a support ticket.
   */
  readonly allowNegative?: boolean;
  /** Where shop payments land. Defaults to the scope's shop account. */
  readonly shopAccountOwner?: string;
}

/** The frozen, validated form of {@link EconomyConfigInput}. */
export interface EconomyConfig {
  readonly currencies: ReadonlyMap<string, Currency>;
  readonly earnRules: ReadonlyMap<string, EarnRule>;
  readonly allowNegative: boolean;
  readonly shopAccountOwner: string;
}

/** Options shared by every booking call. */
export interface BookingOptions {
  /** Epoch milliseconds. Handed in, never read from the clock. */
  readonly now: number;
  /**
   * Idempotency key. Must be unique across all postings.
   *
   * Derive it from whatever caused the request so a retry produces the same
   * key and your database's unique constraint catches it.
   */
  readonly operationId: string;
  /** Why this happened, in your own words. Ends up in the audit trail. */
  readonly reason: string;
  /** Free-form context. */
  readonly metadata?: Record<string, string>;
}

/** An account plus the reference of the counter-account for a booking. */
export interface CounterAccount {
  readonly ref: AccountRef;
  readonly balance: number;
}

export type { Account, AccountRef, Currency, Posting };
