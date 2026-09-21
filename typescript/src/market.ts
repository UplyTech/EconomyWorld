/**
 * Markets: an order book, currency exchange, and auctions.
 *
 * Three ways for members to trade with each other at a price neither of them
 * sets alone. All of them are deterministic: given the same orders in the same
 * order, every edition and every run produces the same fills.
 *
 * # Matching is by price, then time, then id
 *
 * Price priority first: the buyer willing to pay most trades first, and so does
 * the seller willing to accept least. Then time: of two equal prices the older
 * order trades first. Then the order id, alphabetically.
 *
 * **The last tie-break is not decoration.** Two orders placed in the same
 * millisecond are common in a bot that handles a burst of commands, and without
 * a final rule the winner would depend on the order an object happened to
 * iterate in — which is exactly how two editions come to disagree about who got
 * the trade. The id is the caller's, stable, and stored, so the answer is the
 * same everywhere and can be explained to whoever lost.
 *
 * # A trade happens at the resting order's price
 *
 * The order already on the book set its price first; the one that arrives and
 * crosses it accepts. A buyer bidding 12 who meets a resting ask of 10 pays 10
 * and keeps the difference, which is the convention every exchange uses and the
 * one that makes placing an order early worth something.
 *
 * # Nothing here moves a price
 *
 * The book has no market maker, no spread model, no drift. Prices are what
 * members offer. See `instruments.ts` for why that boundary is where it is.
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
  AuctionStateError,
  CurrencyMismatchError,
  OrderError,
  ValidationError,
} from "./errors.js";
import { PostingKind } from "./ledger.js";
import { applyRate, assertPositiveAmount, assertWholeAmount } from "./money.js";
import { Rounding } from "./rounding.js";
import type { BookingResult } from "./types.js";

/** Which way round a member wants to trade. */
export enum OrderSide {
  Buy = "BUY",
  Sell = "SELL",
}

/** Where an order is in its life. */
export enum OrderState {
  Open = "OPEN",
  PartiallyFilled = "PARTIALLY_FILLED",
  Filled = "FILLED",
  Cancelled = "CANCELLED",
}

/** A limit order sitting on, or arriving at, a book. */
export interface Order {
  readonly orderId: string;
  readonly owner: AccountRef;
  readonly instrumentId: string;
  readonly side: OrderSide;
  /**
   * What one unit is offered or asked for. A limit, not a promise: a buy fills
   * at this price *or better*.
   */
  readonly unitPrice: number;
  readonly quantity: number;
  readonly filled: number;
  readonly placedAt: number;
  readonly state: OrderState;
}

/** One trade between two orders. */
export interface Fill {
  readonly buyOrderId: string;
  readonly sellOrderId: string;
  readonly buyer: AccountRef;
  readonly seller: AccountRef;
  readonly instrumentId: string;
  readonly quantity: number;
  /** The resting order's price. See this module's opening note. */
  readonly unitPrice: number;
  readonly consideration: number;
}

/** What placing an order did to the book. */
export interface MatchResult {
  /** The incoming order, with whatever it filled. */
  readonly order: Order;
  /** The resting orders it traded against, updated. Store these. */
  readonly touched: readonly Order[];
  readonly fills: readonly Fill[];
  /** The book after the match: active orders only, in matching order. */
  readonly book: readonly Order[];
}

export function remaining(order: Order): number {
  return order.quantity - order.filled;
}

export function isActive(order: Order): boolean {
  return order.state === OrderState.Open || order.state === OrderState.PartiallyFilled;
}

export function filledQuantity(result: MatchResult): number {
  return result.fills.reduce((sum, fill) => sum + fill.quantity, 0);
}

export function totalConsideration(result: MatchResult): number {
  return result.fills.reduce((sum, fill) => sum + fill.consideration, 0);
}

