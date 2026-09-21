import { describe, expect, it } from "vitest";
import {
  account,
  accountKey,
  AuctionState,
  AuctionStateError,
  bestAsk,
  bestBid,
  bookDepth,
  cancelOrder,
  closeAuction,
  createCurrency,
  createOrder,
  CurrencyMismatchError,
  EconomyEngine,
  exchange,
  filledQuantity,
  highestBid,
  InsufficientFundsError,
  InvalidAmountError,
  isActive,
  matchOrder,
  memberAccount,
  openAuction,
  OrderError,
  OrderSide,
  OrderState,
  placeBid,
  PostingKind,
  remaining,
  Rounding,
  settleAuction,
  settleFill,
  spread,
  SystemAccount,
  systemAccount,
  totalConsideration,
  ValidationError,
  type Auction,
  type Bid,
  type Order,
} from "../src/index.js";

/** The mirror of `python/tests/test_market.py`. */

const NOW = 1_700_000_000_000;
const LATER = NOW + 60_000;

function engine(): EconomyEngine {
  return new EconomyEngine({
    currencies: [createCurrency({ code: "COIN" }), createCurrency({ code: "GEM" })],
  });
}

function ref(name: string, currency = "COIN") {
  return memberAccount("g1", name, currency);
}

function order(
  orderId: string,
  owner: string,
  side: OrderSide,
  price: number,
  quantity: number,
  placedAt = NOW,
  instrument = "ore",
): Order {
  return createOrder(orderId, ref(owner), instrument, side, price, quantity, placedAt);
}

function buy(orderId: string, owner: string, price: number, quantity: number, placedAt = NOW, instrument = "ore") {
  return order(orderId, owner, OrderSide.Buy, price, quantity, placedAt, instrument);
}

function sell(orderId: string, owner: string, price: number, quantity: number, placedAt = NOW, instrument = "ore") {
  return order(orderId, owner, OrderSide.Sell, price, quantity, placedAt, instrument);
}

describe("building an order", () => {
  it("starts open and unfilled", () => {
    const o = buy("o1", "ada", 100, 10);
    expect(o.state).toBe(OrderState.Open);
    expect(o.filled).toBe(0);
    expect(remaining(o)).toBe(10);
    expect(isActive(o)).toBe(true);
  });

  it("refuses an empty id, a zero quantity and a negative price", () => {
    expect(() => buy("", "ada", 100, 10)).toThrow();
    expect(() => buy("o", "ada", 100, 0)).toThrow();
    expect(() => buy("o", "ada", -1, 10)).toThrow();
  });
});

