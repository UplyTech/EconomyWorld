/**
 * Reading the books: money supply, statements, and proving nothing leaked.
 *
 * Everything else in this package writes bookings. This reads them.
 *
 * # The one number that matters
 *
 * **Every posting sums to zero, so every set of postings sums to zero.** That is
 * the whole double-entry design in one sentence, and {@link trialBalance} is how
 * you check it actually held — across a day, a scope, or the entire history.
 *
 * If it does not, currency was created or destroyed outside a posting, and the
 * cause is almost always the obligation this package cannot enforce: a posting
 * written outside a transaction, or written twice. {@link trialBalance} will not
 * tell you which, but it will tell you *that*, on the day it happens rather than
 * three months later when somebody notices a leaderboard is wrong.
 *
 * # Money supply is a sum of negatives
 *
 * Currency enters an economy from `system:mint`, which goes negative by exactly
 * what it has issued. So the amount in circulation is `-mint`, less anything
 * retired into `system:sink`. Both are read off the same postings, and neither
 * is a counter somebody has to remember to increment.
 *
 * # Nothing here reads a database
 *
 * Every function takes the postings, or the balances, as an argument. A
 * reporting module that queried storage would be a reporting module that only
 * worked with one storage layer, and this package works with all of them by
 * working with none.
 */
import { type AccountRef, accountKey, isSystemAccount, parseAccountKey } from "./accounts.js";
import { SYSTEM_OWNER_PREFIX } from "./constants.js";
import { UnbalancedPostingError, ValidationError } from "./errors.js";
import type { Posting, PostingKind } from "./ledger.js";
import { Rounding, divideExactRounded } from "./rounding.js";

/** Whether a set of postings closes, and where it does not. */
export interface TrialBalance {
  /** How many postings were checked. */
  readonly postings: number;
  /** The sum of every line of every posting. Zero when the books close. */
  readonly total: number;
  /** Postings that did not balance on their own, by operation id. */
  readonly unbalanced: readonly string[];
  /**
   * Operation ids that appeared more than once. A duplicate is the second way
   * books go wrong, and the only one a sum alone cannot see: two copies of a
   * balanced posting still sum to zero.
   */
  readonly duplicates: readonly string[];
  /** True when nothing is wrong. */
  readonly balances: boolean;
}

/** How much currency exists in a scope, and where it sits. */
export interface MoneySupply {
  readonly scope: string;
  readonly currency: string;
  /** Everything ever issued from the mint. */
  readonly issued: number;
  /** Everything retired into the sink. */
  readonly retired: number;
  /** Issued less retired: what is out there. */
  readonly circulating: number;
  /** Of the circulating amount, what members hold. */
  readonly heldByMembers: number;
  /**
   * Of the circulating amount, what the system accounts hold — shop takings,
   * escrow, fees, deposits, and lending not yet repaid.
   */
  readonly heldBySystem: number;
}

/** One movement on one account, as a member would read it. */
export interface StatementLine {
  readonly operationId: string;
  readonly occurredAt: number;
  readonly kind: PostingKind;
  readonly reason: string;
  readonly delta: number;
  readonly balanceAfter: number;
}

/** Everything that happened to one account, in order. */
export interface Statement {
  readonly account: AccountRef;
  readonly lines: readonly StatementLine[];
  readonly openingBalance: number;
  readonly closingBalance: number;
  /** Everything that arrived, and everything that left, as positives. */
  readonly totalIn: number;
  readonly totalOut: number;
}

/** How a scope's currency is spread across its members. */
export interface Distribution {
  readonly holders: number;
  readonly total: number;
  /**
   * The balance in the middle: half hold more, half hold less. More useful than
   * the mean, which one wealthy member drags anywhere they like.
   */
  readonly median: number;
  readonly mean: number;
  /** 0 is everybody equal; 1000 is one member holding everything. */
  readonly giniPermille: number;
}

/**
 * Check that a set of postings closes.
 *
 * The check an operator should run nightly. It answers three questions at once:
 * does every posting balance on its own, do they balance together, and was
 * anything booked twice.
 *
 * Duplicates are checked because a sum cannot see them. Two copies of a
 * perfectly balanced posting still sum to zero — and they still gave somebody
 * twice the currency. Only the `operationId` catches that, which is why this
 * package insists it be `UNIQUE` in your database.
 */