/** Build a validated order. */
export function createOrder(
  orderId: string,
  owner: AccountRef,
  instrumentId: string,
  side: OrderSide,
  unitPrice: number,
  quantity: number,
  placedAt: number,
): Order {
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new OrderError("An order needs a non-empty id", { orderId });
  }
  if (typeof instrumentId !== "string" || instrumentId.length === 0) {
    throw new OrderError("An order needs an instrument", { instrumentId });
  }
  assertPositiveAmount(quantity);
  assertPositiveAmount(unitPrice);
  assertTimestamp(placedAt);
  return {
    orderId,
    owner,
    instrumentId,
    side,
    unitPrice,
    quantity,
    filled: 0,
    placedAt,
    state: OrderState.Open,
  };
}

/**
 * Order the side of the book an order rests on.
 *
 * Best price first. For buys the best price is the highest, so it is negated;
 * for sells the lowest is best and it is not. Then oldest first, then id — the
 * tie-break that keeps two orders placed in the same millisecond from depending
 * on iteration order.
 */
function comparePriority(left: Order, right: Order): number {
  const leftPrice = left.side === OrderSide.Buy ? -left.unitPrice : left.unitPrice;
  const rightPrice = right.side === OrderSide.Buy ? -right.unitPrice : right.unitPrice;
  if (leftPrice !== rightPrice) return leftPrice - rightPrice;
  if (left.placedAt !== right.placedAt) return left.placedAt - right.placedAt;
  return left.orderId < right.orderId ? -1 : left.orderId > right.orderId ? 1 : 0;
}

/**
 * Match an arriving order against a book. Books nothing.
 *
 * Pure: takes the book, returns the new book. Nothing is stored and no posting
 * is made, because a fill is only a fill once the caller has written it — and
 * the caller may want to check funds or holds first. Turn the fills into
 * postings with {@link settleFill}.
 *
 * An order that does not fill completely stays on the book for the remainder,
 * which is what a limit order is for.
 */
export function matchOrder(incoming: Order, book: readonly Order[]): MatchResult {
  if (!isActive(incoming)) {
    throw new OrderError("That order is not active", {
      orderId: incoming.orderId,
      state: incoming.state,
    });
  }

  const opposite = incoming.side === OrderSide.Buy ? OrderSide.Sell : OrderSide.Buy;
  const candidates = book
    .filter(
      (order) =>
        isActive(order) &&
        order.side === opposite &&
        order.instrumentId === incoming.instrumentId &&
        accountKey(order.owner) !== accountKey(incoming.owner),
    )
    .sort(comparePriority);

  const fills: Fill[] = [];
  const touched = new Map<string, Order>();
  let working = incoming;

  for (const resting of candidates) {
    if (remaining(working) === 0) break;
    if (!crosses(working, resting)) {
      // The book is sorted best-first, so once one does not cross, none of the
      // rest will either.
      break;
    }

    const quantity = Math.min(remaining(working), remaining(resting));
    // The resting order's price: it was there first, and it named the terms.
    const price = resting.unitPrice;
    const consideration = quantity * price;
    assertWholeAmount(consideration);

    const workingIsBuy = working.side === OrderSide.Buy;
    fills.push({
      buyOrderId: workingIsBuy ? working.orderId : resting.orderId,
      sellOrderId: workingIsBuy ? resting.orderId : working.orderId,
      buyer: workingIsBuy ? working.owner : resting.owner,
      seller: workingIsBuy ? resting.owner : working.owner,
      instrumentId: working.instrumentId,
      quantity,
      unitPrice: price,
      consideration,
    });

    working = applyFill(working, quantity);
    touched.set(resting.orderId, applyFill(resting, quantity));
  }

  const newBook = book
    .map((order) => touched.get(order.orderId) ?? order)
    .filter((order) => isActive(order));
  if (isActive(working) && remaining(working) > 0) {
    newBook.push(working);
  }

  return {
    order: working,
    touched: [...touched.values()],
    fills,
    book: newBook.sort(comparePriority),
  };
}

/** Whether these two orders are willing to trade with each other. */
function crosses(incoming: Order, resting: Order): boolean {
  if (incoming.side === OrderSide.Buy) return incoming.unitPrice >= resting.unitPrice;
  return incoming.unitPrice <= resting.unitPrice;
}

