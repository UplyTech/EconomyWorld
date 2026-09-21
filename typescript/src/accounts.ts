import { SYSTEM_OWNER_PREFIX } from "./constants.js";
import { ValidationError } from "./errors.js";

/**
 * Which account a balance belongs to.
 *
 * A reference, not the balance itself: the caller holds balances in its own
 * database, and hands them in as {@link Account} objects when it wants
 * something booked.
 */
export interface AccountRef {
  /** The world the account lives in: one server, one forum, one game. */
  readonly scope: string;
  /** Who owns it — a member id, or a `system:` owner. */
  readonly owner: string;
  /** Which currency it holds. */
  readonly currency: string;
}

/** An account reference together with the balance the caller loaded. */
export interface Account {
  readonly ref: AccountRef;
  readonly balance: number;
}

/**
 * The system accounts every scope implicitly has.
 *
 * Every booking in EconomyWorld is double-entry: what leaves one account
 * arrives in another, and the lines of a posting always sum to zero. That is
 * what makes "no money appeared from nowhere" a property you can *check*
 * rather than hope for.
 *
 * But new money does have to enter the economy somewhere, and spent money has
 * to leave it. These accounts are that somewhere. They are allowed to go
 * arbitrarily negative — the mint's balance is simply how much currency it has
 * issued, with a minus sign.
 *
 * ## Whether you store them is your choice
 *
 * When you do not hand a system account to `credit`, `debit`, `earn` or
 * `applyDecay`, the engine fills one in with a balance of zero. The member's
 * line is exact either way, and the posting still balances — but the system
 * line's `balanceBefore` and `balanceAfter` are then meaningless, because the
 * engine has no idea what the mint held.
 *
 * So pick one and stay with it:
 *
 * - **Do not store system accounts.** Simplest. Ignore the system lines'
 *   before/after values; the member lines are what you write.
 * - **Store them like any other account.** Then you can ask what the money
 *   supply is and check that the books close — but you must load and pass them
 *   on every call, or you will write a wrong system balance.
 */
export enum SystemAccount {
  /** Where new currency is issued from. Goes negative by design. */
  Mint = "system:mint",
  /** Where currency that is taken out of circulation goes. */
  Sink = "system:sink",
  /** Where shop payments land. */
  Shop = "system:shop",
  /** Where funds sit while a trade is open. */
  Escrow = "system:escrow",
  /**
   * Where deposits sit while they are on deposit. A member's savings balance
   * leaves their current account and arrives here, which is what makes "how much
   * is on deposit in this scope" a number you can read off the books rather than
   * sum across members.
   */
  Bank = "system:bank",
  /**
   * Where lending is paid out from and repayments arrive. Its balance is the
   * scope's outstanding credit, with a minus sign.
   */
  Credit = "system:credit",
  /**
   * Where fees and taxes collect. Kept apart from the sink because a fee is
   * revenue the operator may want to spend again, and currency in the sink is
   * gone.
   */
  Fee = "system:fee",
  /**
   * Where an order's funds and an auction's bids sit until the trade settles.
   * Separate from escrow so a stuck market cannot be confused with a stuck trade
   * when the books are being reconciled.
   */
  Market = "system:market",
}

/** Build a reference to a member's account. */
export function memberAccount(
  scope: string,
  memberId: string,
  currency: string,
): AccountRef {
  assertIdentifier(scope, "scope");
  assertIdentifier(memberId, "memberId");
  assertIdentifier(currency, "currency");
  if (memberId.startsWith(SYSTEM_OWNER_PREFIX)) {
    throw new ValidationError(
      `A member id must not start with "${SYSTEM_OWNER_PREFIX}"`,
      { memberId },
    );
  }
  return Object.freeze({ scope, owner: memberId, currency });
}

/** Build a reference to one of the scope's system accounts. */
export function systemAccount(
  scope: string,
  currency: string,
  kind: SystemAccount = SystemAccount.Mint,
): AccountRef {
  assertIdentifier(scope, "scope");
  assertIdentifier(currency, "currency");
  return Object.freeze({ scope, owner: kind, currency });
}

/** True when the reference points at a system account. */
export function isSystemAccount(ref: AccountRef): boolean {
  return ref.owner.startsWith(SYSTEM_OWNER_PREFIX);
}

/**
 * A stable string form of a reference.
 *
 * Useful as a map key and as a primary key in the caller's database. The
 * separator is `/`, and the parts are validated against it, so the key can be
 * parsed back unambiguously.
 */
export function accountKey(ref: AccountRef): string {
  return `${ref.scope}/${ref.owner}/${ref.currency}`;
}

/** Parse a key produced by {@link accountKey}. */
export function parseAccountKey(key: string): AccountRef {
  const parts = key.split("/");
  if (parts.length !== 3) {
    throw new ValidationError("An account key has exactly three parts", { key });
  }
  const [scope, owner, currency] = parts as [string, string, string];
  assertIdentifier(scope, "scope");
  assertIdentifier(owner, "owner");
  assertIdentifier(currency, "currency");
  return Object.freeze({ scope, owner, currency });
}

/** True when two references point at the same account. */
export function sameAccount(a: AccountRef, b: AccountRef): boolean {
  return a.scope === b.scope && a.owner === b.owner && a.currency === b.currency;
}

/** Pair a reference with a balance the caller has loaded. */
export function account(ref: AccountRef, balance: number): Account {
  if (!Number.isSafeInteger(balance)) {
    throw new ValidationError("A balance must be a safe integer", { balance });
  }
  return Object.freeze({ ref, balance });
}

/**
 * An account the caller has not stored yet.
 *
 * A member who has never held any currency has no row, and that is not an
 * error: their balance is zero. This is the shorthand for that case.
 */
export function emptyAccount(ref: AccountRef): Account {
  return Object.freeze({ ref, balance: 0 });
}

function assertIdentifier(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${name} must be a non-empty string`, { [name]: value });
  }
  if (value.includes("/")) {
    throw new ValidationError(`${name} must not contain "/"`, { [name]: value });
  }
}
