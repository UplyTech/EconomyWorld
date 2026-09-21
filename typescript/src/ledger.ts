import { type AccountRef, accountKey, parseAccountKey } from "./accounts.js";
import { UnbalancedPostingError, ValidationError } from "./errors.js";

/**
 * # The one rule this package cannot enforce for you
 *
 * A posting is a complete, indivisible booking. Its lines always sum to zero:
 * whatever leaves one account arrives in another.
 *
 * **EconomyWorld does not store anything, so it cannot make the write atomic.
 * You must.**
 *
 * ```
 *   BEGIN;
 *     UPDATE accounts SET balance = ... WHERE ...;   -- every line
 *     UPDATE accounts SET balance = ... WHERE ...;
 *     INSERT INTO postings (operation_id, ...) ...;  -- the posting itself
 *   COMMIT;
 * ```
 *
 * Writing the lines one at a time, outside a transaction, is how currency
 * appears from nowhere or vanishes. In a community both are noticed, and both
 * destroy trust in the whole system. This is the limit of being
 * storage-agnostic, and it is stated plainly rather than glossed over.
 *
 * The second half of the same obligation: `operationId` must be a UNIQUE
 * column. A retried request that books twice is the other way balances go
 * wrong, and only your database can prevent it.
 */

/** What kind of event produced a posting. */
export enum PostingKind {
  /** New currency issued into the economy. */
  Credit = "CREDIT",
  /** Currency taken out of the economy. */
  Debit = "DEBIT",
  /** Currency moved between two member accounts. */
  Transfer = "TRANSFER",
  /** Currency issued by an earning rule. */
  Earn = "EARN",
  /** Payment for a shop offer. */
  Purchase = "PURCHASE",
  /** Settlement of a trade between two members. */
  Trade = "TRADE",
  /** The exact inverse of an earlier posting. */
  Reversal = "REVERSAL",
  /** Currency removed by decay or demurrage. */
  Decay = "DECAY",
  /** Currency moved from a member's balance onto deposit. */
  Deposit = "DEPOSIT",
  /** Currency taken back off deposit. */
  Withdrawal = "WITHDRAWAL",
  /** Interest credited on a deposit, or charged on a debt. */
  Interest = "INTEREST",
  /** A loan paid out to the borrower. */
  LoanDisbursement = "LOAN_DISBURSEMENT",
  /** An instalment, or a repayment in full. */
  LoanRepayment = "LOAN_REPAYMENT",
  /** A debt given up on, removed from the books. */
  WriteOff = "WRITE_OFF",
  /** A fee or a tax. */
  Fee = "FEE",
  /** A coupon or dividend paid on an instrument. */
  Distribution = "DISTRIBUTION",
  /** One currency swapped for another, or an instrument bought or sold. */
  Exchange = "EXCHANGE",
  /** A market order or an auction settling. */
  Settlement = "SETTLEMENT",
  /** A scheduled charge: a subscription, a standing order, a payroll run. */
  Recurring = "RECURRING",
  /** Currency moved into escrow while a deal is open. */
  Escrow = "ESCROW",
  /**
   * Escrowed currency given back because the deal fell through. Distinct from
   * `Settlement` on purpose: "you got your money back" and "the seller was
   * paid" are the two outcomes an operator is asked to tell apart later.
   */
  EscrowRelease = "ESCROW_RELEASE",
}

/** One account's share of a posting. */
export interface PostingLine {
  readonly account: AccountRef;
  /** Signed change. Negative leaves the account, positive arrives. */
  readonly delta: number;
  readonly balanceBefore: number;
  readonly balanceAfter: number;
}

/** A complete, indivisible booking. */
export interface Posting {
  /**
   * The caller's idempotency key.
   *
   * Must be unique across all postings. Derive it from whatever made the
   * request — a message id, a command interaction id, a job id — so that a
   * retry produces the same key and your unique constraint catches it.
   */
  readonly operationId: string;
  readonly kind: PostingKind;
  readonly scope: string;
  readonly currency: string;
  /** The absolute amount that moved. Always positive. */
  readonly amount: number;
  /** Why this happened, in the caller's own words. Shown in audit trails. */
  readonly reason: string;
  /** Epoch milliseconds, handed in by the caller. */
  readonly occurredAt: number;
  readonly lines: readonly PostingLine[];
  /** The `operationId` this posting reverses, or `null`. */
  readonly reverses: string | null;
  /** Free-form context. Strings only, so it survives any storage layer. */
  readonly metadata: Readonly<Record<string, string>>;
}

/** Input for {@link createPosting}. */
export interface PostingInput {
  readonly operationId: string;
  readonly kind: PostingKind;
  readonly scope: string;
  readonly currency: string;
  readonly amount: number;
  readonly reason: string;
  readonly occurredAt: number;
  readonly lines: readonly PostingLine[];
  readonly reverses?: string | null;
  readonly metadata?: Record<string, string>;
}

/**
 * Build a posting and check it before it leaves the library.
 *
 * The balance check is not a formality: it is the single assertion that makes
 * the whole double-entry design worth having. A posting that does not balance
 * never reaches the caller.
 */