function applyFill(order: Order, quantity: number): Order {
  const filled = order.filled + quantity;
  return {
    ...order,
    filled,
    state: filled >= order.quantity ? OrderState.Filled : OrderState.PartiallyFilled,
  };
}

/**
 * Take an order off the book. Returns the cancelled order and the rest.
 *
 * A partly filled order can be cancelled; the part already traded stays traded.
 * Cancelling one that is already filled or cancelled is refused rather than
 * ignored, because a bot that thinks it cancelled something it did not will show
 * a member the wrong thing.
 */
export function cancelOrder(
  book: readonly Order[],
  orderId: string,
): { cancelled: Order; book: Order[] } {
  for (const order of book) {
    if (order.orderId === orderId) {
      if (!isActive(order)) {
        throw new OrderError("That order is no longer active", {
          orderId,
          state: order.state,
        });
      }
      return {
        cancelled: { ...order, state: OrderState.Cancelled },
        book: book.filter((o) => o.orderId !== orderId),
      };
    }
  }
  throw new OrderError("No such order on the book", { orderId });
}

/** The highest active buy order, or `null`. */
export function bestBid(book: readonly Order[], instrumentId: string): Order | null {
  return best(book, instrumentId, OrderSide.Buy);
}

/** The lowest active sell order, or `null`. */
export function bestAsk(book: readonly Order[], instrumentId: string): Order | null {
  return best(book, instrumentId, OrderSide.Sell);
}

function best(
  book: readonly Order[],
  instrumentId: string,
  side: OrderSide,
): Order | null {
  const candidates = book
    .filter((o) => isActive(o) && o.side === side && o.instrumentId === instrumentId)
    .sort(comparePriority);
  return candidates.length > 0 ? (candidates[0] as Order) : null;
}

/**
 * Ask minus bid, or `null` when one side is empty.
 *
 * `null` rather than zero: an empty side is not a tight market, and a bot that
 * showed "spread: 0" for a book with no sellers would be lying.
 */
export function spread(book: readonly Order[], instrumentId: string): number | null {
  const bid = bestBid(book, instrumentId);
  const ask = bestAsk(book, instrumentId);
  if (bid === null || ask === null) return null;
  return ask.unitPrice - bid.unitPrice;
}

/** How many units are on one side of the book. */
export function bookDepth(
  book: readonly Order[],
  instrumentId: string,
  side: OrderSide,
): number {
  return book
    .filter((o) => isActive(o) && o.side === side && o.instrumentId === instrumentId)
    .reduce((sum, o) => sum + remaining(o), 0);
}

/**
 * Move the currency for one fill.
 *
 * The units themselves are the caller's to move — they live in an inventory or a
 * position, and this module does not know which. Both belong in one database
 * transaction, as always.
 */
export function settleFill(
  engine: EconomyEngine,
  fill: Fill,
  buyer: Account,
  seller: Account,
  options: {
    now: number;
    operationId: string;
    reason: string;
    metadata?: Record<string, string>;
  },
): BookingResult {
  assertTimestamp(options.now);
  if (accountKey(buyer.ref) !== accountKey(fill.buyer)) {
    throw new OrderError("That account is not the buyer", {
      expected: accountKey(fill.buyer),
      given: accountKey(buyer.ref),
    });
  }
  if (accountKey(seller.ref) !== accountKey(fill.seller)) {
    throw new OrderError("That account is not the seller", {
      expected: accountKey(fill.seller),
      given: accountKey(seller.ref),
    });
  }
  return engine.transfer(buyer, seller, fill.consideration, {
    now: options.now,
    operationId: options.operationId,
    reason: options.reason,
    kind: PostingKind.Settlement,
    metadata: options.metadata,
  });
}

/**
 * Swap one currency for another at a rate the caller supplies.
 *
 * Two currencies means **two postings**, because a posting balances within one
 * currency and always will: 100 GOLD leaving one account and 250 SILVER arriving
 * in another do not sum to zero and never should. The first posting retires the
 * currency sold into its sink; the second issues the currency bought from its
 * mint. The money supply of each currency moves, and both movements are on the
 * books.
 *
 * `rateNumerator / rateDenominator` is how much of the bought currency one unit
 * of the sold currency is worth. The rate is an argument: this package does not
 * know what a GOLD is worth in SILVER, and inventing an answer is how a library
 * starts having opinions about a market.
 *
 * Returns both postings and the amount received. Write all of it in one
 * transaction — half an exchange is a member who paid and got nothing.
 */