describe("matching", () => {
  it("fills a crossing order", () => {
    const result = matchOrder(buy("b1", "ada", 100, 10), [sell("s1", "bob", 100, 10)]);
    expect(result.fills).toHaveLength(1);
    const fill = result.fills[0]!;
    expect([fill.quantity, fill.unitPrice, fill.consideration]).toEqual([10, 100, 1_000]);
    expect(result.order.state).toBe(OrderState.Filled);
    expect(result.book).toEqual([]);
  });

  it("rests an order that does not cross", () => {
    const result = matchOrder(buy("b1", "ada", 100, 10), [sell("s1", "bob", 120, 10)]);
    expect(result.fills).toEqual([]);
    expect(result.book).toHaveLength(2);
  });

  it("lets the resting order name the price", () => {
    // A buyer willing to pay 150 pays the 100 that was already on the book.
    // Charging the incoming limit instead would make it profitable to watch the
    // book and quote just under every bid.
    const result = matchOrder(buy("b1", "ada", 150, 5), [sell("s1", "bob", 100, 5)]);
    expect(result.fills[0]!.unitPrice).toBe(100);
  });

  it("puts price priority before time", () => {
    const book = [sell("late-cheap", "bob", 90, 5, NOW + 10), sell("early-dear", "cat", 110, 5)];
    expect(matchOrder(buy("b1", "ada", 200, 5), book).fills[0]!.sellOrderId).toBe("late-cheap");
  });

  it("breaks a price tie by time", () => {
    const book = [sell("second", "bob", 100, 5, NOW + 10), sell("first", "cat", 100, 5)];
    expect(matchOrder(buy("b1", "ada", 100, 5), book).fills[0]!.sellOrderId).toBe("first");
  });

  it("breaks a price and time tie by id", () => {
    // Two orders in the same millisecond must not depend on list order.
    const book = [sell("bbb", "bob", 100, 5), sell("aaa", "cat", 100, 5)];
    expect(matchOrder(buy("b1", "ada", 100, 5), book).fills[0]!.sellOrderId).toBe("aaa");
    expect(matchOrder(buy("b1", "ada", 100, 5), [...book].reverse()).fills[0]!.sellOrderId).toBe(
      "aaa",
    );
  });

  it("sweeps several levels with a big order", () => {
    const book = [
      sell("s1", "bob", 100, 5),
      sell("s2", "cat", 110, 5),
      sell("s3", "dan", 120, 5),
    ];
    const result = matchOrder(buy("b1", "ada", 115, 20), book);
    expect(result.fills.map((fill) => fill.unitPrice)).toEqual([100, 110]);
    expect(remaining(result.order)).toBe(10); // the rest rests at 115
    expect(result.order.state).toBe(OrderState.PartiallyFilled);
    expect(result.book.map((o) => o.orderId)).toEqual(["b1", "s3"]);
  });

  it("leaves the remainder on the book after a partial fill", () => {
    const result = matchOrder(buy("b1", "ada", 100, 10), [sell("s1", "bob", 100, 4)]);
    expect(result.order.filled).toBe(4);
    expect(remaining(result.order)).toBe(6);
    expect(result.touched[0]!.state).toBe(OrderState.Filled);
  });

  it("will not let a member trade with themselves", () => {
    // Wash trading: two orders, one owner, a price of the owner's choosing.
    // Left alone it is how a member manufactures a trade history.
    expect(matchOrder(buy("b1", "ada", 100, 10), [sell("s1", "ada", 100, 10)]).fills).toEqual([]);
  });

  it("ignores orders in another instrument", () => {
    const book = [sell("s1", "bob", 10, 10, NOW, "wood")];
    expect(matchOrder(buy("b1", "ada", 100, 10), book).fills).toEqual([]);
  });

  it("will not match a filled order again", () => {
    const result = matchOrder(buy("b1", "ada", 100, 10), [sell("s1", "bob", 100, 10)]);
    expect(() => matchOrder(result.order, [])).toThrow(OrderError);
  });

  it("returns the book in matching order", () => {
    const book = [buy("b2", "bob", 90, 5), buy("b1", "cat", 110, 5)];
    const result = matchOrder(sell("s1", "ada", 200, 1), book);
    expect(result.book.map((o) => o.orderId)).toEqual(["b1", "b2", "s1"]);
  });

  it("never mutates the book it was given", () => {
    const book = [sell("s1", "bob", 100, 10)];
    const snapshot = structuredClone(book);
    matchOrder(buy("b1", "ada", 100, 10), book);
    expect(book).toEqual(snapshot);
    expect(book[0]!.filled).toBe(0);
  });

  it("totals what a match filled", () => {
    const result = matchOrder(buy("b1", "ada", 100, 10), [sell("s1", "bob", 100, 4)]);
    expect(filledQuantity(result)).toBe(4);
    expect(totalConsideration(result)).toBe(400);
  });
});

describe("reading the book", () => {
  const book = [
    buy("b1", "ada", 90, 5),
    buy("b2", "bob", 95, 3),
    sell("s1", "cat", 105, 4),
    sell("s2", "dan", 110, 6),
  ];

  it("finds the highest bid and the lowest ask", () => {
    expect(bestBid(book, "ore")!.orderId).toBe("b2");
    expect(bestAsk(book, "ore")!.orderId).toBe("s1");
  });

  it("measures the spread between them", () => {
    expect(spread(book, "ore")).toBe(10);
  });

  it("has no spread on a one-sided book", () => {
    expect(spread([buy("b1", "ada", 90, 5)], "ore")).toBeNull();
    expect(spread([], "ore")).toBeNull();
  });

  it("counts the units still available", () => {
    expect(bookDepth(book, "ore", OrderSide.Buy)).toBe(8);
    expect(bookDepth(book, "ore", OrderSide.Sell)).toBe(10);
    expect(bookDepth(book, "wood", OrderSide.Buy)).toBe(0);
  });

  it("counts what is left rather than what was asked", () => {
    const result = matchOrder(buy("b1", "ada", 100, 4), [sell("s1", "bob", 100, 10)]);
    expect(bookDepth(result.book, "ore", OrderSide.Sell)).toBe(6);
  });

  it("takes a cancelled order off the book", () => {
    const { cancelled, book: rest } = cancelOrder(book, "b1");
    expect(cancelled.state).toBe(OrderState.Cancelled);
    expect(isActive(cancelled)).toBe(false);
    expect(rest.map((o) => o.orderId)).toEqual(["b2", "s1", "s2"]);
  });

  it("refuses to cancel something that is not there", () => {
    expect(() => cancelOrder(book, "nope")).toThrow(OrderError);
  });
});

