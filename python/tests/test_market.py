"""Order books, currency exchange and auctions."""

from __future__ import annotations

import pytest

from economyworld import (
    AuctionState,
    AuctionStateError,
    CurrencyMismatchError,
    EconomyEngine,
    InsufficientFundsError,
    InvalidAmountError,
    OrderError,
    OrderSide,
    OrderState,
    PostingKind,
    Rounding,
    SystemAccount,
    ValidationError,
    account_key,
    best_ask,
    best_bid,
    book_depth,
    cancel_order,
    close_auction,
    create_currency,
    create_order,
    exchange,
    make_account,
    match_order,
    member_account,
    open_auction,
    place_bid,
    settle_auction,
    settle_fill,
    spread,
    system_account,
)
from economyworld.market import Bid

NOW = 1_700_000_000_000
LATER = NOW + 60_000


@pytest.fixture
def engine() -> EconomyEngine:
    return EconomyEngine(currencies=[create_currency("COIN"), create_currency("GEM")])


def ref(name: str, currency: str = "COIN"):
    return member_account("g1", name, currency)


def order(
    order_id: str,
    owner: str,
    side: OrderSide,
    price: int,
    quantity: int,
    placed_at: int = NOW,
    instrument: str = "ore",
):
    return create_order(order_id, ref(owner), instrument, side, price, quantity, placed_at)


def buy(order_id: str, owner: str, price: int, quantity: int, **kwargs):
    return order(order_id, owner, OrderSide.BUY, price, quantity, **kwargs)


def sell(order_id: str, owner: str, price: int, quantity: int, **kwargs):
    return order(order_id, owner, OrderSide.SELL, price, quantity, **kwargs)


class TestOrderConstruction:
    def test_an_order_starts_open_and_unfilled(self) -> None:
        o = buy("o1", "ada", 100, 10)
        assert o.state is OrderState.OPEN
        assert o.filled == 0
        assert o.remaining == 10
        assert o.is_active

    def test_refuses_an_empty_id_a_zero_quantity_and_a_negative_price(self) -> None:
        with pytest.raises((OrderError, ValidationError, InvalidAmountError)):
            buy("", "ada", 100, 10)
        with pytest.raises((OrderError, ValidationError, InvalidAmountError)):
            buy("o", "ada", 100, 0)
        with pytest.raises((OrderError, ValidationError, InvalidAmountError)):
            buy("o", "ada", -1, 10)