export function createPosting(input: PostingInput): Posting {
  if (typeof input.operationId !== "string" || input.operationId.length === 0) {
    throw new ValidationError("A posting needs a non-empty operationId", {
      operationId: input.operationId,
    });
  }
  if (typeof input.reason !== "string" || input.reason.length === 0) {
    throw new ValidationError("A posting needs a non-empty reason", {
      operationId: input.operationId,
    });
  }
  if (!Number.isFinite(input.occurredAt)) {
    throw new ValidationError("occurredAt must be an epoch-millisecond timestamp", {
      occurredAt: input.occurredAt,
    });
  }
  if (input.lines.length < 2) {
    throw new ValidationError(
      "A posting needs at least two lines — every booking has a source and a destination",
      { operationId: input.operationId, lines: input.lines.length },
    );
  }

  let sum = 0;
  for (const line of input.lines) {
    if (!Number.isSafeInteger(line.delta)) {
      throw new ValidationError("A posting line delta must be a safe integer", {
        delta: line.delta,
      });
    }
    if (line.balanceBefore + line.delta !== line.balanceAfter) {
      throw new ValidationError(
        "A posting line does not add up: balanceBefore + delta must equal balanceAfter",
        {
          account: accountKey(line.account),
          balanceBefore: line.balanceBefore,
          delta: line.delta,
          balanceAfter: line.balanceAfter,
        },
      );
    }
    if (line.account.currency !== input.currency) {
      throw new ValidationError("Every line of a posting must use its currency", {
        expected: input.currency,
        received: line.account.currency,
      });
    }
    if (line.account.scope !== input.scope) {
      throw new ValidationError("Every line of a posting must be in its scope", {
        expected: input.scope,
        received: line.account.scope,
      });
    }
    sum += line.delta;
  }

  if (sum !== 0) {
    throw new UnbalancedPostingError(input.operationId, sum);
  }

  return Object.freeze({
    operationId: input.operationId,
    kind: input.kind,
    scope: input.scope,
    currency: input.currency,
    amount: input.amount,
    reason: input.reason,
    occurredAt: input.occurredAt,
    lines: Object.freeze([...input.lines]),
    reverses: input.reverses ?? null,
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
}

/** True when the posting's lines sum to zero. */
export function isBalanced(posting: Posting): boolean {
  return posting.lines.reduce((sum, line) => sum + line.delta, 0) === 0;
}

/**
 * Throw unless the posting balances.
 *
 * Worth calling in your own tests, and in an assertion around your transaction,
 * if you build postings by hand.
 */
export function assertBalanced(posting: Posting): void {
  const sum = posting.lines.reduce((total, line) => total + line.delta, 0);
  if (sum !== 0) {
    throw new UnbalancedPostingError(posting.operationId, sum);
  }
}

/** What this posting did to one account. `0` when it did not touch it. */
export function netChange(posting: Posting, ref: AccountRef): number {
  const key = accountKey(ref);
  return posting.lines
    .filter((line) => accountKey(line.account) === key)
    .reduce((sum, line) => sum + line.delta, 0);
}

/** The resulting balance of every account the posting touched. */
export function resultingBalances(posting: Posting): Record<string, number> {
  const balances: Record<string, number> = {};
  for (const line of posting.lines) {
    balances[accountKey(line.account)] = line.balanceAfter;
  }
  return balances;
}

/** Plain-object form, ready for `JSON.stringify` or a JSONB column. */
export function serializePosting(posting: Posting): Record<string, unknown> {
  return {
    operationId: posting.operationId,
    kind: posting.kind,
    scope: posting.scope,
    currency: posting.currency,
    amount: posting.amount,
    reason: posting.reason,
    occurredAt: posting.occurredAt,
    reverses: posting.reverses,
    metadata: { ...posting.metadata },
    lines: posting.lines.map((line) => ({
      account: accountKey(line.account),
      delta: line.delta,
      balanceBefore: line.balanceBefore,
      balanceAfter: line.balanceAfter,
    })),
  };
}

/** Rebuild a posting from stored data, re-running every check. */
export function deserializePosting(raw: unknown): Posting {
  if (raw === null || typeof raw !== "object") {
    throw new ValidationError("A stored posting must be an object", {});
  }
  const source = raw as Record<string, unknown>;
  const rawLines = source["lines"];
  if (!Array.isArray(rawLines)) {
    throw new ValidationError("A stored posting must carry its lines", {});
  }

  const lines: PostingLine[] = rawLines.map((entry) => {
    const line = entry as Record<string, unknown>;
    return {
      account: parseAccountKey(String(line["account"])),
      delta: Number(line["delta"]),
      balanceBefore: Number(line["balanceBefore"]),
      balanceAfter: Number(line["balanceAfter"]),
    };
  });

  return createPosting({
    operationId: String(source["operationId"]),
    kind: source["kind"] as PostingKind,
    scope: String(source["scope"]),
    currency: String(source["currency"]),
    amount: Number(source["amount"]),
    reason: String(source["reason"]),
    occurredAt: Number(source["occurredAt"]),
    lines,
    reverses: (source["reverses"] as string | null) ?? null,
    metadata: (source["metadata"] as Record<string, string>) ?? {},
  });
}

/**
 * An idempotency guard you can use in tests and examples.
 *
 * **This is not the real thing.** In production the guarantee has to come from
 * a `UNIQUE` constraint on the `operation_id` column, inside the same
 * transaction as the balance updates. An in-memory set does not survive a
 * restart, and does not help when two processes handle the retry.
 */
export class InMemoryOperationLog {
  private readonly seen = new Set<string>();

  /** True when this operation id has not been booked before. */
  public isNew(operationId: string): boolean {
    return !this.seen.has(operationId);
  }

  /** Record an operation id. Returns false when it was already there. */
  public record(operationId: string): boolean {
    if (this.seen.has(operationId)) {
      return false;
    }
    this.seen.add(operationId);
    return true;
  }

  public get size(): number {
    return this.seen.size;
  }

  public clear(): void {
    this.seen.clear();
  }
}
