"""Fees, taxes and commissions."""

from __future__ import annotations

import pytest

from economyworld import (
    MAX_FEE_BASIS_POINTS,
    ConfigurationError,
    EconomyEngine,
    FeeMode,
    PostingKind,
    Rounding,
    SystemAccount,
    ValidationError,
    account_key,
    charge_fee,
    create_currency,
    create_fee_rule,
    create_tier,
    make_account,
    member_account,
    quote_fee,
    split_fee,
    system_account,
    total_of,
)

NOW = 1_700_000_000_000


@pytest.fixture
def engine() -> EconomyEngine:
    return EconomyEngine(currencies=[create_currency("COIN")])


def ref(name: str = "ada"):
    return member_account("g1", name, "COIN")


class TestRuleConstruction:
    def test_a_rule_needs_a_key(self) -> None:
        with pytest.raises(ConfigurationError):
            create_fee_rule("", basis_points=100)

    def test_refuses_a_negative_charge(self) -> None:
        for kwargs in ({"flat": -1}, {"basis_points": -1}, {"minimum": -1}, {"maximum": -1}):
            with pytest.raises((ValidationError, ConfigurationError)):
                create_fee_rule("k", **kwargs)  # type: ignore[arg-type]

    def test_refuses_a_maximum_below_the_minimum(self) -> None:
        # Otherwise the two clamps contradict each other and the answer depends
        # on which one the implementation happens to apply last.
        with pytest.raises(ConfigurationError):
            create_fee_rule("k", basis_points=100, minimum=500, maximum=100)

    def test_allows_a_rate_above_a_hundred_per_cent_but_not_a_typo(self) -> None:
        # A penalty surcharge really can exceed what it is charged on, so 150 %
        # is a policy. A million basis points is a slipped decimal point.
        assert quote_fee(create_fee_rule("k", basis_points=15_000), 100).fee == 150
        with pytest.raises(ConfigurationError):
            create_fee_rule("k", basis_points=MAX_FEE_BASIS_POINTS + 1)

    def test_tiers_must_start_at_zero(self) -> None:
        # A first tier at 100 would charge nothing at all on amounts below 100,
        # silently, which is a configuration bug rather than a design.
        with pytest.raises(ConfigurationError):
            create_fee_rule("k", tiers=[create_tier(100, 250)])

    def test_tiers_must_ascend(self) -> None:
        with pytest.raises(ConfigurationError):
            create_fee_rule("k", tiers=[create_tier(0, 250), create_tier(0, 100)])

    def test_tiers_are_kept_in_the_order_given_and_must_be_the_right_one(self) -> None:
        # Sorting them silently would hide a caller who wrote the bands out of
        # order and therefore probably wrote the rates against the wrong ones.
        with pytest.raises(ConfigurationError):
            create_fee_rule("k", tiers=[create_tier(1000, 100), create_tier(0, 250)])
        rule = create_fee_rule("k", tiers=[create_tier(0, 250), create_tier(1000, 100)])
        assert [tier.threshold for tier in rule.tiers] == [0, 1000]

    def test_a_tier_refuses_an_impossible_rate(self) -> None:
        with pytest.raises(ConfigurationError):
            create_tier(0, MAX_FEE_BASIS_POINTS + 1)
        with pytest.raises((ValidationError, ConfigurationError)):
            create_tier(-1, 100)


class TestQuoting:
    def test_the_documented_example(self) -> None:
        rule = create_fee_rule("transfer", basis_points=250, minimum=1)
        quote = quote_fee(rule, 1_000)
        assert (quote.fee, quote.payer_pays, quote.recipient_receives) == (25, 1025, 1000)

    def test_on_top_adds_and_inclusive_deducts(self) -> None:
        # The same 2.5 per cent, charged the two ways a shop can charge it. Both
        # must be expressible: a marketplace commission comes out of the sale, a
        # payment surcharge goes on top of it.
        on_top = create_fee_rule("a", basis_points=250)
        inclusive = create_fee_rule("b", FeeMode.INCLUSIVE, basis_points=250)
        assert quote_fee(on_top, 1_000).payer_pays == 1_025
        assert quote_fee(on_top, 1_000).recipient_receives == 1_000
        assert quote_fee(inclusive, 1_000).payer_pays == 1_000
        assert quote_fee(inclusive, 1_000).recipient_receives == 975

    def test_an_inclusive_fee_never_exceeds_the_amount(self) -> None:
        # A flat 50 on a payment of 10 leaves the recipient nothing. It must not
        # leave them minus forty.
        rule = create_fee_rule("b", FeeMode.INCLUSIVE, flat=50)
        quote = quote_fee(rule, 10)
        assert quote.fee == 10
        assert quote.recipient_receives == 0
        assert quote.payer_pays == 10

    def test_flat_and_rate_add_together(self) -> None:
        rule = create_fee_rule("k", flat=5, basis_points=100)
        assert quote_fee(rule, 1_000).fee == 15

    def test_the_minimum_lifts_a_small_fee(self) -> None:
        rule = create_fee_rule("k", basis_points=100, minimum=10)
        assert quote_fee(rule, 100).fee == 10  # one per cent of 100 is 1
        assert quote_fee(rule, 100_000).fee == 1_000

    def test_the_maximum_caps_a_large_one(self) -> None:
        rule = create_fee_rule("k", basis_points=100, maximum=500)
        assert quote_fee(rule, 1_000_000).fee == 500

    def test_the_minimum_applies_to_a_zero_amount_too(self) -> None:
        # Deliberate: a rule with a floor charges the floor. A caller who wants
        # free-below-a-threshold writes a tier, not a minimum.
        rule = create_fee_rule("k", basis_points=100, minimum=10)
        assert quote_fee(rule, 0).fee == 10

    def test_rounding_is_the_rule_s_choice(self) -> None:
        down = create_fee_rule("k", basis_points=1)
        up = create_fee_rule("k", basis_points=1, rounding=Rounding.UP)
        assert quote_fee(down, 100).fee == 0  # a hundredth of a unit
        assert quote_fee(up, 100).fee == 1

    def test_refuses_a_negative_amount(self) -> None:
        with pytest.raises(ValidationError):
            quote_fee(create_fee_rule("k", flat=1), -1)

    def test_a_rule_that_charges_nothing_quotes_nothing(self) -> None:
        quote = quote_fee(create_fee_rule("free"), 1_000)
        assert quote.fee == 0
        assert quote.payer_pays == quote.recipient_receives == 1_000