class TestMatching:
    def test_a_crossing_order_fills(self) -> None:
        book = [sell("s1", "bob", 100, 10)]
        result = match_order(buy("b1", "ada", 100, 10), book)
        assert len(result.fills) == 1
        fill = result.fills[0]
        assert (fill.quantity, fill.unit_price, fill.consideration) == (10, 100, 1_000)
        assert result.order.state is OrderState.FILLED
        assert result.book == ()

    def test_a_non_crossing_order_rests(self) -> None:
        book = [sell("s1", "bob", 120, 10)]
        result = match_order(buy("b1", "ada", 100, 10), book)
        assert result.fills == ()
        assert len(result.book) == 2

    def test_the_resting_order_names_the_price(self) -> None:
        """A buyer willing to pay 150 pays the 100 that was already on the book.

        Price improvement goes to the arriving order. The alternative -- charging
        the incoming limit -- would make it profitable to watch the book and
        quote just under every bid.
        """
        result = match_order(buy("b1", "ada", 150, 5), [sell("s1", "bob", 100, 5)])
        assert result.fills[0].unit_price == 100

    def test_price_priority_comes_before_time(self) -> None:
        book = [
            sell("late-cheap", "bob", 90, 5, placed_at=NOW + 10),
            sell("early-dear", "cat", 110, 5, placed_at=NOW),
        ]
        result = match_order(buy("b1", "ada", 200, 5), book)
        assert result.fills[0].sell_order_id == "late-cheap"

    def test_time_priority_breaks_a_price_tie(self) -> None:
        book = [
            sell("second", "bob", 100, 5, placed_at=NOW + 10),
            sell("first", "cat", 100, 5, placed_at=NOW),
        ]
        result = match_order(buy("b1", "ada", 100, 5), book)
        assert result.fills[0].sell_order_id == "first"

    def test_the_id_breaks_a_price_and_time_tie(self) -> None:
        """Two orders in the same millisecond must not depend on list order."""
        book = [sell("bbb", "bob", 100, 5), sell("aaa", "cat", 100, 5)]
        forwards = match_order(buy("b1", "ada", 100, 5), book)
        backwards = match_order(buy("b1", "ada", 100, 5), list(reversed(book)))
        assert forwards.fills[0].sell_order_id == "aaa"
        assert backwards.fills[0].sell_order_id == "aaa"

    def test_a_big_order_sweeps_several_levels(self) -> None:
        book = [
            sell("s1", "bob", 100, 5),
            sell("s2", "cat", 110, 5),
            sell("s3", "dan", 120, 5),
        ]
        result = match_order(buy("b1", "ada", 115, 20), book)
        assert [f.unit_price for f in result.fills] == [100, 110]
        assert result.order.remaining == 10  # the rest rests at 115
        assert result.order.state is OrderState.PARTIALLY_FILLED
        assert [o.order_id for o in result.book] == ["b1", "s3"]

    def test_a_partial_fill_leaves_the_remainder_on_the_book(self) -> None:
        result = match_order(buy("b1", "ada", 100, 10), [sell("s1", "bob", 100, 4)])
        assert result.order.filled == 4
        assert result.order.remaining == 6
        assert result.touched[0].state is OrderState.FILLED

    def test_a_member_cannot_trade_with_themselves(self) -> None:
        """Wash trading: two orders, one owner, a price of the owner's choosing.

        Left alone it is how a member manufactures a trade history or moves a
        balance between their own books without a transfer showing up.
        """
        result = match_order(buy("b1", "ada", 100, 10), [sell("s1", "ada", 100, 10)])
        assert result.fills == ()

    def test_orders_in_another_instrument_are_ignored(self) -> None:
        book = [sell("s1", "bob", 10, 10, instrument="wood")]
        result = match_order(buy("b1", "ada", 100, 10), book)
        assert result.fills == ()

    def test_a_filled_order_cannot_be_matched_again(self) -> None:
        result = match_order(buy("b1", "ada", 100, 10), [sell("s1", "bob", 100, 10)])
        with pytest.raises(OrderError):
            match_order(result.order, [])

    def test_the_book_that_comes_back_is_in_matching_order(self) -> None:
        book = [buy("b2", "bob", 90, 5), buy("b1", "cat", 110, 5)]
        result = match_order(sell("s1", "ada", 200, 1), book)
        assert [o.order_id for o in result.book] == ["b1", "b2", "s1"]

    def test_matching_never_mutates_the_book_it_was_given(self) -> None:
        book = [sell("s1", "bob", 100, 10)]
        snapshot = list(book)
        match_order(buy("b1", "ada", 100, 10), book)
        assert book == snapshot
        assert book[0].filled == 0


class TestBookQueries:
    @pytest.fixture
    def book(self):
        return [
            buy("b1", "ada", 90, 5),
            buy("b2", "bob", 95, 3),
            sell("s1", "cat", 105, 4),
            sell("s2", "dan", 110, 6),
        ]

    def test_the_best_bid_is_the_highest_and_the_best_ask_the_lowest(self, book) -> None:
        assert best_bid(book, "ore").order_id == "b2"
        assert best_ask(book, "ore").order_id == "s1"

    def test_the_spread_is_the_gap_between_them(self, book) -> None:
        assert spread(book, "ore") == 10

    def test_a_one_sided_book_has_no_spread(self) -> None:
        assert spread([buy("b1", "ada", 90, 5)], "ore") is None
        assert spread([], "ore") is None

    def test_depth_counts_the_units_still_available(self, book) -> None:
        assert book_depth(book, "ore", OrderSide.BUY) == 8
        assert book_depth(book, "ore", OrderSide.SELL) == 10
        assert book_depth(book, "wood", OrderSide.BUY) == 0

    def test_depth_counts_what_is_left_not_what_was_asked(self) -> None:
        result = match_order(buy("b1", "ada", 100, 4), [sell("s1", "bob", 100, 10)])
        assert book_depth(result.book, "ore", OrderSide.SELL) == 6

    def test_cancelling_takes_an_order_off_the_book(self, book) -> None:
        cancelled, rest = cancel_order(book, "b1")
        assert cancelled.state is OrderState.CANCELLED
        assert not cancelled.is_active
        assert [o.order_id for o in rest] == ["b2", "s1", "s2"]

    def test_cancelling_something_that_is_not_there_is_an_error(self, book) -> None:
        with pytest.raises(OrderError):
            cancel_order(book, "nope")


