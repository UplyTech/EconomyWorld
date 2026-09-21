"""Investments: positions, valuation, coupons and dividends."""

from __future__ import annotations

import pytest

from economyworld import (
    ConfigurationError,
    CurrencyMismatchError,
    EconomyEngine,
    InstrumentError,
    InstrumentKind,
    InsufficientFundsError,
    PostingKind,
    SystemAccount,
    ValidationError,
    account_key,
    average_cost,
    buy_units,
    coupon_due,
    create_currency,
    create_instrument,
    distribute_dividend,
    make_account,
    member_account,
    open_position,
    pay_coupon,
    sell_units,
    system_account,
    unrealised_gain,
    value_portfolio,
    value_position,
)
from economyworld.instruments import MAX_UNITS

NOW = 1_700_000_000_000


@pytest.fixture
def engine() -> EconomyEngine:
    return EconomyEngine(currencies=[create_currency("COIN")])


def ref(name: str = "ada"):
    return member_account("g1", name, "COIN")


@pytest.fixture
def share():
    return create_instrument("guild-share", InstrumentKind.SHARE, "COIN", "Guild share")


@pytest.fixture
def bond():
    # 5 % of a face value of 1,000: fifty a period, per unit, forever knowable.
    return create_instrument(
        "guild-bond",
        InstrumentKind.BOND,
        "COIN",
        face_value=1_000,
        coupon_basis_points=500,
    )


class TestInstrumentConstruction:
    def test_the_name_defaults_to_the_id(self, share) -> None:
        plain = create_instrument("x", InstrumentKind.SHARE, "COIN")
        assert plain.name == "x"
        assert share.name == "Guild share"

    def test_refuses_an_empty_id_or_currency(self) -> None:
        with pytest.raises(ConfigurationError):
            create_instrument("", InstrumentKind.SHARE, "COIN")
        with pytest.raises(ConfigurationError):
            create_instrument("x", InstrumentKind.SHARE, "")

    def test_only_a_bond_carries_a_coupon(self) -> None:
        """The line that keeps this module free of a price model.

        A share with a built-in coupon would be an instrument that pays out on
        its own, and the next question would be how much -- which is a market
        model, which is what this package does not have.
        """
        with pytest.raises(ConfigurationError):
            create_instrument("x", InstrumentKind.SHARE, "COIN", coupon_basis_points=500)
        with pytest.raises(ConfigurationError):
            create_instrument("x", InstrumentKind.FUND, "COIN", face_value=100)

    def test_a_bond_needs_a_face_value(self) -> None:
        with pytest.raises(ConfigurationError):
            create_instrument("x", InstrumentKind.BOND, "COIN")

    def test_refuses_a_negative_face_value_or_coupon(self) -> None:
        with pytest.raises(ConfigurationError):
            create_instrument("x", InstrumentKind.BOND, "COIN", face_value=-1)
        with pytest.raises(ConfigurationError):
            create_instrument(
                "x", InstrumentKind.BOND, "COIN", face_value=100, coupon_basis_points=-1
            )

    def test_a_position_must_match_the_instrument_currency(self, share) -> None:
        with pytest.raises(CurrencyMismatchError):
            open_position(member_account("g1", "ada", "GEM"), share)

    def test_an_empty_position_holds_nothing(self, share) -> None:
        position = open_position(ref(), share)
        assert (position.units, position.cost_basis, position.realised_gain) == (0, 0, 0)
        assert average_cost(position) == 0