export function exchange(
  engine: EconomyEngine,
  seller: Account,
  buyerSide: Account,
  amount: number,
  rateNumerator: number,
  rateDenominator: number,
  options: {
    now: number;
    operationId: string;
    reason: string;
    sink?: Account;
    source?: Account;
    rounding?: Rounding;
    metadata?: Record<string, string>;
  },
): { sold: BookingResult; bought: BookingResult; received: number } {
  assertPositiveAmount(amount);
  assertTimestamp(options.now);
  if (seller.ref.owner !== buyerSide.ref.owner) {
    throw new ValidationError("An exchange is one member swapping their own currency", {
      selling: accountKey(seller.ref),
      buying: accountKey(buyerSide.ref),
    });
  }
  if (seller.ref.currency === buyerSide.ref.currency) {
    throw new CurrencyMismatchError({
      expected: "two different currencies",
      received: seller.ref.currency,
    });
  }
  if (seller.ref.scope !== buyerSide.ref.scope) {
    throw new ValidationError("An exchange cannot cross scopes", {
      selling: seller.ref.scope,
      buying: buyerSide.ref.scope,
    });
  }

  const received = applyRate(
    amount,
    rateNumerator,
    rateDenominator,
    options.rounding ?? Rounding.Down,
  );
  if (received <= 0) {
    throw new OrderError(
      "That rate and amount buy nothing: the exchange would take currency and give none back",
      { amount, rateNumerator, rateDenominator },
    );
  }

  const sold = engine.transfer(
    seller,
    options.sink ??
      emptyAccount(systemAccount(seller.ref.scope, seller.ref.currency, SystemAccount.Sink)),
    amount,
    {
      now: options.now,
      operationId: `${options.operationId}:sell`,
      reason: options.reason,
      kind: PostingKind.Exchange,
      // The source is the member. An exchange spends currency they hold.
      allowNegative: false,
      metadata: options.metadata,
    },
  );
  const bought = engine.transfer(
    options.source ??
      emptyAccount(
        systemAccount(buyerSide.ref.scope, buyerSide.ref.currency, SystemAccount.Mint),
      ),
    buyerSide,
    received,
    {
      now: options.now,
      operationId: `${options.operationId}:buy`,
      reason: options.reason,
      kind: PostingKind.Exchange,
      // The mint issues; a named reserve pays out of its own balance.
      allowNegative: options.source === undefined,
      metadata: options.metadata,
    },
  );
  return { sold, bought, received };
}

// ---------------------------------------------------------------------------
// Auctions
// ---------------------------------------------------------------------------

/** Where an auction is in its life. */
export enum AuctionState {
  Open = "OPEN",
  /** Closed with a winner, waiting to be settled. */
  Won = "WON",
  /** Closed with no bid that met the reserve. */
  Unsold = "UNSOLD",
  /** Closed and paid for. */
  Settled = "SETTLED",
  Cancelled = "CANCELLED",
}

/** One bid in an auction. */
export interface Bid {
  readonly bidder: AccountRef;
  readonly amount: number;
  readonly placedAt: number;
  /**
   * The caller's own id for the bid. The final tie-break when two bids of the
   * same size arrive in the same millisecond.
   */
  readonly bidId: string;
}