export function trialBalance(postings: Iterable<Posting>): TrialBalance {
  let total = 0;
  let count = 0;
  const unbalanced: string[] = [];
  const seen = new Map<string, number>();

  for (const posting of postings) {
    count += 1;
    seen.set(posting.operationId, (seen.get(posting.operationId) ?? 0) + 1);
    const postingTotal = posting.lines.reduce((sum, line) => sum + line.delta, 0);
    total += postingTotal;
    if (postingTotal !== 0) unbalanced.push(posting.operationId);
  }

  const duplicates = [...seen.entries()]
    .filter(([, times]) => times > 1)
    .map(([key]) => key)
    .sort();

  return {
    postings: count,
    total,
    unbalanced,
    duplicates,
    balances: total === 0 && unbalanced.length === 0 && duplicates.length === 0,
  };
}

/**
 * Throw unless a set of postings closes.
 *
 * For a caller who wants a nightly job that fails loudly rather than one that
 * prints a number nobody reads.
 */
export function assertBooksClose(postings: Iterable<Posting>): void {
  const result = trialBalance(postings);
  if (result.total !== 0) {
    throw new UnbalancedPostingError("<trial balance>", result.total);
  }
  if (result.unbalanced.length > 0) {
    throw new UnbalancedPostingError(result.unbalanced[0] as string, 0);
  }
  if (result.duplicates.length > 0) {
    throw new ValidationError("An operation id was booked more than once", {
      operationId: result.duplicates[0],
      duplicates: result.duplicates.length,
    });
  }
}

/**
 * What every account's balance would be if these postings were all of them.
 *
 * Useful for a test, for a replay, and for reconciling a database against its
 * own history: if the balances you have stored differ from the balances the
 * postings imply, one of the two is wrong and you now know to look.
 */
export function accountBalances(postings: Iterable<Posting>): Record<string, number> {
  const balances: Record<string, number> = {};
  for (const posting of postings) {
    for (const line of posting.lines) {
      const key = accountKey(line.account);
      balances[key] = (balances[key] ?? 0) + line.delta;
    }
  }
  return balances;
}

/**
 * How much currency exists in a scope, and who is holding it.
 *
 * Read off the postings rather than off a counter, so it cannot drift. The
 * mint's balance is negative by everything it has ever issued; the sink's is
 * positive by everything retired.
 */
export function moneySupply(
  postings: Iterable<Posting>,
  scope: string,
  currency: string,
): MoneySupply {
  if (typeof scope !== "string" || scope.length === 0) {
    throw new ValidationError("scope must be a non-empty string", { scope });
  }

  const all = accountBalances(postings);
  const balances: Record<string, number> = {};
  for (const [key, balance] of Object.entries(all)) {
    const ref = parseAccountKey(key);
    if (ref.scope === scope && ref.currency === currency) balances[key] = balance;
  }

  const mint = balances[`${scope}/system:mint/${currency}`] ?? 0;
  const sink = balances[`${scope}/system:sink/${currency}`] ?? 0;

  let members = 0;
  let system = 0;
  for (const [key, balance] of Object.entries(balances)) {
    const ref = parseAccountKey(key);
    if (!isSystemAccount(ref)) {
      members += balance;
    } else if (ref.owner !== "system:mint" && ref.owner !== "system:sink") {
      system += balance;
    }
  }

  return {
    scope,
    currency,
    // `0 - mint` rather than `-mint`: negating a zero gives `-0`, which
    // serialises as "-0" and would differ from the Python edition on a value
    // that is not actually different.
    issued: 0 - mint,
    retired: sink,
    circulating: 0 - mint - sink,
    heldByMembers: members,
    heldBySystem: system,
  };
}

/**
 * Everything that happened to one account, in the order it happened.
 *
 * Postings are read in the order given, so hand them over sorted by
 * `occurredAt` — this function will not sort them, because two postings in the
 * same millisecond have an order only the caller knows.
 *
 * A posting that touches the account twice contributes one line with the net
 * change. That is a deliberate choice: a member seeing "-1000" and "+40" for one
 * purchase would ask what the +40 was, and the answer — an internal rounding
 * line — is not something they should have to understand.
 */