class TestSettlement:
    def test_a_fill_moves_the_currency_from_buyer_to_seller(self, engine) -> None:
        result = match_order(buy("b1", "ada", 100, 10), [sell("s1", "bob", 100, 10)])
        fill = result.fills[0]
        booking = settle_fill(
            engine,
            fill,
            make_account(ref("ada"), 5_000),
            make_account(ref("bob"), 0),
            NOW,
            "f1",
            "fill",
        )
        assert booking.posting.kind is PostingKind.SETTLEMENT
        assert booking.balances[account_key(ref("ada"))] == 4_000
        assert booking.balances[account_key(ref("bob"))] == 1_000

    def test_a_buyer_without_the_money_cannot_settle(self, engine) -> None:
        # Which is why a serious caller places a hold when the order is placed.
        result = match_order(buy("b1", "ada", 100, 10), [sell("s1", "bob", 100, 10)])
        with pytest.raises(InsufficientFundsError):
            settle_fill(
                engine,
                result.fills[0],
                make_account(ref("ada"), 10),
                make_account(ref("bob"), 0),
                NOW,
                "f1",
                "fill",
            )

    def test_the_accounts_must_be_the_ones_named_in_the_fill(self, engine) -> None:
        result = match_order(buy("b1", "ada", 100, 10), [sell("s1", "bob", 100, 10)])
        with pytest.raises(OrderError):
            settle_fill(
                engine,
                result.fills[0],
                make_account(ref("eve"), 5_000),
                make_account(ref("bob"), 0),
                NOW,
                "f1",
                "fill",
            )


class TestExchange:
    def test_two_currencies_means_two_postings(self, engine) -> None:
        """A posting balances within one currency, so a swap is two of them."""
        sold, bought, received = exchange(
            engine,
            make_account(ref("ada", "COIN"), 1_000),
            make_account(ref("ada", "GEM"), 0),
            400,
            1,
            4,
            NOW,
            "x1",
            "swap",
        )
        assert received == 100
        sink = system_account("g1", "COIN", SystemAccount.SINK)
        mint = system_account("g1", "GEM", SystemAccount.MINT)
        assert sold.balances[account_key(ref("ada", "COIN"))] == 600
        assert sold.balances[account_key(sink)] == 400
        assert bought.balances[account_key(ref("ada", "GEM"))] == 100
        assert bought.balances[account_key(mint)] == -100

    def test_a_member_cannot_sell_currency_they_do_not_hold(self, engine) -> None:
        """The sold leg spends a member's balance like any other payment."""
        with pytest.raises(InsufficientFundsError):
            exchange(
                engine,
                make_account(ref("ada", "COIN"), 10),
                make_account(ref("ada", "GEM"), 0),
                400,
                1,
                4,
                NOW,
                "x1",
                "swap",
            )

    def test_a_named_reserve_must_hold_what_it_pays_out(self, engine) -> None:
        # The mint issues. A reserve pool is an ordinary account and does not.
        reserve = make_account(member_account("g1", "reserve", "GEM"), 10)
        with pytest.raises(InsufficientFundsError):
            exchange(
                engine,
                make_account(ref("ada", "COIN"), 1_000),
                make_account(ref("ada", "GEM"), 0),
                400,
                1,
                4,
                NOW,
                "x1",
                "swap",
                source=reserve,
            )

    def test_the_rounding_is_the_caller_s(self, engine) -> None:
        def swap(rounding):
            return exchange(
                engine,
                make_account(ref("ada", "COIN"), 1_000),
                make_account(ref("ada", "GEM"), 0),
                10,
                1,
                3,
                NOW,
                "x1",
                "swap",
                rounding=rounding,
            )[2]

        assert swap(Rounding.DOWN) == 3
        assert swap(Rounding.UP) == 4

    def test_a_rate_that_buys_nothing_is_refused(self, engine) -> None:
        # Taking currency and giving none back is not an exchange.
        with pytest.raises(OrderError):
            exchange(
                engine,
                make_account(ref("ada", "COIN"), 1_000),
                make_account(ref("ada", "GEM"), 0),
                1,
                1,
                1_000,
                NOW,
                "x1",
                "swap",
            )

    def test_an_exchange_is_one_member_swapping_their_own_currency(self, engine) -> None:
        with pytest.raises(ValidationError):
            exchange(
                engine,
                make_account(ref("ada", "COIN"), 1_000),
                make_account(ref("bob", "GEM"), 0),
                100,
                1,
                1,
                NOW,
                "x1",
                "swap",
            )

    def test_swapping_a_currency_for_itself_is_refused(self, engine) -> None:
        with pytest.raises(CurrencyMismatchError):
            exchange(
                engine,
                make_account(ref("ada", "COIN"), 1_000),
                make_account(ref("ada", "COIN"), 0),
                100,
                1,
                1,
                NOW,
                "x1",
                "swap",
            )

    def test_the_two_postings_carry_different_operation_ids(self, engine) -> None:
        # They are two rows, and the id is unique. Sharing one would make the
        # second insert fail on a caller doing exactly what the docs ask.
        sold, bought, _ = exchange(
            engine,
            make_account(ref("ada", "COIN"), 1_000),
            make_account(ref("ada", "GEM"), 0),
            100,
            1,
            1,
            NOW,
            "x1",
            "swap",
        )
        assert sold.posting.operation_id != bought.posting.operation_id


