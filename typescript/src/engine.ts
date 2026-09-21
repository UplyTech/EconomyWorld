import {
  type Account,
  type AccountRef,
  accountKey,
  emptyAccount,
  isSystemAccount,
  sameAccount,
  SystemAccount,
  systemAccount,
} from "./accounts.js";
import { DEFAULT_PERIOD_SECONDS, MIN_BALANCE } from "./constants.js";
import {
  BalanceOverflowError,
  ConfigurationError,
  CurrencyMismatchError,
  InsufficientFundsError,
  ReversalError,
  UnknownReferenceError,
  ValidationError,
} from "./errors.js";
import {
  createPosting,
  type Posting,
  PostingKind,
  type PostingLine,
  resultingBalances,
} from "./ledger.js";
import { assertPositiveAmount, assertWholeAmount, createCurrency, type Currency } from "./money.js";
import {
  type BookingOptions,
  type BookingResult,
  type DecayResult,
  type DecayRule,
  type EarnResult,
  type EarnRule,
  type EarnRuleInput,
  type EarnState,
  type EconomyConfig,
  type EconomyConfigInput,
  EarnOutcome,
} from "./types.js";

/**
 * The economy engine: balances in, a complete booking out.
 *
 * Every method is pure with respect to its arguments. Nothing is stored,
 * nothing is logged, no clock is read. What comes back is a {@link Posting}
 * that the caller must write **in a single database transaction** — see the
 * module comment in `ledger.ts`.
 */
export class EconomyEngine {
  public readonly config: EconomyConfig;

  constructor(input: EconomyConfigInput) {
    this.config = freezeConfig(input);
  }

  /** A configured currency, or a thrown {@link UnknownReferenceError}. */
  public currency(code: string): Currency {
    const currency = this.config.currencies.get(code);
    if (currency === undefined) {
      throw new UnknownReferenceError("currency", code);
    }
    return currency;
  }

  /** An earning rule, or `null`. */
  public earnRule(key: string): EarnRule | null {
    return this.config.earnRules.get(key) ?? null;
  }

  // -- the three primitive bookings ---------------------------------------

  /**
   * Issue new currency into an account.
   *
   * The counter-line is the scope's mint, which goes negative by exactly the
   * amount issued. That is not an accident of the design — it is what lets you
   * ask "how much currency exists in this scope?" and get an answer that is
   * checkable rather than assumed.
   */
  public credit(
    target: Account,
    amount: number,
    options: BookingOptions & { source?: Account },
  ): BookingResult {
    assertPositiveAmount(amount);
    assertTimestamp(options.now);
    const currency = this.currency(target.ref.currency);
    this.assertHeadroom(target, amount, currency);

    const source =
      options.source ??
      emptyAccount(systemAccount(target.ref.scope, target.ref.currency, SystemAccount.Mint));
    assertSameCurrency(source.ref, target.ref);

    return this.book({
      kind: PostingKind.Credit,
      from: source,
      to: target,
      amount,
      options,
    });
  }

  /**
   * Take currency out of an account and out of circulation.
   *
   * The counter-line is the scope's sink. Use this for fees, fines and anything
   * else that should reduce the money supply rather than move it to someone.
   */
  public debit(
    source: Account,
    amount: number,
    options: BookingOptions & { target?: Account; allowNegative?: boolean },
  ): BookingResult {
    assertPositiveAmount(amount);
    assertTimestamp(options.now);
    this.currency(source.ref.currency);
    this.assertFunds(source, amount, options.allowNegative);

    const target =
      options.target ??
      emptyAccount(systemAccount(source.ref.scope, source.ref.currency, SystemAccount.Sink));
    assertSameCurrency(source.ref, target.ref);

    return this.book({
      kind: PostingKind.Debit,
      from: source,
      to: target,
      amount,
      options,
    });
  }