describe("settling a fill", () => {
  it("moves the currency from buyer to seller", () => {
    const fill = matchOrder(buy("b1", "ada", 100, 10), [sell("s1", "bob", 100, 10)]).fills[0]!;
    const booking = settleFill(engine(), fill, account(ref("ada"), 5_000), account(ref("bob"), 0), {
      now: NOW,
      operationId: "f1",
      reason: "fill",
    });
    expect(booking.posting.kind).toBe(PostingKind.Settlement);
    expect(booking.balances[accountKey(ref("ada"))]).toBe(4_000);
    expect(booking.balances[accountKey(ref("bob"))]).toBe(1_000);
  });

  it("refuses a buyer without the money", () => {
    // Which is why a serious caller places a hold when the order is placed.
    const fill = matchOrder(buy("b1", "ada", 100, 10), [sell("s1", "bob", 100, 10)]).fills[0]!;
    expect(() =>
      settleFill(engine(), fill, account(ref("ada"), 10), account(ref("bob"), 0), {
        now: NOW,
        operationId: "f1",
        reason: "fill",
      }),
    ).toThrow(InsufficientFundsError);
  });

  it("needs the accounts named in the fill", () => {
    const fill = matchOrder(buy("b1", "ada", 100, 10), [sell("s1", "bob", 100, 10)]).fills[0]!;
    expect(() =>
      settleFill(engine(), fill, account(ref("eve"), 5_000), account(ref("bob"), 0), {
        now: NOW,
        operationId: "f1",
        reason: "fill",
      }),
    ).toThrow(OrderError);
  });
});

