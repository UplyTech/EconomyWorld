import { type Account, accountKey, sameAccount } from "./accounts.js";
import { DEFAULT_TRADE_TTL_SECONDS } from "./constants.js";
import type { EconomyEngine } from "./engine.js";
import {
  ConfigurationError,
  InsufficientFundsError,
  ItemError,
  TradeStateError,
  ValidationError,
} from "./errors.js";
import {
  addItem,
  type Inventory,
  type InventoryChange,
  type InventorySlot,
  type Item,
  removeItem,
} from "./inventory.js";
import { createPosting, type PostingLine, PostingKind, resultingBalances } from "./ledger.js";
import type { BookingOptions, BookingResult } from "./types.js";

/**
 * # Why a trade is a state machine
 *
 * A trade is the reason an inventory becomes interesting, and it is also the
 * easiest place in an economy to lose something. Two members each put up a
 * side; both have to agree; either may walk away; and if nobody finishes it,
 * it has to go away by itself.
 *
 * Modelling that as "just swap the things" leaves no way to cancel, no way to
 * expire, and no way to answer "what happened to my sword?". So a trade here is
 * an explicit state with explicit transitions, and every invalid transition is
 * an error rather than a silent no-op:
 *
 * ```
 *                  ┌──────────────┐
 *                  │   PROPOSED   │
 *                  └──────┬───────┘
 *          accept (both)  │  cancel        expire
 *                  ┌──────┴───────┐   ┌──────────────┐
 *                  │   ACCEPTED   │   │   EXPIRED    │
 *                  └──────┬───────┘   └──────────────┘
 *                  settle │        ┌──────────────┐
 *                  ┌──────┴───────┐│  CANCELLED   │
 *                  │  COMPLETED   │└──────────────┘
 *                  └──────────────┘
 * ```
 *
 * `CANCELLED`, `EXPIRED` and `COMPLETED` are final. Nothing moves until
 * `settleTrade`, and that produces one posting and both inventory changes
 * together — so an abandoned trade leaves no damage behind, which is exactly
 * what the concept asks for.
 */
export enum TradeState {
  /** Offered, waiting for the other side. */
  Proposed = "PROPOSED",
  /** Both sides agreed. Ready to settle. */
  Accepted = "ACCEPTED",
  /** Someone walked away. Final. */
  Cancelled = "CANCELLED",
  /** Nobody finished it in time. Final. */
  Expired = "EXPIRED",
  /** Settled. Final. */
  Completed = "COMPLETED",
}

/** What one party puts up. */
export interface TradeSide {
  readonly owner: string;
  /** Currency offered, in minor units. May be zero. */
  readonly amount: number;
  /** Items offered. May be empty. */
  readonly items: readonly InventorySlot[];
}

/** A trade between two members. */
export interface Trade {
  readonly tradeId: string;
  readonly scope: string;
  readonly currency: string;
  readonly left: TradeSide;
  readonly right: TradeSide;
  readonly state: TradeState;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Owners who have accepted, in the order they did. */
  readonly acceptedBy: readonly string[];
  /** Set when the trade ended, whichever way. */
  readonly settledAt: number | null;
}

/** Input for {@link proposeTrade}. */
export interface TradeProposal {
  readonly tradeId: string;
  readonly scope: string;
  readonly currency: string;
  readonly left: TradeSide;
  readonly right: TradeSide;
  readonly now: number;
  readonly ttlSeconds?: number;
}