class TestTiers:
    @pytest.fixture
    def rule(self):
        # Nothing on the first 1,000; one per cent to 10,000; 2.5 beyond.
        return create_fee_rule(
            "market",
            tiers=[create_tier(0, 0), create_tier(1_000, 100), create_tier(10_000, 250)],
        )

    def test_each_band_is_charged_on_its_own_slice(self, rule) -> None:
        assert quote_fee(rule, 1_000).fee == 0
        assert quote_fee(rule, 2_000).fee == 10  # one per cent of the 1,000 above
        assert quote_fee(rule, 10_000).fee == 90  # one per cent of 9,000
        # 90, plus 2.5 per cent of the 10,000 above the second threshold.
        assert quote_fee(rule, 20_000).fee == 90 + 250

    def test_the_fee_never_falls_as_the_amount_rises(self, rule) -> None:
        previous = 0
        for amount in range(0, 30_000, 137):
            fee = quote_fee(rule, amount).fee
            assert fee >= previous
            previous = fee

    def test_a_tier_can_never_take_more_than_the_slice(self, rule) -> None:
        for amount in (1, 999, 1_000, 1_001, 9_999, 10_001, 999_999):
            assert quote_fee(rule, amount).fee <= amount

    def test_tiers_stack_with_a_flat_charge(self) -> None:
        rule = create_fee_rule("k", flat=7, tiers=[create_tier(0, 100)])
        assert quote_fee(rule, 1_000).fee == 17


class TestCharging:
    def test_books_the_fee_to_the_scope_fee_account(self, engine: EconomyEngine) -> None:
        payer = make_account(ref(), 10_000)
        quote = quote_fee(create_fee_rule("k", basis_points=250), 1_000)
        booking = charge_fee(engine, payer, quote, NOW, "f1", "commission")
        assert booking is not None
        assert booking.posting.kind is PostingKind.FEE
        fee_ref = system_account("g1", "COIN", SystemAccount.FEE)
        assert booking.balances[account_key(fee_ref)] == 25
        assert booking.balances[account_key(ref())] == 9_975

    def test_a_zero_fee_books_nothing_rather_than_raising(self, engine: EconomyEngine) -> None:
        # An ordinary outcome for a rule with a free band, not an error.
        payer = make_account(ref(), 10_000)
        quote = quote_fee(create_fee_rule("k", tiers=[create_tier(0, 0)]), 1_000)
        assert charge_fee(engine, payer, quote, NOW, "f1", "commission") is None

    def test_the_charge_equals_the_quote(self, engine: EconomyEngine) -> None:
        """The promise that makes a quote worth showing to a member."""
        rule = create_fee_rule("k", flat=3, basis_points=175, minimum=10, maximum=900)
        for amount in (0, 1, 99, 1_000, 55_555, 1_000_000):
            payer = make_account(ref(), 5_000_000)
            quote = quote_fee(rule, amount)
            booking = charge_fee(engine, payer, quote, NOW, f"f{amount}", "x")
            charged = 0 if booking is None else booking.posting.amount
            assert charged == quote.fee

    def test_the_fee_can_be_sent_somewhere_else(self, engine: EconomyEngine) -> None:
        # A guild that keeps its own commission rather than the scope's.
        payer = make_account(ref(), 10_000)
        pot = make_account(member_account("g1", "guild-pot", "COIN"), 0)
        quote = quote_fee(create_fee_rule("k", flat=100), 1_000)
        booking = charge_fee(engine, payer, quote, NOW, "f1", "x", fee_account=pot)
        assert booking is not None
        assert booking.balances[account_key(pot.ref)] == 100


class TestSplittingAndTotals:
    def test_the_shares_add_up_to_the_fee(self) -> None:
        for fee in (0, 1, 2, 7, 100, 9_999):
            for weights in ([1, 1, 1], [70, 20, 10], [1, 0], [5]):
                shares = split_fee(fee, weights)
                assert sum(shares) == fee
                assert len(shares) == len(weights)

    def test_a_zero_weight_gets_nothing(self) -> None:
        assert split_fee(100, [1, 0, 1]) == [50, 0, 50]

    def test_a_remainder_still_leaves_the_shares_exact(self) -> None:
        # 10 split three ways is 3.33 each; somebody has to get the extra unit.
        assert sum(split_fee(10, [1, 1, 1])) == 10

    def test_several_rules_are_charged_on_the_amount_not_on_each_other(self) -> None:
        """Order-independence, which is the whole reason for this helper."""
        platform = create_fee_rule("platform", basis_points=250)
        tax = create_fee_rule("tax", basis_points=1900)
        forwards = total_of([quote_fee(platform, 10_000), quote_fee(tax, 10_000)])
        backwards = total_of([quote_fee(tax, 10_000), quote_fee(platform, 10_000)])
        assert forwards == backwards == 250 + 1_900

    def test_no_quotes_total_nothing(self) -> None:
        assert total_of([]) == 0