class TestBuying:
    def test_the_currency_goes_to_the_market_account(self, engine, share) -> None:
        buyer = make_account(ref(), 10_000)
        outcome = buy_units(
            engine, share, open_position(ref(), share), buyer, 10, 250, NOW, "b1", "buy"
        )
        assert outcome.consideration == 2_500
        assert outcome.position.units == 10
        assert outcome.position.cost_basis == 2_500
        assert outcome.booking.posting.kind is PostingKind.EXCHANGE
        market = system_account("g1", "COIN", SystemAccount.MARKET)
        assert outcome.booking.balances[account_key(market)] == 2_500
        assert outcome.booking.balances[account_key(ref())] == 7_500

    def test_a_buyer_cannot_buy_with_money_they_do_not_have(self, engine, share) -> None:
        """Buying from the market is still buying, not borrowing.

        The market account may go *negative* when it pays a seller -- it issues.
        That must never be read as permission for the buyer's own balance to.
        """
        buyer = make_account(ref(), 100)
        with pytest.raises(InsufficientFundsError):
            buy_units(
                engine, share, open_position(ref(), share), buyer, 10, 250, NOW, "b1", "buy"
            )

    def test_a_peer_to_peer_purchase_pays_the_seller(self, engine, share) -> None:
        buyer = make_account(ref(), 10_000)
        seller = make_account(ref("bob"), 0)
        outcome = buy_units(
            engine,
            share,
            open_position(ref(), share),
            buyer,
            4,
            100,
            NOW,
            "b1",
            "buy",
            counterparty=seller,
        )
        assert outcome.booking.balances[account_key(seller.ref)] == 400

    def test_buying_twice_averages_the_cost(self, engine, share) -> None:
        buyer = make_account(ref(), 100_000)
        position = open_position(ref(), share)
        position = buy_units(engine, share, position, buyer, 10, 100, NOW, "b1", "x").position
        buyer = make_account(ref(), 99_000)
        position = buy_units(engine, share, position, buyer, 10, 300, NOW, "b2", "x").position
        assert position.units == 20
        assert position.cost_basis == 4_000
        assert average_cost(position) == 200

    def test_a_free_instrument_can_be_granted_at_a_price_of_zero(self, engine, share) -> None:
        # A founding member's share. Zero is a price, not a missing one.
        buyer = make_account(ref(), 0)
        outcome = buy_units(
            engine, share, open_position(ref(), share), buyer, 5, 0, NOW, "b1", "grant"
        )
        assert outcome.consideration == 0
        assert outcome.position.units == 5

    def test_refuses_zero_units_a_negative_price_and_a_wrong_holder(
        self, engine, share
    ) -> None:
        buyer = make_account(ref(), 10_000)
        with pytest.raises(ValidationError):
            buy_units(engine, share, open_position(ref(), share), buyer, 0, 100, NOW, "b", "x")
        with pytest.raises(ValidationError):
            buy_units(engine, share, open_position(ref(), share), buyer, 1, -1, NOW, "b", "x")
        with pytest.raises(InstrumentError):
            buy_units(
                engine, share, open_position(ref("bob"), share), buyer, 1, 100, NOW, "b", "x"
            )

    def test_refuses_to_pass_the_unit_ceiling(self, engine, share) -> None:
        buyer = make_account(ref(), 1_000_000)
        position = open_position(ref(), share)
        with pytest.raises(InstrumentError):
            buy_units(engine, share, position, buyer, MAX_UNITS + 1, 0, NOW, "b", "x")