/** An item offered to the highest bidder. */
export interface Auction {
  readonly auctionId: string;
  readonly seller: AccountRef;
  /**
   * What is being sold. An item id, an instrument id — this module does not
   * care, and hands it back untouched.
   */
  readonly subject: string;
  readonly currency: string;
  /** The least that will be accepted. A bid below it does not win. */
  readonly reserve: number;
  /**
   * Whether the reserve is kept from bidders.
   *
   * **Open** (the default): a bid below the reserve is refused as it is placed,
   * with the reserve in the error. Kinder, and the right choice when the reserve
   * is on the listing anyway.
   *
   * **Hidden**: bids below the reserve are accepted and simply do not win. The
   * auction closes `Unsold`, and the bidders never learn what the reserve was.
   * This is how a real auction house runs one, and it is worth having — but it
   * means somebody can bid in good faith and lose to a number they could not
   * see, so it is opt-in.
   */
  readonly reserveHidden: boolean;
  /** The least a new bid must beat the standing one by. */
  readonly minIncrement: number;
  readonly openedAt: number;
  /** When bidding closes. Bids at or after this moment are refused. */
  readonly endsAt: number;
  readonly bids: readonly Bid[];
  readonly state: AuctionState;
}

/** What closing an auction decided. */
export interface AuctionOutcome {
  readonly auction: Auction;
  readonly winner: Bid | null;
  /**
   * What the winner pays. The bid itself — this is a first-price auction,
   * because a second-price rule surprises people who have not read about it.
   */
  readonly price: number;
}

/** The bid that would win if the auction closed now. */
export function highestBid(auction: Auction): Bid | null {
  if (auction.bids.length === 0) return null;
  // Highest amount, then earliest, then id: the same three-part rule the order
  // book uses, for the same reason.
  return [...auction.bids].sort((a, b) => {
    if (a.amount !== b.amount) return b.amount - a.amount;
    if (a.placedAt !== b.placedAt) return a.placedAt - b.placedAt;
    return a.bidId < b.bidId ? -1 : a.bidId > b.bidId ? 1 : 0;
  })[0] as Bid;
}

/**
 * Start an auction.
 *
 * With an open reserve a bid below it is refused when it is placed. With a
 * hidden one it is accepted and loses at the close — see
 * {@link Auction.reserveHidden}.
 */
export function openAuction(options: {
  auctionId: string;
  seller: AccountRef;
  subject: string;
  currency: string;
  reserve: number;
  openedAt: number;
  endsAt: number;
  minIncrement?: number;
  reserveHidden?: boolean;
}): Auction {
  const minIncrement = options.minIncrement ?? 1;
  if (typeof options.auctionId !== "string" || options.auctionId.length === 0) {
    throw new AuctionStateError("An auction needs a non-empty id", {
      auctionId: options.auctionId,
    });
  }
  if (typeof options.subject !== "string" || options.subject.length === 0) {
    throw new AuctionStateError("An auction needs a subject", { subject: options.subject });
  }
  assertWholeAmount(options.reserve);
  if (options.reserve < 0) {
    throw new AuctionStateError("A reserve cannot be negative", { reserve: options.reserve });
  }
  assertPositiveAmount(minIncrement);
  assertTimestamp(options.openedAt);
  assertTimestamp(options.endsAt);
  if (options.endsAt <= options.openedAt) {
    throw new AuctionStateError("An auction cannot close before it opens", {
      openedAt: options.openedAt,
      endsAt: options.endsAt,
    });
  }
  return {
    auctionId: options.auctionId,
    seller: options.seller,
    subject: options.subject,
    currency: options.currency,
    reserve: options.reserve,
    reserveHidden: options.reserveHidden ?? false,
    minIncrement,
    openedAt: options.openedAt,
    endsAt: options.endsAt,
    bids: [],
    state: AuctionState.Open,
  };
}

/**
 * Add a bid. Nothing is booked; hold the funds instead.
 *
 * A bid is a promise, not a payment — so nothing moves until the auction
 * settles. What should move is a **hold**: see `placeHold` in `bank.ts`, which
 * stops a member bidding the same balance in three auctions at once.
 */