  /**
   * Move currency between two accounts.
   *
   * The most common booking after earning and spending, and the one the concept
   * singles out: a transfer is two changes that must both happen or neither.
   *
   * `options.kind` labels the posting. It defaults to `TRANSFER` and exists so
   * that the subsystems built on top of this one — a deposit, an instalment, a
   * fee — produce postings an audit trail can tell apart. Two members paying
   * each other and a loan being disbursed are both money moving between
   * accounts, and only the label says which is which.
   * The posting you get back expresses exactly that; writing it atomically is
   * your side of the bargain.
   */
  public transfer(
    from: Account,
    to: Account,
    amount: number,
    options: BookingOptions & { allowNegative?: boolean; kind?: PostingKind },
  ): BookingResult {
    assertPositiveAmount(amount);
    assertTimestamp(options.now);
    assertSameCurrency(from.ref, to.ref);
    if (from.ref.scope !== to.ref.scope) {
      throw new ValidationError("A transfer cannot cross scopes", {
        from: from.ref.scope,
        to: to.ref.scope,
      });
    }
    if (sameAccount(from.ref, to.ref)) {
      throw new ValidationError("An account cannot transfer to itself", {
        account: accountKey(from.ref),
      });
    }

    const currency = this.currency(from.ref.currency);
    this.assertFunds(from, amount, options.allowNegative);
    this.assertHeadroom(to, amount, currency);

    return this.book({ kind: options.kind ?? PostingKind.Transfer, from, to, amount, options });
  }

  // -- earning -------------------------------------------------------------

  /**
   * Pay a member for an activity, subject to cooldown and daily ceiling.
   *
   * The order of checks is fixed and part of the public contract:
   *
   * 1. find the rule — an unknown key pays nothing
   * 2. rule disabled — pays nothing
   * 3. cooldown — pays nothing, and does **not** restart the cooldown
   * 4. take the rule's fixed amount (never random — see {@link EarnRule})
   * 5. trim to what is left of the period ceiling
   * 6. trim to the account's headroom under the currency ceiling
   *
   * Steps 3, 5 and 6 produce an outcome rather than an exception: an exhausted
   * cooldown is normal operation, not a fault.
   *
   * Without limits, a community economy is worthless within days — which is why
   * the cooldown and the ceiling are core parameters of the rule rather than
   * something bolted on later.
   */
  public earn(
    target: Account,
    ruleKey: string,
    state: EarnState,
    options: BookingOptions & { source?: Account },
  ): EarnResult {
    assertTimestamp(options.now);
    const rule = this.earnRule(ruleKey);
    const previousBalance = target.balance;

    if (rule === null) {
      return nothingEarned(EarnOutcome.UnknownRule, null, previousBalance, state, 0, null);
    }
    if (!rule.enabled) {
      return nothingEarned(EarnOutcome.RuleDisabled, rule, previousBalance, state, 0, null);
    }
    if (rule.currency !== target.ref.currency) {
      throw new CurrencyMismatchError({
        expected: rule.currency,
        received: target.ref.currency,
        account: accountKey(target.ref),
      });
    }

    const cooldownRemaining = this.earnCooldownRemainingMs(state, ruleKey, options.now);
    if (cooldownRemaining > 0) {
      return nothingEarned(
        EarnOutcome.Cooldown,
        rule,
        previousBalance,
        state,
        cooldownRemaining,
        this.earnPeriodRemaining(state, ruleKey, options.now),
      );
    }

    const currency = this.currency(rule.currency);
    if (previousBalance >= currency.maxBalance) {
      return nothingEarned(
        EarnOutcome.MaxBalanceReached,
        rule,
        previousBalance,
        state,
        0,
        null,
      );
    }

    const grossAmount = rule.amount;
    let amount = grossAmount;

    const periodRemaining = this.earnPeriodRemaining(state, ruleKey, options.now);
    if (periodRemaining !== null) {
      if (periodRemaining <= 0) {
        return nothingEarned(
          EarnOutcome.PeriodCap,
          rule,
          previousBalance,
          state,
          0,
          periodRemaining,
        );
      }
      amount = Math.min(amount, periodRemaining);
    }

    const headroom = currency.maxBalance - previousBalance;
    amount = Math.min(amount, headroom);

    if (amount <= 0) {
      return nothingEarned(
        EarnOutcome.NoAmount,
        rule,
        previousBalance,
        state,
        0,
        periodRemaining,
      );
    }

    const source =
      options.source ??
      emptyAccount(systemAccount(target.ref.scope, target.ref.currency, SystemAccount.Mint));
    const booking = this.book({
      kind: PostingKind.Earn,
      from: source,
      to: target,
      amount,
      options,
      metadata: { ...(options.metadata ?? {}), earnRule: ruleKey },
    });

    const nextState = cloneEarnState(state);
    if (rule.cooldownSeconds > 0) {
      nextState.lastEarnedAt[ruleKey] = options.now;
    }
    if (rule.periodCapAmount !== null) {
      recordInPeriod(nextState, ruleKey, amount, rule.periodSeconds, options.now);
    }

    return {
      outcome: EarnOutcome.Earned,
      posting: booking.posting,
      amount,
      grossAmount,
      previousBalance,
      newBalance: previousBalance + amount,
      cooldownRemainingMs: rule.cooldownSeconds * 1000,
      periodRemaining: this.earnPeriodRemaining(nextState, ruleKey, options.now),
      rule,
      state: nextState,
    };
  }

