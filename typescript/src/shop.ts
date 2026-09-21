import { type Account, emptyAccount, systemAccount } from "./accounts.js";
import type { EconomyEngine } from "./engine.js";
import {
  ConfigurationError,
  CurrencyMismatchError,
  OfferError,
  ValidationError,
} from "./errors.js";
import { PostingKind } from "./ledger.js";
import { addItem, type Inventory, type InventoryChange, type Item } from "./inventory.js";
import { assertPositiveAmount } from "./money.js";
import type { BookingOptions, BookingResult } from "./types.js";

/**
 * Something on sale.
 *
 * The route from a balance to an item. An offer is data, not behaviour: the
 * caller stores it, edits it, and hands it in when somebody buys.
 */
export interface Offer {
  readonly offerId: string;
  readonly itemId: string;
  /** Price for one unit, in minor units. */
  readonly unitPrice: number;
  readonly currency: string;
  /** Units left, or `null` for an unlimited offer. */
  readonly stock: number | null;
  /** How many one member may ever buy, or `null` for no limit. */
  readonly perMemberLimit: number | null;
  readonly enabled: boolean;
  /** Epoch milliseconds the offer opens, or `null` for always. */
  readonly availableFrom: number | null;
  /** Epoch milliseconds the offer closes, or `null` for never. */
  readonly availableUntil: number | null;
}

/** Loose input for {@link createOffer}. */
export interface OfferInput {
  readonly offerId: string;
  readonly itemId: string;
  readonly unitPrice: number;
  readonly currency: string;
  readonly stock?: number | null;
  readonly perMemberLimit?: number | null;
  readonly enabled?: boolean;
  readonly availableFrom?: number | null;
  readonly availableUntil?: number | null;
}

/** Build a validated {@link Offer}. */
export function createOffer(input: OfferInput): Offer {
  if (typeof input.offerId !== "string" || input.offerId.length === 0) {
    throw new ConfigurationError("An offer needs a non-empty offerId", {});
  }
  if (typeof input.itemId !== "string" || input.itemId.length === 0) {
    throw new ConfigurationError("An offer needs an itemId", { offerId: input.offerId });
  }
  if (!Number.isSafeInteger(input.unitPrice) || input.unitPrice < 0) {
    throw new ConfigurationError("unitPrice must be a non-negative integer", {
      unitPrice: input.unitPrice,
    });
  }
  const stock = input.stock ?? null;
  if (stock !== null && (!Number.isSafeInteger(stock) || stock < 0)) {
    throw new ConfigurationError("stock must be a non-negative integer or null", { stock });
  }
  const perMemberLimit = input.perMemberLimit ?? null;
  if (
    perMemberLimit !== null &&
    (!Number.isSafeInteger(perMemberLimit) || perMemberLimit < 1)
  ) {
    throw new ConfigurationError("perMemberLimit must be a positive integer or null", {
      perMemberLimit,
    });
  }
  const availableFrom = input.availableFrom ?? null;
  const availableUntil = input.availableUntil ?? null;
  if (
    availableFrom !== null &&
    availableUntil !== null &&
    availableUntil <= availableFrom
  ) {
    throw new ConfigurationError("An offer cannot close before it opens", {
      availableFrom,
      availableUntil,
    });
  }

  return Object.freeze({
    offerId: input.offerId,
    itemId: input.itemId,
    unitPrice: input.unitPrice,
    currency: input.currency,
    stock,
    perMemberLimit,
    enabled: input.enabled ?? true,
    availableFrom,
    availableUntil,
  });
}

/** Everything a purchase needs. */
export interface PurchaseInput extends BookingOptions {
  readonly offer: Offer;
  readonly item: Item;
  readonly buyer: Account;
  readonly inventory: Inventory;
  readonly quantity?: number;
  /** How many of this offer the buyer has already taken. */
  readonly alreadyPurchased?: number;
  /** Where the money goes. Defaults to the scope's shop account. */
  readonly shopAccount?: Account;
}

/** What a purchase produced. Write all three parts in one transaction. */
export interface PurchaseResult {
  /** The payment. */
  readonly booking: BookingResult;
  /** The items the buyer received. */
  readonly inventory: InventoryChange;
  /** The offer with its stock reduced, ready to be stored. */
  readonly offer: Offer;
  readonly quantity: number;
  readonly totalPrice: number;
}

/**
 * Buy from an offer.
 *
 * Three things change together: the buyer's balance, the buyer's inventory and
 * the offer's stock. They come back as one result and belong in one database
 * transaction — the same rule as everywhere else in this package. A purchase
 * where the money left but the item never arrived is the complaint you will be
 * answering for the rest of the week.
 *
 * Everything that could make the purchase impossible is checked before anything
 * is produced: availability, stock, per-member limit, funds, inventory space.
 */