export function placeBid(auction: Auction, bid: Bid, now: number): Auction {
  assertTimestamp(now);
  if (auction.state !== AuctionState.Open) {
    throw new AuctionStateError("That auction is not open", {
      auctionId: auction.auctionId,
      state: auction.state,
    });
  }
  if (now >= auction.endsAt) {
    throw new AuctionStateError("Bidding has closed", {
      auctionId: auction.auctionId,
      endsAt: auction.endsAt,
    });
  }
  assertPositiveAmount(bid.amount);
  if (accountKey(bid.bidder) === accountKey(auction.seller)) {
    throw new AuctionStateError("A seller cannot bid on their own auction", {
      auctionId: auction.auctionId,
    });
  }
  if (bid.bidder.currency !== auction.currency) {
    throw new CurrencyMismatchError({
      expected: auction.currency,
      received: bid.bidder.currency,
    });
  }
  if (auction.bids.some((existing) => existing.bidId === bid.bidId)) {
    throw new AuctionStateError("That bid id is already in use", { bidId: bid.bidId });
  }

  const standing = highestBid(auction);
  let floor: number;
  if (standing === null) {
    // With a hidden reserve the first bid may be anything: refusing it would
    // tell the bidder what the reserve was, which is the one thing hiding it is
    // supposed to prevent.
    floor = auction.reserveHidden ? 1 : auction.reserve;
  } else {
    floor = standing.amount + auction.minIncrement;
  }
  if (bid.amount < floor) {
    throw new AuctionStateError("That bid is too low", {
      auctionId: auction.auctionId,
      offered: bid.amount,
      minimum: floor,
    });
  }

  return { ...auction, bids: [...auction.bids, bid] };
}

/**
 * Decide who won. Books nothing.
 *
 * Closing early is allowed — a seller may withdraw the lot before time — but
 * closing before `endsAt` still uses the bids that are in, which is what a "buy
 * it now" or a cancelled listing needs.
 */
export function closeAuction(auction: Auction, now: number): AuctionOutcome {
  assertTimestamp(now);
  if (auction.state !== AuctionState.Open) {
    throw new AuctionStateError("That auction is already closed", {
      auctionId: auction.auctionId,
      state: auction.state,
    });
  }

  const winner = highestBid(auction);
  // The reserve is checked here as well as when a bid is placed, because a
  // hidden reserve is only checked here: that is what hiding it means.
  if (winner === null || winner.amount < auction.reserve) {
    return {
      auction: { ...auction, state: AuctionState.Unsold },
      winner: null,
      price: 0,
    };
  }
  return {
    auction: { ...auction, state: AuctionState.Won },
    winner,
    price: winner.amount,
  };
}

/**
 * Move the winner's currency to the seller.
 *
 * Handing the item over is the caller's — it lives in an inventory or a
 * position, and both belong in the same transaction as this posting.
 */
export function settleAuction(
  engine: EconomyEngine,
  outcome: AuctionOutcome,
  winnerAccount: Account,
  sellerAccount: Account,
  options: {
    now: number;
    operationId: string;
    reason: string;
    metadata?: Record<string, string>;
  },
): { booking: BookingResult; auction: Auction } {
  assertTimestamp(options.now);
  if (outcome.auction.state !== AuctionState.Won || outcome.winner === null) {
    throw new AuctionStateError("That auction has no winner to settle", {
      auctionId: outcome.auction.auctionId,
      state: outcome.auction.state,
    });
  }
  if (accountKey(winnerAccount.ref) !== accountKey(outcome.winner.bidder)) {
    throw new AuctionStateError("That account did not win", {
      expected: accountKey(outcome.winner.bidder),
      given: accountKey(winnerAccount.ref),
    });
  }
  if (accountKey(sellerAccount.ref) !== accountKey(outcome.auction.seller)) {
    throw new AuctionStateError("That account is not the seller", {
      expected: accountKey(outcome.auction.seller),
      given: accountKey(sellerAccount.ref),
    });
  }

  const booking = engine.transfer(winnerAccount, sellerAccount, outcome.price, {
    now: options.now,
    operationId: options.operationId,
    reason: options.reason,
    kind: PostingKind.Settlement,
    metadata: options.metadata,
  });
  return { booking, auction: { ...outcome.auction, state: AuctionState.Settled } };
}

function assertTimestamp(now: number): void {
  if (!Number.isSafeInteger(now)) {
    throw new ValidationError("Timestamps are epoch milliseconds as integers", {
      timestamp: now,
    });
  }
}