  /** Milliseconds until the member may earn from this rule again. */
  public earnCooldownRemainingMs(
    state: EarnState,
    ruleKey: string,
    now: number,
  ): number {
    const rule = this.earnRule(ruleKey);
    if (rule === null || rule.cooldownSeconds <= 0) {
      return 0;
    }
    const last = state.lastEarnedAt[ruleKey];
    if (last === undefined) {
      return 0;
    }
    const remaining = rule.cooldownSeconds * 1000 - (now - last);
    return remaining > 0 ? remaining : 0;
  }

  /** What is left of the rule's period ceiling, or `null` when uncapped. */
  public earnPeriodRemaining(
    state: EarnState,
    ruleKey: string,
    now: number,
  ): number | null {
    const rule = this.earnRule(ruleKey);
    if (rule === null || rule.periodCapAmount === null) {
      return null;
    }
    const start = state.periodStartAt[ruleKey];
    if (start === undefined || now - start >= rule.periodSeconds * 1000) {
      return rule.periodCapAmount;
    }
    const used = state.periodEarned[ruleKey] ?? 0;
    const remaining = rule.periodCapAmount - used;
    return remaining > 0 ? remaining : 0;
  }

  /** True when the member could earn from this rule right now. */
  public canEarn(state: EarnState, ruleKey: string, now: number): boolean {
    const rule = this.earnRule(ruleKey);
    if (rule === null || !rule.enabled) {
      return false;
    }
    if (this.earnCooldownRemainingMs(state, ruleKey, now) > 0) {
      return false;
    }
    const remaining = this.earnPeriodRemaining(state, ruleKey, now);
    return remaining === null || remaining > 0;
  }

  // -- reversal ------------------------------------------------------------

  /**
   * Undo an earlier posting by booking its exact inverse.
   *
   * Moderation needs a counterpart to every action, and an economy needs it to
   * leave a trace: the original booking stays, and a second one cancels it.
   * Deleting the first would leave an audit trail that lies about what happened.
   *
   * `balances` must carry the *current* balance of every account the original
   * posting touched — not the balance at the time, which may have moved on.
   */
  public reverse(
    original: Posting,
    balances: Readonly<Record<string, number>>,
    options: BookingOptions & { allowNegative?: boolean },
  ): BookingResult {
    assertTimestamp(options.now);
    if (original.kind === PostingKind.Reversal) {
      throw new ReversalError("A reversal cannot itself be reversed", {
        operationId: original.operationId,
      });
    }
    if (original.operationId === options.operationId) {
      throw new ReversalError("A reversal needs its own operation id", {
        operationId: options.operationId,
      });
    }

    const lines: PostingLine[] = original.lines.map((line) => {
      const key = accountKey(line.account);
      const current = balances[key];
      if (current === undefined) {
        throw new ReversalError(
          "The current balance of every account in the original posting is required",
          { account: key },
        );
      }
      const delta = -line.delta;
      const after = current + delta;
      if (
        delta < 0 &&
        after < 0 &&
        !isSystemAccount(line.account) &&
        !(options.allowNegative ?? this.config.allowNegative)
      ) {
        throw new InsufficientFundsError({
          account: key,
          balance: current,
          required: -delta,
          currency: line.account.currency,
        });
      }
      return {
        account: line.account,
        delta,
        balanceBefore: current,
        balanceAfter: after,
      };
    });

    const posting = createPosting({
      operationId: options.operationId,
      kind: PostingKind.Reversal,
      scope: original.scope,
      currency: original.currency,
      amount: original.amount,
      reason: options.reason,
      occurredAt: options.now,
      lines,
      reverses: original.operationId,
      metadata: { ...(options.metadata ?? {}), reversedKind: original.kind },
    });

    return { posting, balances: Object.freeze(resultingBalances(posting)) };
  }

  // -- decay ---------------------------------------------------------------