class TestSelling:
    def _bought(self, engine, share, units=10, price=100):
        buyer = make_account(ref(), 1_000_000)
        return buy_units(
            engine, share, open_position(ref(), share), buyer, units, price, NOW, "b", "x"
        ).position

    def test_the_market_pays_the_seller(self, engine, share) -> None:
        position = self._bought(engine, share)
        seller = make_account(ref(), 0)
        outcome = sell_units(engine, share, position, seller, 10, 150, NOW, "s1", "sell")
        assert outcome.consideration == 1_500
        assert outcome.booking.balances[account_key(ref())] == 1_500
        market = system_account("g1", "COIN", SystemAccount.MARKET)
        assert outcome.booking.balances[account_key(market)] == -1_500

    def test_a_full_sale_clears_the_cost_basis_exactly(self, engine, share) -> None:
        """No rounding may strand a unit of cost on an empty position."""
        for units, price in ((3, 333), (7, 101), (99, 7), (1, 1)):
            position = self._bought(engine, share, units, price)
            seller = make_account(ref(), 0)
            outcome = sell_units(engine, share, position, seller, units, 50, NOW, "s", "x")
            assert outcome.position.units == 0
            assert outcome.position.cost_basis == 0

    def test_a_partial_sale_releases_its_share_of_the_cost(self, engine, share) -> None:
        position = self._bought(engine, share, 10, 100)  # 1,000 for ten
        seller = make_account(ref(), 0)
        outcome = sell_units(engine, share, position, seller, 4, 150, NOW, "s", "x")
        assert outcome.position.cost_basis == 600
        assert outcome.realised_gain == 600 - 400  # sold for 600, cost 400

    def test_a_loss_is_realised_as_a_negative_gain(self, engine, share) -> None:
        position = self._bought(engine, share, 10, 100)
        seller = make_account(ref(), 0)
        outcome = sell_units(engine, share, position, seller, 10, 40, NOW, "s", "x")
        assert outcome.realised_gain == -600
        assert outcome.position.realised_gain == -600

    def test_the_realised_gain_accumulates_over_a_full_round_trip(self, engine, share) -> None:
        # Buy at 100, sell half at 150, sell the rest at 50. The total realised
        # gain must equal what actually came back minus what actually went out.
        position = self._bought(engine, share, 10, 100)
        seller = make_account(ref(), 0)
        position = sell_units(engine, share, position, seller, 5, 150, NOW, "s1", "x").position
        position = sell_units(engine, share, position, seller, 5, 50, NOW, "s2", "x").position
        assert position.units == 0
        assert position.cost_basis == 0
        assert position.realised_gain == (750 + 250) - 1_000

    def test_cannot_sell_more_than_is_held(self, engine, share) -> None:
        position = self._bought(engine, share, 3, 100)
        seller = make_account(ref(), 0)
        with pytest.raises(InstrumentError):
            sell_units(engine, share, position, seller, 4, 100, NOW, "s", "x")

    def test_a_peer_to_peer_sale_needs_the_buyer_to_have_the_money(
        self, engine, share
    ) -> None:
        position = self._bought(engine, share, 10, 100)
        seller = make_account(ref(), 0)
        skint = make_account(ref("bob"), 10)
        with pytest.raises(InsufficientFundsError):
            sell_units(
                engine, share, position, seller, 10, 100, NOW, "s", "x", counterparty=skint
            )


class TestValuation:
    def test_value_is_units_times_the_price_the_caller_supplies(self, share) -> None:
        position = open_position(ref(), share)
        assert value_position(position, 500).market_value == 0
        held = type(position)(ref(), "guild-share", 10, 1_000)
        valuation = value_position(held, 150)
        assert valuation.market_value == 1_500
        assert valuation.cost_basis == 1_000
        assert valuation.unrealised_gain == 500

    def test_a_price_of_zero_values_a_holding_at_nothing(self, share) -> None:
        held = open_position(ref(), share).__class__(ref(), "guild-share", 10, 1_000)
        assert value_position(held, 0).unrealised_gain == -1_000

    def test_a_portfolio_without_a_price_is_an_error_not_a_zero(self, share) -> None:
        """A total that quietly omits a holding is a number a member acts on."""
        held = open_position(ref(), share).__class__(ref(), "guild-share", 10, 1_000)
        with pytest.raises(InstrumentError):
            value_portfolio([held], {})

    def test_a_portfolio_totals_its_holdings(self, share) -> None:
        cls = open_position(ref(), share).__class__
        positions = [cls(ref(), "a", 10, 1_000), cls(ref(), "b", 5, 500)]
        prices = {"a": 150, "b": 50}
        assert unrealised_gain(positions, prices) == (1_500 - 1_000) + (250 - 500)

    def test_no_holdings_are_worth_nothing(self) -> None:
        assert unrealised_gain([], {}) == 0