export function purchase(engine: EconomyEngine, input: PurchaseInput): PurchaseResult {
  const quantity = input.quantity ?? 1;
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new ValidationError("A purchase quantity must be a positive integer", {
      quantity,
    });
  }
  if (input.offer.itemId !== input.item.itemId) {
    throw new ValidationError("The offer and the item do not match", {
      offerItem: input.offer.itemId,
      item: input.item.itemId,
    });
  }
  if (input.offer.currency !== input.buyer.ref.currency) {
    throw new CurrencyMismatchError({
      expected: input.offer.currency,
      received: input.buyer.ref.currency,
    });
  }

  assertAvailable(input.offer, input.now);

  if (input.offer.stock !== null && input.offer.stock < quantity) {
    throw new OfferError("The offer does not have that many left", {
      offerId: input.offer.offerId,
      stock: input.offer.stock,
      requested: quantity,
    });
  }

  const alreadyPurchased = input.alreadyPurchased ?? 0;
  if (
    input.offer.perMemberLimit !== null &&
    alreadyPurchased + quantity > input.offer.perMemberLimit
  ) {
    throw new OfferError("That would exceed the per-member limit for this offer", {
      offerId: input.offer.offerId,
      limit: input.offer.perMemberLimit,
      alreadyPurchased,
      requested: quantity,
    });
  }

  const totalPrice = input.offer.unitPrice * quantity;
  if (!Number.isSafeInteger(totalPrice)) {
    throw new ValidationError("The total price leaves the safe integer range", {
      unitPrice: input.offer.unitPrice,
      quantity,
    });
  }

  // Produce the inventory change first: it can still fail on a stack limit, and
  // failing before the payment is built keeps the two from disagreeing.
  const inventoryChange = addItem(input.inventory, input.item, quantity);

  const shopAccount =
    input.shopAccount ??
    emptyAccount(
      systemAccount(input.buyer.ref.scope, input.buyer.ref.currency, engine.config
        .shopAccountOwner as never),
    );

  let booking: BookingResult;
  if (totalPrice === 0) {
    // A free offer still books, so the audit trail records that it was taken.
    booking = zeroBooking(input, shopAccount);
  } else {
    assertPositiveAmount(totalPrice);
    booking = engine.transfer(input.buyer, shopAccount, totalPrice, {
      now: input.now,
      operationId: input.operationId,
      reason: input.reason,
      metadata: {
        ...(input.metadata ?? {}),
        offerId: input.offer.offerId,
        itemId: input.item.itemId,
        quantity: String(quantity),
      },
    });
  }

  const nextOffer: Offer = Object.freeze({
    ...input.offer,
    stock: input.offer.stock === null ? null : input.offer.stock - quantity,
  });

  return {
    booking,
    inventory: inventoryChange,
    offer: nextOffer,
    quantity,
    totalPrice,
  };
}

/** True when the offer can be bought at this moment. */
export function isAvailable(offer: Offer, now: number): boolean {
  if (!offer.enabled) {
    return false;
  }
  if (offer.availableFrom !== null && now < offer.availableFrom) {
    return false;
  }
  if (offer.availableUntil !== null && now >= offer.availableUntil) {
    return false;
  }
  return offer.stock === null || offer.stock > 0;
}

/** The largest quantity a member could buy right now. */
export function maxPurchasable(
  offer: Offer,
  balance: number,
  alreadyPurchased = 0,
  now: number = offer.availableFrom ?? 0,
): number {
  if (!isAvailable(offer, now)) {
    return 0;
  }
  const limits: number[] = [];
  if (offer.unitPrice > 0) {
    limits.push(Math.floor(balance / offer.unitPrice));
  }
  if (offer.stock !== null) {
    limits.push(offer.stock);
  }
  if (offer.perMemberLimit !== null) {
    limits.push(Math.max(0, offer.perMemberLimit - alreadyPurchased));
  }
  if (limits.length === 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(0, Math.min(...limits));
}

function assertAvailable(offer: Offer, now: number): void {
  if (!offer.enabled) {
    throw new OfferError("This offer is not on sale", { offerId: offer.offerId });
  }
  if (offer.availableFrom !== null && now < offer.availableFrom) {
    throw new OfferError("This offer has not opened yet", {
      offerId: offer.offerId,
      availableFrom: offer.availableFrom,
    });
  }
  if (offer.availableUntil !== null && now >= offer.availableUntil) {
    throw new OfferError("This offer has closed", {
      offerId: offer.offerId,
      availableUntil: offer.availableUntil,
    });
  }
  if (offer.stock !== null && offer.stock <= 0) {
    throw new OfferError("This offer is sold out", { offerId: offer.offerId });
  }
}

/** A zero-amount posting, so a free offer still leaves an audit trail. */
function zeroBooking(input: PurchaseInput, shopAccount: Account): BookingResult {
  const posting = {
    operationId: input.operationId,
    kind: PostingKind.Purchase,
    scope: input.buyer.ref.scope,
    currency: input.buyer.ref.currency,
    amount: 0,
    reason: input.reason,
    occurredAt: input.now,
    reverses: null,
    metadata: Object.freeze({
      ...(input.metadata ?? {}),
      offerId: input.offer.offerId,
      itemId: input.item.itemId,
      quantity: String(input.quantity ?? 1),
      free: "true",
    }),
    lines: Object.freeze([
      {
        account: input.buyer.ref,
        delta: 0,
        balanceBefore: input.buyer.balance,
        balanceAfter: input.buyer.balance,
      },
      {
        account: shopAccount.ref,
        delta: 0,
        balanceBefore: shopAccount.balance,
        balanceAfter: shopAccount.balance,
      },
    ]),
  } as const;

  return {
    posting,
    balances: Object.freeze({
      [`${input.buyer.ref.scope}/${input.buyer.ref.owner}/${input.buyer.ref.currency}`]:
        input.buyer.balance,
      [`${shopAccount.ref.scope}/${shopAccount.ref.owner}/${shopAccount.ref.currency}`]:
        shopAccount.balance,
    }),
  };
}