def auction(**overrides):
    base = {
        "auction_id": "a1",
        "seller": ref("seller"),
        "subject": "sword",
        "currency": "COIN",
        "reserve": 1_000,
        "opened_at": NOW,
        "ends_at": LATER,
    }
    base.update(overrides)
    return open_auction(**base)


def bid(bidder: str, amount: int, at: int = NOW, bid_id: str | None = None):
    return Bid(
        bidder=ref(bidder), amount=amount, placed_at=at, bid_id=bid_id or f"{bidder}-{amount}"
    )


class TestAuctions:
    def test_an_auction_opens_with_no_bids(self) -> None:
        a = auction()
        assert a.state is AuctionState.OPEN
        assert a.highest is None

    def test_refuses_an_auction_that_ends_before_it_opens(self) -> None:
        with pytest.raises(AuctionStateError):
            auction(ends_at=NOW - 1)

    def test_refuses_an_empty_id_or_subject_and_a_negative_reserve(self) -> None:
        for kwargs in ({"auction_id": ""}, {"subject": ""}, {"reserve": -1}):
            with pytest.raises(AuctionStateError):
                auction(**kwargs)

    def test_each_bid_must_beat_the_last_by_the_increment(self) -> None:
        a = place_bid(auction(min_increment=100), bid("ada", 1_000), NOW)
        with pytest.raises(AuctionStateError):
            place_bid(a, bid("bob", 1_050), NOW)
        a = place_bid(a, bid("bob", 1_100), NOW)
        assert a.highest.bidder == ref("bob")

    def test_a_seller_cannot_bid_on_their_own_lot(self) -> None:
        with pytest.raises(AuctionStateError):
            place_bid(auction(), bid("seller", 2_000), NOW)

    def test_a_bid_in_the_wrong_currency_is_refused(self) -> None:
        wrong = Bid(bidder=ref("ada", "GEM"), amount=2_000, placed_at=NOW, bid_id="x")
        with pytest.raises(CurrencyMismatchError):
            place_bid(auction(), wrong, NOW)

    def test_a_repeated_bid_id_is_refused(self) -> None:
        a = place_bid(auction(), bid("ada", 1_000, bid_id="same"), NOW)
        with pytest.raises(AuctionStateError):
            place_bid(a, bid("bob", 2_000, bid_id="same"), NOW)

    def test_bidding_stops_when_the_auction_does(self) -> None:
        with pytest.raises(AuctionStateError):
            place_bid(auction(), bid("ada", 2_000), LATER)

    def test_an_open_reserve_refuses_a_low_bid_as_it_is_placed(self) -> None:
        with pytest.raises(AuctionStateError) as caught:
            place_bid(auction(reserve=1_000), bid("ada", 999), NOW)
        assert caught.value.details["minimum"] == 1_000

    def test_a_hidden_reserve_takes_the_bid_and_loses_at_the_close(self) -> None:
        """Both are real behaviours and the difference matters to a bidder.

        With the reserve open, a low bid is refused and the bidder is told the
        number. Hidden, it is accepted and simply does not win -- which is how
        an auction house runs one, and why it has to be opted into.
        """
        a = auction(reserve=1_000, reserve_hidden=True)
        a = place_bid(a, bid("ada", 400), NOW)
        assert a.highest.amount == 400
        outcome = close_auction(a, LATER)
        assert outcome.auction.state is AuctionState.UNSOLD
        assert outcome.winner is None
        assert outcome.price == 0

    def test_the_highest_bid_wins_at_what_it_bid(self) -> None:
        a = auction()
        a = place_bid(a, bid("ada", 1_000), NOW)
        a = place_bid(a, bid("bob", 1_500), NOW + 1)
        outcome = close_auction(a, LATER)
        assert outcome.auction.state is AuctionState.WON
        assert outcome.winner.bidder == ref("bob")
        assert outcome.price == 1_500

    def test_the_earlier_of_two_equal_bids_wins(self) -> None:
        # They cannot arrive equal through place_bid, but a caller replaying a
        # stored auction can hold two, and the winner must not be arbitrary.
        a = auction()
        a = a.__class__(
            **{
                **a.__dict__,
                "bids": (bid("ada", 2_000, NOW + 5), bid("bob", 2_000, NOW + 1)),
            }
        )
        assert close_auction(a, LATER).winner.bidder == ref("bob")

    def test_an_auction_with_no_bids_is_unsold(self) -> None:
        outcome = close_auction(auction(), LATER)
        assert outcome.auction.state is AuctionState.UNSOLD
        assert outcome.price == 0

    def test_an_auction_closes_once(self) -> None:
        outcome = close_auction(auction(), LATER)
        with pytest.raises(AuctionStateError):
            close_auction(outcome.auction, LATER)

    def test_closing_early_is_allowed(self) -> None:
        # A seller withdrawing the lot, or a "buy it now".
        a = place_bid(auction(), bid("ada", 5_000), NOW)
        assert close_auction(a, NOW + 1).price == 5_000

    def test_settling_pays_the_seller(self, engine) -> None:
        a = place_bid(auction(), bid("ada", 2_000), NOW)
        outcome = close_auction(a, LATER)
        booking, settled = settle_auction(
            engine,
            outcome,
            make_account(ref("ada"), 5_000),
            make_account(ref("seller"), 0),
            LATER,
            "s1",
            "auction",
        )
        assert settled.state is AuctionState.SETTLED
        assert booking.balances[account_key(ref("seller"))] == 2_000
        assert booking.balances[account_key(ref("ada"))] == 3_000

    def test_an_unsold_lot_cannot_be_settled(self, engine) -> None:
        outcome = close_auction(auction(), LATER)
        with pytest.raises(AuctionStateError):
            settle_auction(
                engine,
                outcome,
                make_account(ref("ada"), 5_000),
                make_account(ref("seller"), 0),
                LATER,
                "s1",
                "auction",
            )

    def test_a_winner_who_cannot_pay_does_not_settle(self, engine) -> None:
        a = place_bid(auction(), bid("ada", 2_000), NOW)
        outcome = close_auction(a, LATER)
        with pytest.raises(InsufficientFundsError):
            settle_auction(
                engine,
                outcome,
                make_account(ref("ada"), 10),
                make_account(ref("seller"), 0),
                LATER,
                "s1",
                "auction",
            )

    def test_the_accounts_must_be_the_winner_and_the_seller(self, engine) -> None:
        a = place_bid(auction(), bid("ada", 2_000), NOW)
        outcome = close_auction(a, LATER)
        with pytest.raises(AuctionStateError):
            settle_auction(
                engine,
                outcome,
                make_account(ref("eve"), 5_000),
                make_account(ref("seller"), 0),
                LATER,
                "s1",
                "auction",
            )