class TestCoupons:
    def test_the_coupon_is_fixed_by_the_terms(self, bond) -> None:
        assert coupon_due(bond, 1) == 50
        assert coupon_due(bond, 10) == 500
        assert coupon_due(bond, 10, 4) == 2_000

    def test_nothing_is_due_on_nothing(self, bond) -> None:
        assert coupon_due(bond, 0) == 0
        assert coupon_due(bond, 10, 0) == 0

    def test_a_coupon_too_small_to_round_pays_nothing(self, engine) -> None:
        tiny = create_instrument(
            "t", InstrumentKind.BOND, "COIN", face_value=1, coupon_basis_points=1
        )
        assert coupon_due(tiny, 1) == 0
        holder = make_account(ref(), 0)
        position = open_position(ref(), tiny).__class__(ref(), "t", 1, 1)
        assert pay_coupon(engine, tiny, position, holder, NOW, "c", "coupon") is None

    def test_only_a_bond_pays_one(self, share) -> None:
        with pytest.raises(InstrumentError):
            coupon_due(share, 10)

    def test_the_mint_funds_a_coupon_by_default(self, engine, bond) -> None:
        holder = make_account(ref(), 0)
        position = open_position(ref(), bond).__class__(ref(), "guild-bond", 10, 10_000)
        booking = pay_coupon(engine, bond, position, holder, NOW, "c", "coupon")
        assert booking is not None
        assert booking.posting.kind is PostingKind.DISTRIBUTION
        mint = system_account("g1", "COIN", SystemAccount.MINT)
        assert booking.balances[account_key(mint)] == -500
        assert booking.balances[account_key(ref())] == 500

    def test_a_named_payer_must_have_the_currency(self, engine, bond) -> None:
        """The mint issues. An issuer paying its own bondholders does not.

        Otherwise a guild treasury could pay coupons it cannot afford and the
        overdraft would look like a bookkeeping detail rather than a default.
        """
        holder = make_account(ref(), 0)
        position = open_position(ref(), bond).__class__(ref(), "guild-bond", 10, 10_000)
        issuer = make_account(member_account("g1", "issuer", "COIN"), 100)
        with pytest.raises(InsufficientFundsError):
            pay_coupon(engine, bond, position, holder, NOW, "c", "coupon", source=issuer)
        funded = make_account(member_account("g1", "issuer", "COIN"), 10_000)
        booking = pay_coupon(engine, bond, position, holder, NOW, "c", "coupon", source=funded)
        assert booking is not None
        assert booking.balances[account_key(funded.ref)] == 9_500

    def test_refuses_a_negative_period_count(self, bond) -> None:
        with pytest.raises(ValidationError):
            coupon_due(bond, 1, -1)


class TestDividends:
    def test_the_shares_add_up_to_the_declared_total(self, share) -> None:
        cls = open_position(ref(), share).__class__
        positions = [
            cls(ref("a"), "s", 1, 0),
            cls(ref("b"), "s", 1, 0),
            cls(ref("c"), "s", 1, 0),
        ]
        for total in (0, 1, 2, 10, 1_000, 9_999):
            payouts = distribute_dividend(positions, total)
            assert sum(amount for _, amount in payouts) == total

    def test_the_split_is_by_units_held(self, share) -> None:
        cls = open_position(ref(), share).__class__
        positions = [cls(ref("a"), "s", 70, 0), cls(ref("b"), "s", 30, 0)]
        assert [amount for _, amount in distribute_dividend(positions, 1_000)] == [700, 300]

    def test_empty_positions_are_left_out_rather_than_paid_nothing(self, share) -> None:
        cls = open_position(ref(), share).__class__
        positions = [cls(ref("a"), "s", 10, 0), cls(ref("b"), "s", 0, 0)]
        payouts = distribute_dividend(positions, 100)
        assert [holder.owner for holder, _ in payouts] == ["a"]

    def test_a_dividend_with_nobody_to_pay_is_an_error(self, share) -> None:
        cls = open_position(ref(), share).__class__
        with pytest.raises(InstrumentError):
            distribute_dividend([cls(ref("a"), "s", 0, 0)], 100)
        with pytest.raises(InstrumentError):
            distribute_dividend([], 100)

    def test_refuses_a_negative_dividend(self, share) -> None:
        cls = open_position(ref(), share).__class__
        with pytest.raises(ValidationError):
            distribute_dividend([cls(ref("a"), "s", 1, 0)], -1)