  /**
   * Shrink an idle balance, so hoarding does not freeze the economy.
   *
   * Charged per whole elapsed period, so running it nightly and running it once
   * a month cost the same. The flat amount is taken first, then the permille
   * share of what remains, once per period.
   *
   * Two timestamps, and the difference between them matters:
   *
   * - `lastActivityAt` is when the member last did something. The grace window
   *   is measured from here.
   * - `lastAppliedAt` is the `appliedUpTo` of the previous decay run, or `null`
   *   if decay has never run for this account.
   *
   * They are separate on purpose. Measuring the grace window from the last
   * *decay run* would push it forward every time decay ran, so a nightly job
   * would charge less than a monthly one — and an idle balance would never
   * shrink at all.
   */
  public applyDecay(
    target: Account,
    rule: DecayRule,
    options: BookingOptions & {
      lastActivityAt: number;
      lastAppliedAt?: number | null;
      sink?: Account;
    },
  ): DecayResult {
    assertTimestamp(options.now);
    assertTimestamp(options.lastActivityAt);
    assertDecayRule(rule);
    const previousBalance = target.balance;

    const graceEnd = options.lastActivityAt + rule.graceSeconds * 1000;
    const lastAppliedAt = options.lastAppliedAt ?? null;
    const decayStart =
      lastAppliedAt === null ? graceEnd : Math.max(lastAppliedAt, graceEnd);
    const periodMs = rule.periodSeconds * 1000;

    const unchanged = (): DecayResult => ({
      posting: null,
      amount: 0,
      periods: 0,
      previousBalance,
      newBalance: previousBalance,
      appliedUpTo: lastAppliedAt ?? decayStart,
    });

    if (options.now <= decayStart) {
      return unchanged();
    }

    const periods = Math.floor((options.now - decayStart) / periodMs);
    if (periods <= 0) {
      return unchanged();
    }

    let balance = previousBalance;
    for (let period = 0; period < periods; period += 1) {
      if (balance <= rule.floor) {
        break;
      }
      balance -= rule.amountPerPeriod;
      if (rule.permillePerPeriod > 0 && balance > 0) {
        balance -= Math.floor((balance * rule.permillePerPeriod) / 1000);
      }
      if (balance < rule.floor) {
        balance = rule.floor;
      }
    }

    const amount = previousBalance - balance;
    const appliedUpTo = decayStart + periods * periodMs;

    if (amount <= 0) {
      return {
        posting: null,
        amount: 0,
        periods,
        previousBalance,
        newBalance: previousBalance,
        appliedUpTo,
      };
    }

    const sink =
      options.sink ??
      emptyAccount(systemAccount(target.ref.scope, target.ref.currency, SystemAccount.Sink));
    const booking = this.book({
      kind: PostingKind.Decay,
      from: target,
      to: sink,
      amount,
      options,
      metadata: { ...(options.metadata ?? {}), periods: String(periods) },
    });

    return {
      posting: booking.posting,
      amount,
      periods,
      previousBalance,
      newBalance: balance,
      appliedUpTo,
    };
  }

  // -- internals -----------------------------------------------------------

  /** Build the two-line posting every primitive booking comes down to. */
  private book(input: {
    kind: PostingKind;
    from: Account;
    to: Account;
    amount: number;
    options: BookingOptions;
    metadata?: Record<string, string>;
  }): BookingResult {
    const { from, to, amount, options } = input;
    const lines: PostingLine[] = [
      {
        account: from.ref,
        delta: -amount,
        balanceBefore: from.balance,
        balanceAfter: from.balance - amount,
      },
      {
        account: to.ref,
        delta: amount,
        balanceBefore: to.balance,
        balanceAfter: to.balance + amount,
      },
    ];

    const posting = createPosting({
      operationId: options.operationId,
      kind: input.kind,
      scope: from.ref.scope,
      currency: from.ref.currency,
      amount,
      reason: options.reason,
      occurredAt: options.now,
      lines,
      metadata: input.metadata ?? options.metadata,
    });

    return { posting, balances: Object.freeze(resultingBalances(posting)) };
  }

  private assertFunds(source: Account, amount: number, allowNegative?: boolean): void {
    if (isSystemAccount(source.ref)) {
      // The mint and the sink are allowed to go arbitrarily negative — that is
      // what they are for.
      return;
    }
    const permitted = allowNegative ?? this.config.allowNegative;
    if (!permitted && source.balance < amount) {
      throw new InsufficientFundsError({
        account: accountKey(source.ref),
        balance: source.balance,
        required: amount,
        currency: source.ref.currency,
      });
    }
    if (permitted && source.balance - amount < MIN_BALANCE) {
      throw new InsufficientFundsError({
        account: accountKey(source.ref),
        balance: source.balance,
        required: amount,
        currency: source.ref.currency,
      });
    }
  }