/** Open a trade. Nothing moves yet. */
export function proposeTrade(proposal: TradeProposal): Trade {
  if (typeof proposal.tradeId !== "string" || proposal.tradeId.length === 0) {
    throw new ConfigurationError("A trade needs a non-empty tradeId", {});
  }
  assertSide(proposal.left, "left");
  assertSide(proposal.right, "right");
  if (proposal.left.owner === proposal.right.owner) {
    throw new ValidationError("A member cannot trade with themselves", {
      owner: proposal.left.owner,
    });
  }
  if (isEmptySide(proposal.left) && isEmptySide(proposal.right)) {
    throw new ValidationError("A trade where neither side offers anything is not a trade", {
      tradeId: proposal.tradeId,
    });
  }
  if (!Number.isFinite(proposal.now)) {
    throw new ValidationError("now must be an epoch-millisecond timestamp", {
      now: proposal.now,
    });
  }
  const ttlSeconds = proposal.ttlSeconds ?? DEFAULT_TRADE_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new ConfigurationError("ttlSeconds must be a positive integer", { ttlSeconds });
  }

  return Object.freeze({
    tradeId: proposal.tradeId,
    scope: proposal.scope,
    currency: proposal.currency,
    left: freezeSide(proposal.left),
    right: freezeSide(proposal.right),
    state: TradeState.Proposed,
    createdAt: proposal.now,
    expiresAt: proposal.now + ttlSeconds * 1000,
    acceptedBy: Object.freeze([]),
    settledAt: null,
  });
}

/**
 * Record one party's agreement.
 *
 * The trade moves to `ACCEPTED` only once both have. Accepting twice is
 * harmless and changes nothing.
 */
export function acceptTrade(trade: Trade, owner: string, now: number): Trade {
  assertOpen(trade, now, "accept");
  assertParty(trade, owner);

  if (trade.acceptedBy.includes(owner)) {
    return trade;
  }
  const acceptedBy = Object.freeze([...trade.acceptedBy, owner]);
  const bothAccepted =
    acceptedBy.includes(trade.left.owner) && acceptedBy.includes(trade.right.owner);

  return Object.freeze({
    ...trade,
    acceptedBy,
    state: bothAccepted ? TradeState.Accepted : TradeState.Proposed,
  });
}

/**
 * Withdraw an agreement without ending the trade.
 *
 * Useful when one side edits their offer: the other side's acceptance should
 * not carry over to a different deal than the one they agreed to.
 */
export function revokeAcceptance(trade: Trade, owner: string, now: number): Trade {
  assertOpen(trade, now, "revoke acceptance for");
  assertParty(trade, owner);
  return Object.freeze({
    ...trade,
    acceptedBy: Object.freeze(trade.acceptedBy.filter((party) => party !== owner)),
    state: TradeState.Proposed,
  });
}

/** Either party walks away. Final. */
export function cancelTrade(trade: Trade, owner: string, now: number): Trade {
  if (isFinal(trade)) {
    throw new TradeStateError(`A ${trade.state.toLowerCase()} trade cannot be cancelled`, {
      tradeId: trade.tradeId,
      state: trade.state,
    });
  }
  assertParty(trade, owner);
  return Object.freeze({
    ...trade,
    state: TradeState.Cancelled,
    settledAt: now,
    acceptedBy: Object.freeze([]),
  });
}

/**
 * Close a trade nobody finished.
 *
 * Call it from whatever sweeps your open trades. An expired trade has moved
 * nothing, so there is nothing to undo.
 */
export function expireTrade(trade: Trade, now: number): Trade {
  if (isFinal(trade)) {
    return trade;
  }
  if (now < trade.expiresAt) {
    throw new TradeStateError("This trade has not expired yet", {
      tradeId: trade.tradeId,
      expiresAt: trade.expiresAt,
      now,
    });
  }
  return Object.freeze({ ...trade, state: TradeState.Expired, settledAt: now });
}

/** True when the trade can still change. */
export function isOpen(trade: Trade, now: number): boolean {
  return !isFinal(trade) && now < trade.expiresAt;
}

/** True when the trade has reached a final state. */
export function isFinal(trade: Trade): boolean {
  return (
    trade.state === TradeState.Cancelled ||
    trade.state === TradeState.Expired ||
    trade.state === TradeState.Completed
  );
}

/** Everything needed to settle. */
export interface TradeSettlementInput extends BookingOptions {
  readonly trade: Trade;
  readonly leftAccount: Account;
  readonly rightAccount: Account;
  readonly leftInventory: Inventory;
  readonly rightInventory: Inventory;
  /** Every item that appears on either side, by id. */
  readonly items: ReadonlyMap<string, Item> | Record<string, Item>;
}