export function statementFor(
  postings: Iterable<Posting>,
  account: AccountRef,
  openingBalance = 0,
): Statement {
  const key = accountKey(account);
  const lines: StatementLine[] = [];
  let balance = openingBalance;
  let totalIn = 0;
  let totalOut = 0;

  for (const posting of postings) {
    const delta = posting.lines
      .filter((line) => accountKey(line.account) === key)
      .reduce((sum, line) => sum + line.delta, 0);
    if (delta === 0) continue;
    balance += delta;
    if (delta > 0) totalIn += delta;
    else totalOut += -delta;
    lines.push({
      operationId: posting.operationId,
      occurredAt: posting.occurredAt,
      kind: posting.kind,
      reason: posting.reason,
      delta,
      balanceAfter: balance,
    });
  }

  return {
    account,
    lines,
    openingBalance,
    closingBalance: balance,
    totalIn,
    totalOut,
  };
}

/**
 * How much moved, by what sort of event.
 *
 * The shape of an economy in one table: how much was earned, how much was spent
 * in shops, how much was lent.
 */
export function turnoverByKind(postings: Iterable<Posting>): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const posting of postings) {
    totals[posting.kind] = (totals[posting.kind] ?? 0) + posting.amount;
  }
  return totals;
}

/**
 * How evenly a scope's currency is spread.
 *
 * System accounts are left out: the mint holding minus ten million says nothing
 * about whether members are equal.
 *
 * The Gini coefficient is in permille, computed on integers. Zero is perfect
 * equality; a thousand is one member holding everything. It is the number that
 * tells an operator whether their earning rules have quietly produced an economy
 * where nothing is affordable for anybody but the top three members.
 */
export function wealthDistribution(
  balances: Readonly<Record<string, number>>,
): Distribution {
  const memberBalances = Object.entries(balances)
    .filter(([key]) => !parseAccountKey(key).owner.startsWith(SYSTEM_OWNER_PREFIX))
    .map(([, balance]) => balance)
    .sort((a, b) => a - b);

  if (memberBalances.length === 0) {
    return { holders: 0, total: 0, median: 0, mean: 0, giniPermille: 0 };
  }

  const count = memberBalances.length;
  const total = memberBalances.reduce((sum, value) => sum + value, 0);
  const middle = Math.floor(count / 2);
  const median =
    count % 2 === 1
      ? (memberBalances[middle] as number)
      : Math.floor(
          ((memberBalances[middle - 1] as number) + (memberBalances[middle] as number)) / 2,
        );
  const mean = Math.floor(total / count);

  return {
    holders: count,
    total,
    median,
    mean,
    giniPermille: giniPermille(memberBalances),
  };
}

/**
 * Inequality on a 0..1000 scale, as an integer.
 *
 * Computed from the sorted balances with the standard alternative formula:
 *
 * ```
 * G = (2 * sum(i * x_i) - (n + 1) * sum(x)) / (n * sum(x))
 * ```
 *
 * with `i` counting from one. All integer, so both editions agree to the unit —
 * a float here would be a number two communities compare and find different.
 *
 * Zero when everybody has the same, and when nobody has anything: an economy
 * where all balances are zero is perfectly equal, which is technically true and
 * worth returning rather than dividing by it.
 */
export function giniPermille(balances: readonly number[]): number {
  const ordered = [...balances].sort((a, b) => a - b);
  const count = ordered.length;
  if (count === 0) return 0;
  const total = ordered.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;

  // BigInt throughout, because every term here is a sum of products: with a
  // thousand holders near the balance ceiling, `weighted` passes 2^53 long
  // before any single balance does, and an inequality figure that silently
  // rounded would be a number two communities compare and find different.
  let weighted = 0n;
  ordered.forEach((value, index) => {
    weighted += BigInt(index + 1) * BigInt(value);
  });
  const numerator = 2n * weighted - BigInt(count + 1) * BigInt(total);
  const denominator = BigInt(count) * BigInt(total);
  const permille = Number(divideExactRounded(numerator * 1000n, denominator, Rounding.HalfUp));
  return Math.max(0, Math.min(1000, permille));
}

/**
 * The members holding most, largest first.
 *
 * Ties are broken by account key so the order is stable: a leaderboard whose
 * joint-third changes place every time it is drawn looks broken even when the
 * numbers are right.
 */
export function topHolders(
  balances: Readonly<Record<string, number>>,
  limit = 10,
): [string, number][] {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new ValidationError("limit must be a non-negative integer", { limit });
  }
  return Object.entries(balances)
    .filter(([key]) => !parseAccountKey(key).owner.startsWith(SYSTEM_OWNER_PREFIX))
    .sort((left, right) => {
      if (left[1] !== right[1]) return right[1] - left[1];
      return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
    })
    .slice(0, limit);
}