  private assertHeadroom(target: Account, amount: number, currency: Currency): void {
    if (isSystemAccount(target.ref)) {
      return;
    }
    if (target.balance + amount > currency.maxBalance) {
      throw new BalanceOverflowError({
        account: accountKey(target.ref),
        balance: target.balance,
        amount,
        maxBalance: currency.maxBalance,
      });
    }
  }
}

/** Build a validated {@link EarnRule}. */
export function createEarnRule(input: EarnRuleInput): EarnRule {
  if (typeof input.key !== "string" || input.key.length === 0) {
    throw new ConfigurationError("An earn rule needs a non-empty key", { key: input.key });
  }
  if (typeof input.currency !== "string" || input.currency.length === 0) {
    throw new ConfigurationError("An earn rule needs a currency", {
      key: input.key,
    });
  }
  if (!Number.isSafeInteger(input.amount) || input.amount < 0) {
    throw new ConfigurationError("An earn rule amount must be a non-negative integer", {
      key: input.key,
      amount: input.amount,
    });
  }
  const cooldownSeconds = input.cooldownSeconds ?? 0;
  if (!Number.isSafeInteger(cooldownSeconds) || cooldownSeconds < 0) {
    throw new ConfigurationError("cooldownSeconds must be a non-negative integer", {
      cooldownSeconds,
    });
  }
  const periodCapAmount = input.periodCapAmount ?? null;
  if (
    periodCapAmount !== null &&
    (!Number.isSafeInteger(periodCapAmount) || periodCapAmount < 0)
  ) {
    throw new ConfigurationError(
      "periodCapAmount must be a non-negative integer or null",
      { periodCapAmount },
    );
  }
  const periodSeconds = input.periodSeconds ?? DEFAULT_PERIOD_SECONDS;
  if (!Number.isSafeInteger(periodSeconds) || periodSeconds <= 0) {
    throw new ConfigurationError("periodSeconds must be a positive integer", {
      periodSeconds,
    });
  }

  return Object.freeze({
    key: input.key,
    amount: input.amount,
    currency: input.currency,
    cooldownSeconds,
    periodCapAmount,
    periodSeconds,
    enabled: input.enabled ?? true,
  });
}

/** A fresh earning state for a member who has not earned anything yet. */
export function createEarnState(): EarnState {
  return { lastEarnedAt: {}, periodStartAt: {}, periodEarned: {} };
}

/** Deep copy. The engine never mutates the state it is handed. */
export function cloneEarnState(state: EarnState): EarnState {
  return {
    lastEarnedAt: { ...state.lastEarnedAt },
    periodStartAt: { ...state.periodStartAt },
    periodEarned: { ...state.periodEarned },
  };
}

/** Plain-object form, ready for `JSON.stringify`. */
export function serializeEarnState(state: EarnState): Record<string, unknown> {
  return cloneEarnState(state) as unknown as Record<string, unknown>;
}

/** Rebuild an earning state from stored data, filling in missing fields. */
export function deserializeEarnState(raw: unknown): EarnState {
  if (raw === null || typeof raw !== "object") {
    throw new ValidationError("An earn state must be an object", {});
  }
  const source = raw as Record<string, unknown>;
  return {
    lastEarnedAt: readNumberMap(source["lastEarnedAt"], "lastEarnedAt"),
    periodStartAt: readNumberMap(source["periodStartAt"], "periodStartAt"),
    periodEarned: readNumberMap(source["periodEarned"], "periodEarned"),
  };
}

function readNumberMap(value: unknown, field: string): Record<string, number> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object") {
    throw new ValidationError(`${field} must be an object`, { field });
  }
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new ValidationError(`${field} contains a non-numeric value`, { key });
    }
    result[key] = entry;
  }
  return result;
}

function nothingEarned(
  outcome: EarnOutcome,
  rule: EarnRule | null,
  balance: number,
  state: EarnState,
  cooldownRemainingMs: number,
  periodRemaining: number | null,
): EarnResult {
  return {
    outcome,
    posting: null,
    amount: 0,
    grossAmount: rule?.amount ?? 0,
    previousBalance: balance,
    newBalance: balance,
    cooldownRemainingMs,
    periodRemaining,
    rule,
    state: cloneEarnState(state),
  };
}

