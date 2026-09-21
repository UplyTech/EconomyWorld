/**
 * Error hierarchy for @uplytech/economyworld.
 *
 * Every error extends {@link EconomyError} so callers can catch a single base
 * class and still tell the causes apart via `code`.
 *
 * The split between an error and an outcome follows the same rule as RankMode:
 * things that happen in normal operation come back as results — an earning
 * cooldown that has not expired, a daily cap that is used up. Errors are for
 * situations where continuing would produce a wrong balance: insufficient
 * funds, a currency mismatch, a duplicate booking.
 *
 * {@link InsufficientFundsError} is an error rather than an outcome on purpose.
 * A caller who forgets to check it must not accidentally end up with a member
 * in debt; the exception forces the decision to be made.
 */

/** Base class for every error thrown by this package. */
export class EconomyError extends Error {
  public readonly code: string;
  public readonly details: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    options: { code: string; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code;
    this.details = Object.freeze({ ...(options.details ?? {}) });
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/** A currency, rule, item, offer or engine option was configured impossibly. */
export class ConfigurationError extends EconomyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "CONFIGURATION_ERROR", details });
  }
}

/** A call-site argument was invalid (fractional amount, empty id, bad timestamp). */
export class ValidationError extends EconomyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "VALIDATION_ERROR", details });
  }
}

/** An amount was zero, negative or not a whole number of minor units. */
export class InvalidAmountError extends EconomyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "INVALID_AMOUNT", details });
  }
}

/** The account does not hold enough to cover the debit. */
export class InsufficientFundsError extends EconomyError {
  public readonly balance: number;
  public readonly required: number;
  public readonly shortfall: number;

  constructor(options: {
    account: string;
    balance: number;
    required: number;
    currency: string;
  }) {
    super(
      `Account ${options.account} holds ${options.balance} but ${options.required} is required`,
      {
        code: "INSUFFICIENT_FUNDS",
        details: { ...options, shortfall: options.required - options.balance },
      },
    );
    this.balance = options.balance;
    this.required = options.required;
    this.shortfall = options.required - options.balance;
  }
}

/** The credit would push the balance past the currency's ceiling. */
export class BalanceOverflowError extends EconomyError {
  constructor(options: {
    account: string;
    balance: number;
    amount: number;
    maxBalance: number;
  }) {
    super(
      `Crediting ${options.amount} to ${options.account} would exceed the maximum balance of ${options.maxBalance}`,
      { code: "BALANCE_OVERFLOW", details: options },
    );
  }
}

/** Two accounts in one booking hold different currencies. */
export class CurrencyMismatchError extends EconomyError {
  constructor(options: { expected: string; received: string; account?: string }) {
    super(
      `Expected currency ${options.expected} but got ${options.received}`,
      { code: "CURRENCY_MISMATCH", details: options },
    );
  }
}

/** The currency, item or offer is not known to this engine. */
export class UnknownReferenceError extends EconomyError {
  constructor(kind: string, id: string) {
    super(`Unknown ${kind}: ${id}`, {
      code: "UNKNOWN_REFERENCE",
      details: { kind, id },
    });
  }
}

/**
 * The operation id has already been booked.
 *
 * The engine cannot detect this on its own — it stores nothing. It is raised by
 * the operation log helpers, and by your database's unique constraint, which is
 * where the real guarantee lives.
 */
export class DuplicateOperationError extends EconomyError {
  constructor(operationId: string) {
    super(`Operation ${operationId} has already been booked`, {
      code: "DUPLICATE_OPERATION",
      details: { operationId },
    });
  }
}

/** A posting's lines do not sum to zero, or are otherwise malformed. */
export class UnbalancedPostingError extends EconomyError {
  constructor(operationId: string, sum: number) {
    super(
      `Posting ${operationId} does not balance: its lines sum to ${sum}, not 0`,
      { code: "UNBALANCED_POSTING", details: { operationId, sum } },
    );
  }
}

/** The item cannot do what was asked of it (not stackable, not tradable). */
export class ItemError extends EconomyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "ITEM_ERROR", details });
  }
}

/** The inventory does not hold enough of the item. */
export class InsufficientQuantityError extends EconomyError {
  constructor(options: { itemId: string; held: number; required: number }) {
    super(
      `Inventory holds ${options.held} of ${options.itemId} but ${options.required} is required`,
      { code: "INSUFFICIENT_QUANTITY", details: options },
    );
  }
}

/** The offer cannot be bought right now (no stock, disabled, limit reached). */
export class OfferError extends EconomyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "OFFER_ERROR", details });
  }
}

/** The trade is not in a state that allows this transition. */
export class TradeStateError extends EconomyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "TRADE_STATE_ERROR", details });
  }
}

/** A reversal was asked for that cannot be carried out. */
export class ReversalError extends EconomyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "REVERSAL_ERROR", details });
  }
}

/** An interest rate, term or schedule cannot produce a sane result. */
export class RateError extends EconomyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "RATE_ERROR", details });
  }
}

/** A hold cannot be placed, released or captured as asked. */
export class HoldError extends EconomyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "HOLD_ERROR", details });
  }
}

/** A deposit account will not take this deposit or withdrawal. */
export class DepositError extends EconomyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "DEPOSIT_ERROR", details });
  }
}

/** The loan is not in a state that allows this transition. */
export class LoanStateError extends EconomyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "LOAN_STATE_ERROR", details });
  }
}

/** The borrowing asked for is past what the terms allow. */
export class CreditLimitError extends EconomyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "CREDIT_LIMIT_ERROR", details });
  }
}

/** The instrument, position or valuation cannot be handled as asked. */
export class InstrumentError extends EconomyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "INSTRUMENT_ERROR", details });
  }
}

/** The order cannot be placed, matched or cancelled as asked. */
export class OrderError extends EconomyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "ORDER_ERROR", details });
  }
}

/** The auction is not in a state that allows this transition. */
export class AuctionStateError extends EconomyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "AUCTION_STATE_ERROR", details });
  }
}

/** A recurring schedule is impossible or has run out of room. */
export class ScheduleError extends EconomyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: "SCHEDULE_ERROR", details });
  }
}