/** What settling produced. All of it belongs in one transaction. */
export interface TradeSettlement {
  readonly trade: Trade;
  /** The net currency movement. `null` when neither side offered any. */
  readonly booking: BookingResult | null;
  readonly leftInventory: InventoryChange;
  readonly rightInventory: InventoryChange;
}

/**
 * Carry out an accepted trade.
 *
 * Both sides move at once. The currency is netted into a single posting: if one
 * side offers 100 and the other 30, exactly 70 moves, rather than two bookings
 * that would briefly leave one side short.
 *
 * Everything that could fail is checked before anything is produced. If this
 * function returns, all four parts fit together — and if it throws, nothing was
 * half-built.
 */
export function settleTrade(
  engine: EconomyEngine,
  input: TradeSettlementInput,
): TradeSettlement {
  const { trade } = input;

  if (trade.state !== TradeState.Accepted) {
    throw new TradeStateError("Only an accepted trade can be settled", {
      tradeId: trade.tradeId,
      state: trade.state,
    });
  }
  if (input.now >= trade.expiresAt) {
    throw new TradeStateError("This trade expired before it was settled", {
      tradeId: trade.tradeId,
      expiresAt: trade.expiresAt,
    });
  }

  const items = normaliseItems(input.items);
  assertAccountMatches(input.leftAccount, trade, trade.left.owner);
  assertAccountMatches(input.rightAccount, trade, trade.right.owner);

  // 1. Both sides must be able to pay what they offered.
  assertCanPay(input.leftAccount, trade.left.amount, engine);
  assertCanPay(input.rightAccount, trade.right.amount, engine);

  // 2. Both sides must actually hold, and be allowed to hand over, their items.
  assertCanHandOver(input.leftInventory, trade.left, items);
  assertCanHandOver(input.rightInventory, trade.right, items);

  // 3. Move the items. Each side loses its own and gains the other's.
  const leftChange = applySide(
    input.leftInventory,
    trade.left.items,
    trade.right.items,
    items,
  );
  const rightChange = applySide(
    input.rightInventory,
    trade.right.items,
    trade.left.items,
    items,
  );

  // 4. Net the currency into one movement.
  const net = trade.left.amount - trade.right.amount;
  let booking: BookingResult | null = null;
  if (net !== 0) {
    const payer = net > 0 ? input.leftAccount : input.rightAccount;
    const payee = net > 0 ? input.rightAccount : input.leftAccount;
    const amount = Math.abs(net);
    const lines: PostingLine[] = [
      {
        account: payer.ref,
        delta: -amount,
        balanceBefore: payer.balance,
        balanceAfter: payer.balance - amount,
      },
      {
        account: payee.ref,
        delta: amount,
        balanceBefore: payee.balance,
        balanceAfter: payee.balance + amount,
      },
    ];
    const posting = createPosting({
      operationId: input.operationId,
      kind: PostingKind.Trade,
      scope: trade.scope,
      currency: trade.currency,
      amount,
      reason: input.reason,
      occurredAt: input.now,
      lines,
      metadata: { ...(input.metadata ?? {}), tradeId: trade.tradeId },
    });
    booking = { posting, balances: Object.freeze(resultingBalances(posting)) };
  }

  return {
    trade: Object.freeze({
      ...trade,
      state: TradeState.Completed,
      settledAt: input.now,
    }),
    booking,
    leftInventory: leftChange,
    rightInventory: rightChange,
  };
}

function applySide(
  inventory: Inventory,
  gives: readonly InventorySlot[],
  receives: readonly InventorySlot[],
  items: Map<string, Item>,
): InventoryChange {
  let current = inventory;
  const deltas = [];
  for (const slot of gives) {
    const step = removeItem(current, slot.itemId, slot.quantity);
    current = step.inventory;
    deltas.push(...step.deltas);
  }
  for (const slot of receives) {
    const item = items.get(slot.itemId);
    if (item === undefined) {
      throw new ItemError("The trade references an item that was not supplied", {
        itemId: slot.itemId,
      });
    }
    const step = addItem(current, item, slot.quantity);
    current = step.inventory;
    deltas.push(...step.deltas);
  }
  return { inventory: current, deltas };
}