function recordInPeriod(
  state: EarnState,
  key: string,
  amount: number,
  periodSeconds: number,
  now: number,
): void {
  const start = state.periodStartAt[key];
  if (start === undefined || now - start >= periodSeconds * 1000) {
    state.periodStartAt[key] = now;
    state.periodEarned[key] = amount;
    return;
  }
  state.periodEarned[key] = (state.periodEarned[key] ?? 0) + amount;
}

function assertSameCurrency(a: AccountRef, b: AccountRef): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError({ expected: a.currency, received: b.currency });
  }
}

function assertTimestamp(now: number): void {
  if (!Number.isFinite(now)) {
    throw new ValidationError("now must be a finite epoch-millisecond timestamp", { now });
  }
}

function assertDecayRule(rule: DecayRule): void {
  assertWholeAmount(rule.amountPerPeriod);
  if (rule.amountPerPeriod < 0) {
    throw new ConfigurationError("amountPerPeriod must not be negative", {
      amountPerPeriod: rule.amountPerPeriod,
    });
  }
  if (
    !Number.isSafeInteger(rule.permillePerPeriod) ||
    rule.permillePerPeriod < 0 ||
    rule.permillePerPeriod > 1000
  ) {
    throw new ConfigurationError("permillePerPeriod must be an integer in 0..1000", {
      permillePerPeriod: rule.permillePerPeriod,
    });
  }
  if (!Number.isSafeInteger(rule.periodSeconds) || rule.periodSeconds <= 0) {
    throw new ConfigurationError("periodSeconds must be a positive integer", {
      periodSeconds: rule.periodSeconds,
    });
  }
  if (!Number.isSafeInteger(rule.floor)) {
    throw new ConfigurationError("floor must be an integer", { floor: rule.floor });
  }
  if (!Number.isSafeInteger(rule.graceSeconds) || rule.graceSeconds < 0) {
    throw new ConfigurationError("graceSeconds must be a non-negative integer", {
      graceSeconds: rule.graceSeconds,
    });
  }
  if (rule.amountPerPeriod === 0 && rule.permillePerPeriod === 0) {
    throw new ConfigurationError(
      "A decay rule that removes nothing is a configuration mistake",
      {},
    );
  }
}

function freezeConfig(input: EconomyConfigInput): EconomyConfig {
  const currencies = new Map<string, Currency>();
  for (const entry of input.currencies) {
    const currency =
      "maxBalance" in entry && "minorUnits" in entry
        ? (entry as Currency)
        : createCurrency(entry as { code: string });
    if (currencies.has(currency.code)) {
      throw new ConfigurationError("Duplicate currency code", { code: currency.code });
    }
    currencies.set(currency.code, currency);
  }
  if (currencies.size === 0) {
    throw new ConfigurationError("An economy needs at least one currency", {});
  }

  const earnRules = new Map<string, EarnRule>();
  for (const entry of input.earnRules ?? []) {
    const rule = isEarnRule(entry) ? entry : createEarnRule(entry);
    if (earnRules.has(rule.key)) {
      throw new ConfigurationError("Duplicate earn rule key", { key: rule.key });
    }
    if (!currencies.has(rule.currency)) {
      throw new ConfigurationError("An earn rule references an unknown currency", {
        key: rule.key,
        currency: rule.currency,
      });
    }
    earnRules.set(rule.key, rule);
  }

  const shopAccountOwner = input.shopAccountOwner ?? SystemAccount.Shop;
  if (!Object.values(SystemAccount).includes(shopAccountOwner as SystemAccount)) {
    // Silently redirecting the takings, or inventing an account no report knows
    // about, both hide the mistake until somebody asks where a scope's shop
    // revenue went.
    throw new ConfigurationError("shopAccountOwner must name a system account", {
      shopAccountOwner,
      allowed: Object.values(SystemAccount).sort(),
    });
  }

  return Object.freeze({
    currencies,
    earnRules,
    allowNegative: input.allowNegative ?? false,
    shopAccountOwner,
  });
}

function isEarnRule(value: EarnRule | EarnRuleInput): value is EarnRule {
  const candidate = value as EarnRule;
  return (
    typeof candidate.cooldownSeconds === "number" &&
    typeof candidate.periodSeconds === "number" &&
    typeof candidate.enabled === "boolean" &&
    candidate.periodCapAmount !== undefined
  );
}