describe("exchange", () => {
  it("makes two postings for two currencies", () => {
    // A posting balances within one currency, so a swap is two of them.
    const { sold, bought, received } = exchange(
      engine(),
      account(ref("ada", "COIN"), 1_000),
      account(ref("ada", "GEM"), 0),
      400,
      1,
      4,
      { now: NOW, operationId: "x1", reason: "swap" },
    );
    expect(received).toBe(100);
    expect(sold.balances[accountKey(ref("ada", "COIN"))]).toBe(600);
    expect(sold.balances[accountKey(systemAccount("g1", "COIN", SystemAccount.Sink))]).toBe(400);
    expect(bought.balances[accountKey(ref("ada", "GEM"))]).toBe(100);
    expect(bought.balances[accountKey(systemAccount("g1", "GEM", SystemAccount.Mint))]).toBe(-100);
  });

  it("will not sell currency the member does not hold", () => {
    expect(() =>
      exchange(
        engine(),
        account(ref("ada", "COIN"), 10),
        account(ref("ada", "GEM"), 0),
        400,
        1,
        4,
        { now: NOW, operationId: "x1", reason: "swap" },
      ),
    ).toThrow(InsufficientFundsError);
  });

  it("makes a named reserve hold what it pays out", () => {
    // The mint issues. A reserve pool is an ordinary account and does not.
    expect(() =>
      exchange(
        engine(),
        account(ref("ada", "COIN"), 1_000),
        account(ref("ada", "GEM"), 0),
        400,
        1,
        4,
        {
          now: NOW,
          operationId: "x1",
          reason: "swap",
          source: account(memberAccount("g1", "reserve", "GEM"), 10),
        },
      ),
    ).toThrow(InsufficientFundsError);
  });

  it("rounds the way the caller asks", () => {
    const swap = (rounding: Rounding) =>
      exchange(
        engine(),
        account(ref("ada", "COIN"), 1_000),
        account(ref("ada", "GEM"), 0),
        10,
        1,
        3,
        { now: NOW, operationId: "x1", reason: "swap", rounding },
      ).received;
    expect(swap(Rounding.Down)).toBe(3);
    expect(swap(Rounding.Up)).toBe(4);
  });

  it("refuses a rate that buys nothing", () => {
    // Taking currency and giving none back is not an exchange.
    expect(() =>
      exchange(engine(), account(ref("ada", "COIN"), 1_000), account(ref("ada", "GEM"), 0), 1, 1, 1_000, {
        now: NOW,
        operationId: "x1",
        reason: "swap",
      }),
    ).toThrow(OrderError);
  });

  it("is one member swapping their own currency", () => {
    expect(() =>
      exchange(engine(), account(ref("ada", "COIN"), 1_000), account(ref("bob", "GEM"), 0), 100, 1, 1, {
        now: NOW,
        operationId: "x1",
        reason: "swap",
      }),
    ).toThrow(ValidationError);
  });

  it("refuses to swap a currency for itself", () => {
    expect(() =>
      exchange(engine(), account(ref("ada", "COIN"), 1_000), account(ref("ada", "COIN"), 0), 100, 1, 1, {
        now: NOW,
        operationId: "x1",
        reason: "swap",
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it("gives the two postings different operation ids", () => {
    // They are two rows, and the id is unique. Sharing one would make the
    // second insert fail for a caller doing exactly what the docs ask.
    const { sold, bought } = exchange(
      engine(),
      account(ref("ada", "COIN"), 1_000),
      account(ref("ada", "GEM"), 0),
      100,
      1,
      1,
      { now: NOW, operationId: "x1", reason: "swap" },
    );
    expect(sold.posting.operationId).not.toBe(bought.posting.operationId);
  });
});

function auction(overrides: Partial<Parameters<typeof openAuction>[0]> = {}): Auction {
  return openAuction({
    auctionId: "a1",
    seller: ref("seller"),
    subject: "sword",
    currency: "COIN",
    reserve: 1_000,
    openedAt: NOW,
    endsAt: LATER,
    ...overrides,
  });
}

function bid(bidder: string, amount: number, at = NOW, bidId?: string): Bid {
  return { bidder: ref(bidder), amount, placedAt: at, bidId: bidId ?? `${bidder}-${amount}` };
}

describe("auctions", () => {
  it("opens with no bids", () => {
    const opened = auction();
    expect(opened.state).toBe(AuctionState.Open);
    expect(highestBid(opened)).toBeNull();
  });

  it("refuses an auction that ends before it opens", () => {
    expect(() => auction({ endsAt: NOW - 1 })).toThrow(AuctionStateError);
  });

  it("refuses an empty id or subject and a negative reserve", () => {
    expect(() => auction({ auctionId: "" })).toThrow(AuctionStateError);
    expect(() => auction({ subject: "" })).toThrow(AuctionStateError);
    expect(() => auction({ reserve: -1 })).toThrow(AuctionStateError);
  });

  it("makes each bid beat the last by the increment", () => {
    let running = placeBid(auction({ minIncrement: 100 }), bid("ada", 1_000), NOW);
    expect(() => placeBid(running, bid("bob", 1_050), NOW)).toThrow(AuctionStateError);
    running = placeBid(running, bid("bob", 1_100), NOW);
    expect(highestBid(running)!.bidder.owner).toBe("bob");
  });

  it("will not let a seller bid on their own lot", () => {
    expect(() => placeBid(auction(), bid("seller", 2_000), NOW)).toThrow(AuctionStateError);
  });

  it("refuses a bid in the wrong currency", () => {
    const wrong: Bid = { bidder: ref("ada", "GEM"), amount: 2_000, placedAt: NOW, bidId: "x" };
    expect(() => placeBid(auction(), wrong, NOW)).toThrow(CurrencyMismatchError);
  });

  it("refuses a repeated bid id", () => {
    const running = placeBid(auction(), bid("ada", 1_000, NOW, "same"), NOW);
    expect(() => placeBid(running, bid("bob", 2_000, NOW, "same"), NOW)).toThrow(
      AuctionStateError,
    );
  });

  it("stops bidding when the auction does", () => {
    expect(() => placeBid(auction(), bid("ada", 2_000), LATER)).toThrow(AuctionStateError);
  });

  it("refuses a low bid at once when the reserve is open", () => {
    expect(() => placeBid(auction({ reserve: 1_000 }), bid("ada", 999), NOW)).toThrow(
      AuctionStateError,
    );
  });

  it("takes a low bid and loses it at the close when the reserve is hidden", () => {
    // Both are real behaviours and the difference matters to a bidder. Hidden,
    // the bid is accepted and simply does not win -- which is how an auction
    // house runs one, and why it has to be opted into.
    const running = placeBid(
      auction({ reserve: 1_000, reserveHidden: true }),
      bid("ada", 400),
      NOW,
    );
    expect(highestBid(running)!.amount).toBe(400);
    const outcome = closeAuction(running, LATER);
    expect(outcome.auction.state).toBe(AuctionState.Unsold);
    expect(outcome.winner).toBeNull();
    expect(outcome.price).toBe(0);
  });

  it("lets the highest bid win at what it bid", () => {
    let running = placeBid(auction(), bid("ada", 1_000), NOW);
    running = placeBid(running, bid("bob", 1_500), NOW + 1);
    const outcome = closeAuction(running, LATER);
    expect(outcome.auction.state).toBe(AuctionState.Won);
    expect(outcome.winner!.bidder.owner).toBe("bob");
    expect(outcome.price).toBe(1_500);
  });

  it("gives the earlier of two equal bids the win", () => {
    // They cannot arrive equal through placeBid, but a caller replaying a stored
    // auction can hold two, and the winner must not be arbitrary.
    const stored: Auction = {
      ...auction(),
      bids: [bid("ada", 2_000, NOW + 5), bid("bob", 2_000, NOW + 1)],
    };
    expect(closeAuction(stored, LATER).winner!.bidder.owner).toBe("bob");
  });

  it("goes unsold with no bids", () => {
    const outcome = closeAuction(auction(), LATER);
    expect(outcome.auction.state).toBe(AuctionState.Unsold);
    expect(outcome.price).toBe(0);
  });

  it("closes once", () => {
    const outcome = closeAuction(auction(), LATER);
    expect(() => closeAuction(outcome.auction, LATER)).toThrow(AuctionStateError);
  });

  it("allows closing early", () => {
    // A seller withdrawing the lot, or a "buy it now".
    expect(closeAuction(placeBid(auction(), bid("ada", 5_000), NOW), NOW + 1).price).toBe(5_000);
  });

  it("pays the seller when settled", () => {
    const outcome = closeAuction(placeBid(auction(), bid("ada", 2_000), NOW), LATER);
    const { booking, auction: settled } = settleAuction(
      engine(),
      outcome,
      account(ref("ada"), 5_000),
      account(ref("seller"), 0),
      { now: LATER, operationId: "s1", reason: "auction" },
    );
    expect(settled.state).toBe(AuctionState.Settled);
    expect(booking.balances[accountKey(ref("seller"))]).toBe(2_000);
    expect(booking.balances[accountKey(ref("ada"))]).toBe(3_000);
  });

  it("will not settle an unsold lot", () => {
    expect(() =>
      settleAuction(
        engine(),
        closeAuction(auction(), LATER),
        account(ref("ada"), 5_000),
        account(ref("seller"), 0),
        { now: LATER, operationId: "s1", reason: "auction" },
      ),
    ).toThrow(AuctionStateError);
  });

  it("will not settle for a winner who cannot pay", () => {
    const outcome = closeAuction(placeBid(auction(), bid("ada", 2_000), NOW), LATER);
    expect(() =>
      settleAuction(engine(), outcome, account(ref("ada"), 10), account(ref("seller"), 0), {
        now: LATER,
        operationId: "s1",
        reason: "auction",
      }),
    ).toThrow(InsufficientFundsError);
  });

  it("needs the winner and the seller", () => {
    const outcome = closeAuction(placeBid(auction(), bid("ada", 2_000), NOW), LATER);
    expect(() =>
      settleAuction(engine(), outcome, account(ref("eve"), 5_000), account(ref("seller"), 0), {
        now: LATER,
        operationId: "s1",
        reason: "auction",
      }),
    ).toThrow(AuctionStateError);
    expect(() =>
      settleAuction(engine(), outcome, account(ref("ada"), 5_000), account(ref("eve"), 0), {
        now: LATER,
        operationId: "s1",
        reason: "auction",
      }),
    ).toThrow(AuctionStateError);
  });

  it("needs a positive increment", () => {
    expect(() => auction({ minIncrement: 0 })).toThrow(InvalidAmountError);
  });
});
