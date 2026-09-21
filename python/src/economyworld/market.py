"""Markets: an order book, currency exchange, and auctions.

Three ways for members to trade with each other at a price neither of them sets
alone. All of them are deterministic: given the same orders in the same order,
every edition and every run produces the same fills.

# Matching is by price, then time, then id

Price priority first: the buyer willing to pay most trades first, and so does
the seller willing to accept least. Then time: of two equal prices the older
order trades first. Then the order id, alphabetically.

**The last tie-break is not decoration.** Two orders placed in the same
millisecond are common in a bot that handles a burst of commands, and without a
final rule the winner would depend on the order a dictionary happened to iterate
in -- which is exactly how two editions come to disagree about who got the
trade. The id is the caller's, stable, and stored, so the answer is the same
everywhere and can be explained to whoever lost.

# A trade happens at the resting order's price

The order already on the book set its price first; the one that arrives and
crosses it accepts. A buyer bidding 12 who meets a resting ask of 10 pays 10 and
keeps the difference, which is the convention every exchange uses and the one
that makes placing an order early worth something.

# Nothing here moves a price

The book has no market maker, no spread model, no drift. Prices are what members
offer. See :mod:`economyworld.instruments` for why that boundary is where it is.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from enum import Enum

from .accounts import (
    Account,
    AccountRef,
    SystemAccount,
    account_key,
    empty_account,
    system_account,
)
from .engine import EconomyEngine
from .errors import (
    AuctionStateError,
    CurrencyMismatchError,
    OrderError,
    ValidationError,
)
from .ledger import PostingKind
from .money import apply_rate, assert_positive_amount, assert_whole_amount
from .rounding import Rounding
from .types import BookingResult

__all__ = [
    "OrderSide",
    "OrderState",
    "Order",
    "Fill",
    "MatchResult",
    "AuctionState",
    "Bid",
    "Auction",
    "AuctionOutcome",
    "create_order",
    "match_order",
    "cancel_order",
    "best_bid",
    "best_ask",
    "spread",
    "book_depth",
    "exchange",
    "open_auction",
    "place_bid",
    "close_auction",
    "settle_auction",
]


class OrderSide(str, Enum):
    """Which way round a member wants to trade."""

    BUY = "BUY"
    SELL = "SELL"


class OrderState(str, Enum):
    """Where an order is in its life."""

    OPEN = "OPEN"
    PARTIALLY_FILLED = "PARTIALLY_FILLED"
    FILLED = "FILLED"
    CANCELLED = "CANCELLED"


@dataclass(frozen=True)
class Order:
    """A limit order sitting on, or arriving at, a book."""

    order_id: str
    owner: AccountRef
    instrument_id: str
    side: OrderSide
    #: What one unit is offered or asked for. A limit, not a promise: a buy
    #: fills at this price *or better*.
    unit_price: int
    quantity: int
    filled: int
    placed_at: int
    state: OrderState = OrderState.OPEN

    @property
    def remaining(self) -> int:
        return self.quantity - self.filled

    @property
    def is_active(self) -> bool:
        return self.state in (OrderState.OPEN, OrderState.PARTIALLY_FILLED)


@dataclass(frozen=True)
class Fill:
    """One trade between two orders."""

    buy_order_id: str
    sell_order_id: str
    buyer: AccountRef
    seller: AccountRef
    instrument_id: str
    quantity: int
    #: The resting order's price. See this module's opening note.
    unit_price: int
    consideration: int


@dataclass(frozen=True)
class MatchResult:
    """What placing an order did to the book."""

    #: The incoming order, with whatever it filled.
    order: Order
    #: The resting orders it traded against, updated. Store these.
    touched: tuple[Order, ...]
    fills: tuple[Fill, ...]
    #: The book after the match: active orders only, in matching order.
    book: tuple[Order, ...]

    @property
    def filled_quantity(self) -> int:
        return sum(fill.quantity for fill in self.fills)

    @property
    def total_consideration(self) -> int:
        return sum(fill.consideration for fill in self.fills)


def create_order(
    order_id: str,
    owner: AccountRef,
    instrument_id: str,
    side: OrderSide,
    unit_price: int,
    quantity: int,
    placed_at: int,
) -> Order:
    """Build a validated order."""
    if not isinstance(order_id, str) or not order_id:
        raise OrderError("An order needs a non-empty id", order_id=order_id)
    if not isinstance(instrument_id, str) or not instrument_id:
        raise OrderError("An order needs an instrument", instrument_id=instrument_id)
    assert_positive_amount(quantity)
    assert_positive_amount(unit_price)
    _assert_timestamp(placed_at)
    return Order(
        order_id=order_id,
        owner=owner,
        instrument_id=instrument_id,
        side=side,
        unit_price=unit_price,
        quantity=quantity,
        filled=0,
        placed_at=placed_at,
        state=OrderState.OPEN,
    )


def _priority(order: Order) -> tuple[int, int, str]:
    """Sort key for the side of the book an order rests on.

    Best price first. For buys the best price is the highest, so it is negated;
    for sells the lowest is best and it is not. Then oldest first, then id --
    the tie-break that keeps two orders placed in the same millisecond from
    depending on iteration order.
    """
    price = -order.unit_price if order.side is OrderSide.BUY else order.unit_price
    return (price, order.placed_at, order.order_id)


def match_order(incoming: Order, book: Sequence[Order]) -> MatchResult:
    """Match an arriving order against a book. Books nothing.

    Pure: takes the book, returns the new book. Nothing is stored and no posting
    is made, because a fill is only a fill once the caller has written it --
    and the caller may want to check funds or holds first. Turn the fills into
    postings with :func:`settle_fill`.

    An order that does not fill completely stays on the book for the remainder,
    which is what a limit order is for.
    """
    if not incoming.is_active:
        raise OrderError(
            "That order is not active", order_id=incoming.order_id, state=incoming.state.value
        )

    opposite = OrderSide.SELL if incoming.side is OrderSide.BUY else OrderSide.BUY
    candidates = sorted(
        (
            order
            for order in book
            if order.is_active
            and order.side is opposite
            and order.instrument_id == incoming.instrument_id
            and order.owner != incoming.owner
        ),
        key=_priority,
    )

    fills: list[Fill] = []
    touched: dict[str, Order] = {}
    working = incoming

    for resting in candidates:
        if working.remaining == 0:
            break
        if not _crosses(working, resting):
            # The book is sorted best-first, so once one does not cross, none
            # of the rest will either.
            break

        quantity = min(working.remaining, resting.remaining)
        # The resting order's price: it was there first, and it named the terms.
        price = resting.unit_price
        consideration = quantity * price
        assert_whole_amount(consideration)

        buy_id, sell_id = (
            (working.order_id, resting.order_id)
            if working.side is OrderSide.BUY
            else (resting.order_id, working.order_id)
        )
        buyer, seller = (
            (working.owner, resting.owner)
            if working.side is OrderSide.BUY
            else (resting.owner, working.owner)
        )
        fills.append(
            Fill(
                buy_order_id=buy_id,
                sell_order_id=sell_id,
                buyer=buyer,
                seller=seller,
                instrument_id=working.instrument_id,
                quantity=quantity,
                unit_price=price,
                consideration=consideration,
            )
        )

        working = _apply_fill(working, quantity)
        touched[resting.order_id] = _apply_fill(resting, quantity)

    new_book = [
        touched.get(order.order_id, order)
        for order in book
        if touched.get(order.order_id, order).is_active
    ]
    if working.is_active and working.remaining > 0:
        new_book.append(working)

    return MatchResult(
        order=working,
        touched=tuple(touched.values()),
        fills=tuple(fills),
        book=tuple(sorted(new_book, key=_priority)),
    )


def _crosses(incoming: Order, resting: Order) -> bool:
    """Whether these two orders are willing to trade with each other."""
    if incoming.side is OrderSide.BUY:
        return incoming.unit_price >= resting.unit_price
    return incoming.unit_price <= resting.unit_price


def _apply_fill(order: Order, quantity: int) -> Order:
    filled = order.filled + quantity
    state = OrderState.FILLED if filled >= order.quantity else OrderState.PARTIALLY_FILLED
    return replace(order, filled=filled, state=state)


def cancel_order(book: Sequence[Order], order_id: str) -> tuple[Order, list[Order]]:
    """Take an order off the book. Returns the cancelled order and the rest.

    A partly filled order can be cancelled; the part already traded stays
    traded. Cancelling one that is already filled or cancelled is refused rather
    than ignored, because a bot that thinks it cancelled something it did not
    will show a member the wrong thing.
    """
    for order in book:
        if order.order_id == order_id:
            if not order.is_active:
                raise OrderError(
                    "That order is no longer active",
                    order_id=order_id,
                    state=order.state.value,
                )
            cancelled = replace(order, state=OrderState.CANCELLED)
            return cancelled, [o for o in book if o.order_id != order_id]
    raise OrderError("No such order on the book", order_id=order_id)


def best_bid(book: Sequence[Order], instrument_id: str) -> Order | None:
    """The highest active buy order, or ``None``."""
    return _best(book, instrument_id, OrderSide.BUY)


def best_ask(book: Sequence[Order], instrument_id: str) -> Order | None:
    """The lowest active sell order, or ``None``."""
    return _best(book, instrument_id, OrderSide.SELL)


def _best(book: Sequence[Order], instrument_id: str, side: OrderSide) -> Order | None:
    candidates = [
        o for o in book if o.is_active and o.side is side and o.instrument_id == instrument_id
    ]
    return min(candidates, key=_priority) if candidates else None


def spread(book: Sequence[Order], instrument_id: str) -> int | None:
    """Ask minus bid, or ``None`` when one side is empty.

    ``None`` rather than zero: an empty side is not a tight market, and a bot
    that showed "spread: 0" for a book with no sellers would be lying.
    """
    bid = best_bid(book, instrument_id)
    ask = best_ask(book, instrument_id)
    if bid is None or ask is None:
        return None
    return ask.unit_price - bid.unit_price


def book_depth(book: Sequence[Order], instrument_id: str, side: OrderSide) -> int:
    """How many units are on one side of the book."""
    return sum(
        o.remaining
        for o in book
        if o.is_active and o.side is side and o.instrument_id == instrument_id
    )


def settle_fill(
    engine: EconomyEngine,
    fill: Fill,
    buyer: Account,
    seller: Account,
    now: int,
    operation_id: str,
    reason: str,
    metadata: Mapping[str, str] | None = None,
) -> BookingResult:
    """Move the currency for one fill.

    The units themselves are the caller's to move -- they live in an inventory
    or a position, and this module does not know which. Both belong in one
    database transaction, as always.
    """
    _assert_timestamp(now)
    if buyer.ref != fill.buyer:
        raise OrderError(
            "That account is not the buyer",
            expected=account_key(fill.buyer),
            given=account_key(buyer.ref),
        )
    if seller.ref != fill.seller:
        raise OrderError(
            "That account is not the seller",
            expected=account_key(fill.seller),
            given=account_key(seller.ref),
        )
    return engine.transfer(
        source=buyer,
        target=seller,
        amount=fill.consideration,
        now=now,
        operation_id=operation_id,
        reason=reason,
        kind=PostingKind.SETTLEMENT,
        metadata=metadata,
    )


def exchange(
    engine: EconomyEngine,
    seller: Account,
    buyer_side: Account,
    amount: int,
    rate_numerator: int,
    rate_denominator: int,
    now: int,
    operation_id: str,
    reason: str,
    sink: Account | None = None,
    source: Account | None = None,
    rounding: Rounding = Rounding.DOWN,
    metadata: Mapping[str, str] | None = None,
) -> tuple[BookingResult, BookingResult, int]:
    """Swap one currency for another at a rate the caller supplies.

    Two currencies means **two postings**, because a posting balances within one
    currency and always will: 100 GOLD leaving one account and 250 SILVER
    arriving in another do not sum to zero and never should. The first posting
    retires the currency sold into its sink; the second issues the currency
    bought from its mint. The money supply of each currency moves, and both
    movements are on the books.

    ``rate_numerator / rate_denominator`` is how much of the bought currency one
    unit of the sold currency is worth. The rate is an argument: this package
    does not know what a GOLD is worth in SILVER, and inventing an answer is how
    a library starts having opinions about a market.

    Returns both postings and the amount received. Write all of it in one
    transaction -- half an exchange is a member who paid and got nothing.
    """
    assert_positive_amount(amount)
    _assert_timestamp(now)
    if seller.ref.owner != buyer_side.ref.owner:
        raise ValidationError(
            "An exchange is one member swapping their own currency",
            selling=account_key(seller.ref),
            buying=account_key(buyer_side.ref),
        )
    if seller.ref.currency == buyer_side.ref.currency:
        raise CurrencyMismatchError(
            expected="two different currencies", received=seller.ref.currency
        )
    if seller.ref.scope != buyer_side.ref.scope:
        raise ValidationError(
            "An exchange cannot cross scopes",
            selling=seller.ref.scope,
            buying=buyer_side.ref.scope,
        )

    received = apply_rate(amount, rate_numerator, rate_denominator, rounding)
    if received <= 0:
        raise OrderError(
            "That rate and amount buy nothing: the exchange would take currency "
            "and give none back",
            amount=amount,
            rate_numerator=rate_numerator,
            rate_denominator=rate_denominator,
        )

    sold = engine.transfer(
        source=seller,
        target=sink
        or empty_account(
            system_account(seller.ref.scope, seller.ref.currency, SystemAccount.SINK)
        ),
        amount=amount,
        now=now,
        operation_id=f"{operation_id}:sell",
        reason=reason,
        kind=PostingKind.EXCHANGE,
        # The source is the member. An exchange spends currency they hold.
        allow_negative=False,
        metadata=metadata,
    )
    bought = engine.transfer(
        source=source
        or empty_account(
            system_account(buyer_side.ref.scope, buyer_side.ref.currency, SystemAccount.MINT)
        ),
        target=buyer_side,
        amount=received,
        now=now,
        operation_id=f"{operation_id}:buy",
        reason=reason,
        kind=PostingKind.EXCHANGE,
        # The mint issues; a named reserve pays out of its own balance.
        allow_negative=source is None,
        metadata=metadata,
    )
    return sold, bought, received


# ---------------------------------------------------------------------------
# Auctions
# ---------------------------------------------------------------------------


class AuctionState(str, Enum):
    """Where an auction is in its life."""

    OPEN = "OPEN"
    #: Closed with a winner, waiting to be settled.
    WON = "WON"
    #: Closed with no bid that met the reserve.
    UNSOLD = "UNSOLD"
    #: Closed and paid for.
    SETTLED = "SETTLED"
    CANCELLED = "CANCELLED"


@dataclass(frozen=True)
class Bid:
    """One bid in an auction."""

    bidder: AccountRef
    amount: int
    placed_at: int
    #: The caller's own id for the bid. The final tie-break when two bids of
    #: the same size arrive in the same millisecond.
    bid_id: str


@dataclass(frozen=True)
class Auction:
    """An item offered to the highest bidder."""

    auction_id: str
    seller: AccountRef
    #: What is being sold. An item id, an instrument id -- this module does not
    #: care, and hands it back untouched.
    subject: str
    currency: str
    #: The least that will be accepted. A bid below it does not win.
    reserve: int
    #: Whether the reserve is kept from bidders.
    #:
    #: **Open** (the default): a bid below the reserve is refused as it is
    #: placed, with the reserve in the error. Kinder, and the right choice when
    #: the reserve is on the listing anyway.
    #:
    #: **Hidden**: bids below the reserve are accepted and simply do not win.
    #: The auction closes ``UNSOLD``, and the bidders never learn what the
    #: reserve was. This is how a real auction house runs one, and it is worth
    #: having -- but it means somebody can bid in good faith and lose to a
    #: number they could not see, so it is opt-in.
    reserve_hidden: bool
    #: The least a new bid must beat the standing one by.
    min_increment: int
    opened_at: int
    #: When bidding closes. Bids at or after this moment are refused.
    ends_at: int
    bids: tuple[Bid, ...] = ()
    state: AuctionState = AuctionState.OPEN

    @property
    def highest(self) -> Bid | None:
        """The bid that would win if the auction closed now."""
        if not self.bids:
            return None
        # Highest amount, then earliest, then id: the same three-part rule the
        # order book uses, for the same reason.
        return min(self.bids, key=lambda b: (-b.amount, b.placed_at, b.bid_id))


@dataclass(frozen=True)
class AuctionOutcome:
    """What closing an auction decided."""

    auction: Auction
    winner: Bid | None
    #: What the winner pays. The bid itself -- this is a first-price auction,
    #: because a second-price rule surprises people who have not read about it.
    price: int


def open_auction(
    auction_id: str,
    seller: AccountRef,
    subject: str,
    currency: str,
    reserve: int,
    opened_at: int,
    ends_at: int,
    min_increment: int = 1,
    reserve_hidden: bool = False,
) -> Auction:
    """Start an auction.

    With an open reserve a bid below it is refused when it is placed. With a
    hidden one it is accepted and loses at the close -- see
    :attr:`Auction.reserve_hidden`.
    """
    if not isinstance(auction_id, str) or not auction_id:
        raise AuctionStateError("An auction needs a non-empty id", auction_id=auction_id)
    if not isinstance(subject, str) or not subject:
        raise AuctionStateError("An auction needs a subject", subject=subject)
    assert_whole_amount(reserve)
    if reserve < 0:
        raise AuctionStateError("A reserve cannot be negative", reserve=reserve)
    assert_positive_amount(min_increment)
    _assert_timestamp(opened_at)
    _assert_timestamp(ends_at)
    if ends_at <= opened_at:
        raise AuctionStateError(
            "An auction cannot close before it opens", opened_at=opened_at, ends_at=ends_at
        )
    return Auction(
        auction_id=auction_id,
        seller=seller,
        subject=subject,
        currency=currency,
        reserve=reserve,
        reserve_hidden=reserve_hidden,
        min_increment=min_increment,
        opened_at=opened_at,
        ends_at=ends_at,
    )


def place_bid(auction: Auction, bid: Bid, now: int) -> Auction:
    """Add a bid. Nothing is booked; hold the funds instead.

    A bid is a promise, not a payment -- so nothing moves until the auction
    settles. What should move is a **hold**: see
    :func:`~economyworld.bank.place_hold`, which stops a member bidding the same
    balance in three auctions at once.
    """
    _assert_timestamp(now)
    if auction.state is not AuctionState.OPEN:
        raise AuctionStateError(
            "That auction is not open",
            auction_id=auction.auction_id,
            state=auction.state.value,
        )
    if now >= auction.ends_at:
        raise AuctionStateError(
            "Bidding has closed", auction_id=auction.auction_id, ends_at=auction.ends_at
        )
    assert_positive_amount(bid.amount)
    if bid.bidder == auction.seller:
        raise AuctionStateError(
            "A seller cannot bid on their own auction", auction_id=auction.auction_id
        )
    if bid.bidder.currency != auction.currency:
        raise CurrencyMismatchError(expected=auction.currency, received=bid.bidder.currency)
    if any(existing.bid_id == bid.bid_id for existing in auction.bids):
        raise AuctionStateError("That bid id is already in use", bid_id=bid.bid_id)

    standing = auction.highest
    if standing is None:
        # With a hidden reserve the first bid may be anything: refusing it would
        # tell the bidder what the reserve was, which is the one thing hiding it
        # is supposed to prevent.
        floor = 1 if auction.reserve_hidden else auction.reserve
    else:
        floor = standing.amount + auction.min_increment
    if bid.amount < floor:
        raise AuctionStateError(
            "That bid is too low",
            auction_id=auction.auction_id,
            offered=bid.amount,
            minimum=floor,
        )

    return replace(auction, bids=(*auction.bids, bid))


def close_auction(auction: Auction, now: int) -> AuctionOutcome:
    """Decide who won. Books nothing.

    Closing early is allowed -- a seller may withdraw the lot before time -- but
    closing before ``ends_at`` still uses the bids that are in, which is what a
    "buy it now" or a cancelled listing needs.
    """
    _assert_timestamp(now)
    if auction.state is not AuctionState.OPEN:
        raise AuctionStateError(
            "That auction is already closed",
            auction_id=auction.auction_id,
            state=auction.state.value,
        )

    winner = auction.highest
    # The reserve is checked here as well as when a bid is placed, because a
    # hidden reserve is only checked here: that is what hiding it means.
    if winner is None or winner.amount < auction.reserve:
        return AuctionOutcome(
            auction=replace(auction, state=AuctionState.UNSOLD), winner=None, price=0
        )
    return AuctionOutcome(
        auction=replace(auction, state=AuctionState.WON),
        winner=winner,
        price=winner.amount,
    )


def settle_auction(
    engine: EconomyEngine,
    outcome: AuctionOutcome,
    winner_account: Account,
    seller_account: Account,
    now: int,
    operation_id: str,
    reason: str,
    metadata: Mapping[str, str] | None = None,
) -> tuple[BookingResult, Auction]:
    """Move the winner's currency to the seller.

    Handing the item over is the caller's -- it lives in an inventory or a
    position, and both belong in the same transaction as this posting.
    """
    _assert_timestamp(now)
    if outcome.auction.state is not AuctionState.WON or outcome.winner is None:
        raise AuctionStateError(
            "That auction has no winner to settle",
            auction_id=outcome.auction.auction_id,
            state=outcome.auction.state.value,
        )
    if winner_account.ref != outcome.winner.bidder:
        raise AuctionStateError(
            "That account did not win",
            expected=account_key(outcome.winner.bidder),
            given=account_key(winner_account.ref),
        )
    if seller_account.ref != outcome.auction.seller:
        raise AuctionStateError(
            "That account is not the seller",
            expected=account_key(outcome.auction.seller),
            given=account_key(seller_account.ref),
        )

    booking = engine.transfer(
        source=winner_account,
        target=seller_account,
        amount=outcome.price,
        now=now,
        operation_id=operation_id,
        reason=reason,
        kind=PostingKind.SETTLEMENT,
        metadata=metadata,
    )
    return booking, replace(outcome.auction, state=AuctionState.SETTLED)


def _assert_timestamp(now: int) -> None:
    if not isinstance(now, int) or isinstance(now, bool):
        raise ValidationError("Timestamps are epoch milliseconds as integers", timestamp=now)