function assertCanPay(account: Account, amount: number, engine: EconomyEngine): void {
  if (amount === 0) {
    return;
  }
  if (!engine.config.allowNegative && account.balance < amount) {
    throw new InsufficientFundsError({
      account: accountKey(account.ref),
      balance: account.balance,
      required: amount,
      currency: account.ref.currency,
    });
  }
}

function assertCanHandOver(
  inventory: Inventory,
  side: TradeSide,
  items: Map<string, Item>,
): void {
  for (const slot of side.items) {
    const item = items.get(slot.itemId);
    if (item === undefined) {
      throw new ItemError("The trade references an item that was not supplied", {
        itemId: slot.itemId,
      });
    }
    if (!item.tradable) {
      throw new ItemError("This item cannot be traded", { itemId: slot.itemId });
    }
    if (inventory.quantityOf(slot.itemId) < slot.quantity) {
      throw new ItemError("A party does not hold what they offered", {
        owner: side.owner,
        itemId: slot.itemId,
        held: inventory.quantityOf(slot.itemId),
        offered: slot.quantity,
      });
    }
  }
}

function assertAccountMatches(account: Account, trade: Trade, owner: string): void {
  if (account.ref.owner !== owner) {
    throw new ValidationError("The supplied account does not belong to this party", {
      expected: owner,
      received: account.ref.owner,
    });
  }
  if (account.ref.scope !== trade.scope) {
    throw new ValidationError("The supplied account is in a different scope", {
      expected: trade.scope,
      received: account.ref.scope,
    });
  }
  if (account.ref.currency !== trade.currency) {
    throw new ValidationError("The supplied account holds a different currency", {
      expected: trade.currency,
      received: account.ref.currency,
    });
  }
}

function assertOpen(trade: Trade, now: number, action: string): void {
  if (isFinal(trade)) {
    throw new TradeStateError(
      `Cannot ${action} a trade that is already ${trade.state.toLowerCase()}`,
      { tradeId: trade.tradeId, state: trade.state },
    );
  }
  if (now >= trade.expiresAt) {
    throw new TradeStateError(`Cannot ${action} an expired trade`, {
      tradeId: trade.tradeId,
      expiresAt: trade.expiresAt,
      now,
    });
  }
}

function assertParty(trade: Trade, owner: string): void {
  if (owner !== trade.left.owner && owner !== trade.right.owner) {
    throw new ValidationError("This member is not part of the trade", {
      tradeId: trade.tradeId,
      owner,
    });
  }
}

function assertSide(side: TradeSide, name: string): void {
  if (typeof side.owner !== "string" || side.owner.length === 0) {
    throw new ValidationError(`The ${name} side needs an owner`, {});
  }
  if (!Number.isSafeInteger(side.amount) || side.amount < 0) {
    throw new ValidationError(`The ${name} side amount must be a non-negative integer`, {
      amount: side.amount,
    });
  }
  const seen = new Set<string>();
  for (const slot of side.items) {
    if (!Number.isSafeInteger(slot.quantity) || slot.quantity < 1) {
      throw new ValidationError(`The ${name} side offers an invalid quantity`, {
        itemId: slot.itemId,
        quantity: slot.quantity,
      });
    }
    if (seen.has(slot.itemId)) {
      throw new ValidationError(`The ${name} side lists the same item twice`, {
        itemId: slot.itemId,
      });
    }
    seen.add(slot.itemId);
  }
}

function isEmptySide(side: TradeSide): boolean {
  return side.amount === 0 && side.items.length === 0;
}

function freezeSide(side: TradeSide): TradeSide {
  return Object.freeze({
    owner: side.owner,
    amount: side.amount,
    items: Object.freeze(side.items.map((slot) => Object.freeze({ ...slot }))),
  });
}

function normaliseItems(
  items: ReadonlyMap<string, Item> | Record<string, Item>,
): Map<string, Item> {
  if (items instanceof Map) {
    return new Map(items);
  }
  return new Map(Object.entries(items));
}

export { sameAccount };
