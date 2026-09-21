"""Every refusal the financial modules make, and the accessors nothing else hits.

A library's refusals are part of its contract: a caller reads "raises
ValidationError when the id is empty" and writes code that depends on it. The
suites next door check the behaviour of each subsystem; this one walks the
guards themselves, so that no argument check is a line nobody has ever run.

The wrong-type cases pass ``bool`` and ``float`` on purpose. In Python ``True``
*is* an ``int`` and ``1.0 == 1``, so a check written as ``isinstance(x, int)``
alone lets a boolean through and one written as ``x == int(x)`` lets a float
through. Both would then reach the ledger, and a balance of ``True`` is not a
balance.
"""

from __future__ import annotations

import pytest

from economyworld import (
    AuctionStateError,
    ConfigurationError,
    CurrencyMismatchError,
    DepositError,
    EconomyEngine,
    HoldError,
    InstrumentError,
    InstrumentKind,
    InvalidAmountError,
    LoanStateError,
    OrderError,
    OrderSide,
    PostingKind,
    RateError,
    ScheduleError,
    SystemAccount,
    ValidationError,
    account_key,
    accrue_deposit_interest,
    amortisation_schedule,
    amount_due,
    apply_rate,
    assert_within_credit_limit,
    available_balance,
    buy_units,
    cancel_order,
    capture_hold,
    charge_late_fee,
    close_auction,
    create_currency,
    create_deposit_terms,
    create_fee_rule,
    create_instrument,
    create_loan_terms,
    create_order,
    create_plan,
    distribute,
    finance_purchase,
    is_in_arrears,
    level_payment,
    make_account,
    match_order,
    member_account,
    next_instalment,
    open_auction,
    open_deposit,
    open_loan,
    open_position,
    place_bid,
    place_hold,
    quote_fee,
    release_hold,
    repay,
    settle_auction,
    settle_early,
    settle_fill,
    settlement_quote,
    system_account,
)
from economyworld.bank import Hold
from economyworld.instruments import Position
from economyworld.market import Bid

NOW = 1_700_000_000_000
LATER = NOW + 60_000
NOT_A_TIMESTAMP = (True, 1.5, "now", None)


@pytest.fixture
def engine() -> EconomyEngine:
    return EconomyEngine(currencies=[create_currency("COIN")])


def ref(name: str = "ada", currency: str = "COIN"):
    return member_account("g1", name, currency)


class TestCurrencyAndAmountGuards:
    def test_a_currency_needs_whole_numbers_for_its_shape(self) -> None:
        with pytest.raises(ConfigurationError):
            create_currency("COIN", minor_units=1.5)  # type: ignore[arg-type]
        with pytest.raises(ConfigurationError):
            create_currency("COIN", max_balance=1.5)  # type: ignore[arg-type]

    def test_a_rate_is_two_whole_numbers(self) -> None:
        with pytest.raises(InvalidAmountError):
            apply_rate(100, 1.5, 2)  # type: ignore[arg-type]
        with pytest.raises(InvalidAmountError):
            apply_rate(100, 1, 2.5)  # type: ignore[arg-type]
        with pytest.raises(InvalidAmountError):
            apply_rate(100, 1, 0)

    def test_a_weight_is_a_whole_number(self) -> None:
        with pytest.raises(ValidationError):
            distribute(100, [1, 1.5])  # type: ignore[list-item]
        with pytest.raises(ValidationError):
            distribute(100, [1, -1])


class TestInterestGuards:
    def test_a_period_count_is_a_whole_number(self) -> None:
        with pytest.raises(RateError):
            level_payment(1_000, 100, 1.5)  # type: ignore[arg-type]
        with pytest.raises(RateError):
            amortisation_schedule(1_000, 100, True)  # type: ignore[arg-type]

    def test_a_schedule_is_checked_before_it_is_handed_back(self) -> None:
        """The self-check that makes a schedule worth trusting.

        Every row must add up, the closing balance must reach zero, and the
        totals must stay inside the range both editions can hold. A schedule
        that failed any of those would be a table a community bills from.
        """
        from economyworld.interest import _assert_closes  # noqa: PLC2701 - the check

        schedule = amortisation_schedule(120_000, 100, 12)
        _assert_closes(schedule)  # a good one passes

        from dataclasses import replace

        broken = replace(
            schedule,
            instalments=(
                *schedule.instalments[:-1],
                replace(schedule.instalments[-1], closing_balance=1),
            ),
        )
        with pytest.raises(RateError):
            _assert_closes(broken)

    def test_an_empty_schedule_is_refused(self) -> None:
        from dataclasses import replace

        from economyworld.interest import _assert_closes  # noqa: PLC2701 - the check

        schedule = amortisation_schedule(1_000, 0, 1)
        with pytest.raises(RateError):
            _assert_closes(replace(schedule, instalments=()))


class TestBankGuards:
    def test_a_deposit_needs_an_id(self) -> None:
        with pytest.raises(ValidationError):
            open_deposit("", ref(), create_deposit_terms(), NOW)

    def test_a_deposit_belongs_to_one_account(self, engine) -> None:
        """And to one currency, which the same check settles.

        An AccountRef carries its currency, so comparing refs compares the
        currency too -- there is no second check, because there would be
        nothing left for it to catch.
        """
        from economyworld import deposit

        account = open_deposit("d", ref(), create_deposit_terms(), NOW)
        for wrong in (ref("eve"), member_account("g1", "ada", "GEM")):
            with pytest.raises(DepositError):
                deposit(engine, account, make_account(wrong, 1_000), 100, NOW, "d1", "x")

    def test_interest_is_accrued_over_whole_periods(self, engine) -> None:
        account = open_deposit("d", ref(), create_deposit_terms(rate_basis_points=100), NOW)
        with pytest.raises(ValidationError):
            accrue_deposit_interest(engine, account, -1, NOW, "a", "x")
        with pytest.raises(ValidationError):
            accrue_deposit_interest(engine, account, 1.5, NOW, "a", "x")  # type: ignore[arg-type]

    def test_a_hold_needs_an_id_and_an_amount(self) -> None:
        with pytest.raises(ValidationError):
            place_hold("", make_account(ref(), 1_000), 100, NOW, "bid")
        with pytest.raises(InvalidAmountError):
            place_hold("h", make_account(ref(), 1_000), 0, NOW, "bid")

    def test_a_hold_that_is_not_there_cannot_be_released(self) -> None:
        held = place_hold("h1", make_account(ref(), 1_000), 100, NOW, "bid")
        with pytest.raises(HoldError):
            release_hold([held], "nope")
        assert release_hold([held], "h1") == []

    def test_a_capture_takes_no_more_than_was_reserved(self, engine) -> None:
        held = place_hold("h1", make_account(ref(), 1_000), 100, NOW, "bid")
        with pytest.raises(HoldError):
            capture_hold(
                engine,
                held,
                make_account(ref(), 1_000),
                make_account(ref("shop"), 0),
                NOW,
                "c",
                "x",
                amount=101,
            )

    def test_a_capture_is_against_the_account_the_hold_is_on(self, engine) -> None:
        held = place_hold("h1", make_account(ref(), 1_000), 100, NOW, "bid")
        with pytest.raises(HoldError):
            capture_hold(
                engine,
                held,
                make_account(ref("eve"), 1_000),
                make_account(ref("shop"), 0),
                NOW,
                "c",
                "x",
            )

    def test_an_expired_hold_cannot_be_captured(self, engine) -> None:
        # It stopped reserving anything, so the funds may already be spent.
        held = place_hold(
            "h1", make_account(ref(), 1_000), 100, NOW, "bid", expires_at=NOW + 10
        )
        with pytest.raises(HoldError):
            capture_hold(
                engine,
                held,
                make_account(ref(), 1_000),
                make_account(ref("shop"), 0),
                NOW + 10,
                "c",
                "x",
            )

    def test_a_hold_on_another_account_does_not_reserve_this_one(self) -> None:
        """Callers pass a list of holds, and the list may hold other people's.

        Reserving against somebody else's hold would tell a member they cannot
        spend a balance that is theirs.
        """
        theirs = Hold(
            hold_id="h",
            account=ref("bob"),
            amount=1_000,
            placed_at=NOW,
            expires_at=None,
            reason="bid",
        )
        mine = make_account(ref(), 500)
        assert available_balance(mine, [theirs], NOW) == 500
        assert place_hold("h2", mine, 500, NOW, "bid", [theirs]).amount == 500

    def test_a_hold_id_is_used_once(self) -> None:
        mine = make_account(ref(), 1_000)
        first = place_hold("h1", mine, 100, NOW, "bid")
        with pytest.raises(HoldError):
            place_hold("h1", mine, 100, NOW, "bid", [first])

    def test_a_hold_cannot_expire_before_it_is_placed(self) -> None:
        with pytest.raises(HoldError):
            place_hold("h", make_account(ref(), 1_000), 100, NOW, "bid", expires_at=NOW)

    def test_a_timestamp_is_a_whole_number_of_milliseconds(self) -> None:
        for value in NOT_A_TIMESTAMP:
            with pytest.raises(ValidationError):
                open_deposit("d", ref(), create_deposit_terms(), value)  # type: ignore[arg-type]


class TestCreditGuards:
    def test_terms_are_validated_before_a_loan_exists(self) -> None:
        for kwargs in (
            {"late_fee_basis_points": -1},
            {"late_fee_basis_points": 1.5},
            {"grace_periods": -1},
            {"grace_periods": True},
        ):
            with pytest.raises(ValidationError):
                create_loan_terms(principal=1_000, rate_basis_points=0, periods=2, **kwargs)  # type: ignore[arg-type]

    def test_a_credit_limit_is_a_non_negative_whole_number(self) -> None:
        terms = create_loan_terms(principal=1_000, rate_basis_points=0, periods=2)
        with pytest.raises(ValidationError):
            assert_within_credit_limit(terms, existing=0, credit_limit=-1)

    def test_a_loan_needs_an_id(self, engine) -> None:
        terms = create_loan_terms(principal=1_000, rate_basis_points=0, periods=2)
        with pytest.raises(ValidationError):
            open_loan(engine, "", terms, make_account(ref(), 0), NOW, "o", "x")

    def test_an_amount_due_is_for_a_whole_number_of_instalments(self, engine) -> None:
        _, loan = open_loan(
            engine,
            "L",
            create_loan_terms(principal=1_000, rate_basis_points=100, periods=4),
            make_account(ref(), 0),
            NOW,
            "o",
            "x",
        )
        for value in (0, -1, 1.5, True):
            with pytest.raises(ValidationError):
                amount_due(loan, value)  # type: ignore[arg-type]

    def test_a_rebate_is_a_share_of_the_interest_and_not_more(self, engine) -> None:
        _, loan = open_loan(
            engine,
            "L",
            create_loan_terms(principal=1_000, rate_basis_points=100, periods=4),
            make_account(ref(), 0),
            NOW,
            "o",
            "x",
        )
        for value in (-1, 10_001, 1.5, True):
            with pytest.raises(ValidationError):
                settle_early(
                    engine,
                    loan,
                    make_account(ref(), 10_000),
                    NOW,
                    "s",
                    "x",
                    rebate_basis_points=value,  # type: ignore[arg-type]
                )

    def test_a_closed_loan_takes_no_further_action(self, engine) -> None:
        _, loan = open_loan(
            engine,
            "L",
            create_loan_terms(principal=1_000, rate_basis_points=0, periods=1),
            make_account(ref(), 0),
            NOW,
            "o",
            "x",
        )
        settled = settle_early(engine, loan, make_account(ref(), 10_000), NOW, "s", "x").loan

        with pytest.raises(Exception):  # noqa: B017 - LoanStateError from credit
            repay(engine, settled, make_account(ref(), 10_000), 100, NOW, "r", "x")
        with pytest.raises(Exception):  # noqa: B017 - LoanStateError from credit
            charge_late_fee(settled, 1)
        # These two answer rather than raise: a closed loan simply owes nothing
        # and is behind on nothing.
        assert settlement_quote(settled, 1) == 0
        assert is_in_arrears(settled, instalments_expected=99) is False
        assert next_instalment(settled) is None

    def test_a_late_fee_is_for_a_whole_number_of_missed_instalments(self, engine) -> None:
        _, loan = open_loan(
            engine,
            "L",
            create_loan_terms(principal=1_000, rate_basis_points=0, periods=4),
            make_account(ref(), 0),
            NOW,
            "o",
            "x",
        )
        for value in (0, -1, 1.5, True):
            with pytest.raises(ValidationError):
                charge_late_fee(loan, value)  # type: ignore[arg-type]

    def test_a_repayment_comes_from_the_borrower(self, engine) -> None:
        """One check, because a ref carries the currency it is denominated in."""
        _, loan = open_loan(
            engine,
            "L",
            create_loan_terms(principal=1_000, rate_basis_points=0, periods=4),
            make_account(ref(), 0),
            NOW,
            "o",
            "x",
        )
        for wrong in (ref("eve"), member_account("g1", "ada", "GEM")):
            with pytest.raises(LoanStateError):
                repay(engine, loan, make_account(wrong, 10_000), 100, NOW, "r", "x")

    def test_a_timestamp_is_a_whole_number_of_milliseconds(self, engine) -> None:
        terms = create_loan_terms(principal=1_000, rate_basis_points=0, periods=2)
        for value in NOT_A_TIMESTAMP:
            with pytest.raises(ValidationError):
                open_loan(engine, "L", terms, make_account(ref(), 0), value, "o", "x")  # type: ignore[arg-type]


class TestInstrumentGuards:
    def test_units_are_whole_numbers(self, engine) -> None:
        share = create_instrument("s", InstrumentKind.SHARE, "COIN")
        for value in (1.5, "10", None):
            with pytest.raises(ValidationError):
                buy_units(
                    engine,
                    share,
                    open_position(ref(), share),
                    make_account(ref(), 10_000),
                    value,  # type: ignore[arg-type]
                    100,
                    NOW,
                    "b",
                    "x",
                )

    def test_a_position_belongs_to_one_holder_and_one_instrument(self, engine) -> None:
        share = create_instrument("s", InstrumentKind.SHARE, "COIN")
        other = create_instrument("other", InstrumentKind.SHARE, "COIN")
        with pytest.raises(InstrumentError):
            buy_units(
                engine,
                other,
                open_position(ref(), share),
                make_account(ref(), 10_000),
                1,
                100,
                NOW,
                "b",
                "x",
            )

    def test_a_position_in_another_currency_is_refused(self, engine) -> None:
        """A hand-built position can hold a currency the instrument does not.

        :func:`open_position` will not make one, but ``Position`` is a plain
        record a caller rebuilds from their own database -- and a portfolio
        that mixes currencies is a portfolio whose total means nothing.
        """
        share = create_instrument("s", InstrumentKind.SHARE, "COIN")
        holder = ref(currency="GEM")
        mismatched = Position(holder=holder, instrument_id="s", units=0, cost_basis=0)
        with pytest.raises(CurrencyMismatchError):
            buy_units(
                engine,
                share,
                mismatched,
                make_account(holder, 10_000),
                1,
                100,
                NOW,
                "b",
                "x",
            )

    def test_a_timestamp_is_a_whole_number_of_milliseconds(self, engine) -> None:
        share = create_instrument("s", InstrumentKind.SHARE, "COIN")
        for value in NOT_A_TIMESTAMP:
            with pytest.raises(ValidationError):
                buy_units(
                    engine,
                    share,
                    open_position(ref(), share),
                    make_account(ref(), 10_000),
                    1,
                    100,
                    value,  # type: ignore[arg-type]
                    "b",
                    "x",
                )


class TestMarketGuards:
    def test_an_order_needs_an_instrument(self) -> None:
        with pytest.raises(OrderError):
            create_order("o", ref(), "", OrderSide.BUY, 100, 1, NOW)

    def test_a_cancelled_order_is_gone_from_the_book(self) -> None:
        book = [create_order("o", ref(), "ore", OrderSide.BUY, 100, 1, NOW)]
        _, rest = cancel_order(book, "o")
        with pytest.raises(OrderError):
            cancel_order(rest, "o")

    def test_a_fill_totals_what_its_parts_say(self) -> None:
        """The two accessors a caller reaches for first."""
        incoming = create_order("b", ref(), "ore", OrderSide.BUY, 100, 10, NOW)
        book = [create_order("s", ref("bob"), "ore", OrderSide.SELL, 100, 4, NOW)]
        result = match_order(incoming, book)
        assert result.filled_quantity == 4
        assert result.total_consideration == 400

    def test_a_settled_fill_names_both_sides(self, engine) -> None:
        incoming = create_order("b", ref(), "ore", OrderSide.BUY, 100, 1, NOW)
        book = [create_order("s", ref("bob"), "ore", OrderSide.SELL, 100, 1, NOW)]
        fill = match_order(incoming, book).fills[0]
        with pytest.raises(OrderError):
            settle_fill(
                engine,
                fill,
                make_account(ref(), 1_000),
                make_account(ref("eve"), 0),
                NOW,
                "f",
                "x",
            )

    def test_an_exchange_cannot_cross_scopes(self, engine) -> None:
        from economyworld import exchange

        with pytest.raises(ValidationError):
            exchange(
                engine,
                make_account(member_account("g1", "ada", "COIN"), 1_000),
                make_account(member_account("g2", "ada", "GEM"), 0),
                100,
                1,
                1,
                NOW,
                "x",
                "swap",
            )

    def test_an_auction_needs_a_positive_increment(self) -> None:
        with pytest.raises(InvalidAmountError):
            open_auction("a", ref("s"), "sword", "COIN", 100, NOW, LATER, min_increment=0)

    def test_a_settled_auction_settles_once(self, engine) -> None:
        auction = place_bid(
            open_auction("a", ref("s"), "sword", "COIN", 100, NOW, LATER),
            Bid(bidder=ref(), amount=1_000, placed_at=NOW, bid_id="b1"),
            NOW,
        )
        outcome = close_auction(auction, LATER)
        _, settled = settle_auction(
            engine,
            outcome,
            make_account(ref(), 5_000),
            make_account(ref("s"), 0),
            LATER,
            "s1",
            "x",
        )
        from dataclasses import replace

        with pytest.raises(AuctionStateError):
            settle_auction(
                engine,
                replace(outcome, auction=settled),
                make_account(ref(), 5_000),
                make_account(ref("s"), 0),
                LATER,
                "s2",
                "x",
            )

    def test_a_timestamp_is_a_whole_number_of_milliseconds(self) -> None:
        for value in NOT_A_TIMESTAMP:
            with pytest.raises(ValidationError):
                open_auction("a", ref("s"), "sword", "COIN", 100, value, LATER)  # type: ignore[arg-type]


class TestBillingGuards:
    def test_a_plan_needs_an_id(self) -> None:
        with pytest.raises(ScheduleError):
            create_plan("", ref(), ref("guild"), 100, 86_400_000)

    def test_a_subscription_needs_an_id(self) -> None:
        from economyworld import start_subscription

        plan = create_plan("p", ref(), ref("guild"), 100, 86_400_000)
        with pytest.raises(ScheduleError):
            start_subscription("", plan, NOW)

    def test_the_cost_of_credit_is_the_schedule_less_the_cash_price(self, engine) -> None:
        _, financed = finance_purchase(
            engine,
            "f",
            ref(),
            make_account(ref("shop"), 0),
            120_000,
            100,
            12,
            NOW,
            "op",
            "sofa",
        )
        assert financed.cost_of_credit == financed.total_payable - 120_000
        assert financed.cost_of_credit > 0

    def test_a_timestamp_is_a_whole_number_of_milliseconds(self, engine) -> None:
        for value in NOT_A_TIMESTAMP:
            with pytest.raises(ValidationError):
                finance_purchase(
                    engine,
                    "f",
                    ref(),
                    make_account(ref("shop"), 0),
                    1_000,
                    0,
                    2,
                    value,  # type: ignore[arg-type]
                    "op",
                    "x",
                )


class TestFeeGuards:
    def test_a_quote_that_charges_nothing_says_so(self) -> None:
        assert quote_fee(create_fee_rule("free"), 1_000).free
        assert not quote_fee(create_fee_rule("k", flat=1), 1_000).free

    def test_a_flat_fee_is_a_whole_number(self) -> None:
        with pytest.raises((ConfigurationError, InvalidAmountError)):
            create_fee_rule("k", flat=1.5)  # type: ignore[arg-type]


class TestTheLastFewBranches:
    """The refusals and early returns the suites above happen not to reach.

    Kept together rather than scattered, because what they have in common is
    that they are the paths a caller only meets when something has already gone
    wrong -- and those are exactly the paths that must not themselves be wrong.
    """

    def test_a_deposit_with_no_interest_yet_is_charged_no_penalty(self) -> None:
        # The penalty is a share of the interest earned. Nothing earned, nothing
        # to give back.
        from economyworld import early_withdrawal_penalty

        account = open_deposit(
            "d",
            ref(),
            create_deposit_terms(
                rate_basis_points=500, term_ms=86_400_000, early_withdrawal_penalty_bp=5_000
            ),
            NOW,
        )
        assert early_withdrawal_penalty(account, NOW) == 0

    def test_a_subscription_that_has_run_its_course_has_no_next_charge(self, engine) -> None:
        from economyworld import charge_subscription, next_charge_at, start_subscription

        plan = create_plan("p", ref(), ref("guild"), 100, 86_400_000, occurrences=1)
        subscription = start_subscription("s", plan, NOW)
        charged = charge_subscription(
            engine,
            subscription,
            make_account(ref(), 1_000),
            NOW + 86_400_000,
            "c",
            "sub",
        ).subscription
        assert next_charge_at(charged) is None

    def test_a_closed_loan_takes_no_settlement_and_no_late_fee(self, engine) -> None:
        _, loan = open_loan(
            engine,
            "L",
            create_loan_terms(principal=1_000, rate_basis_points=0, periods=1),
            make_account(ref(), 0),
            NOW,
            "o",
            "x",
        )
        settled = settle_early(engine, loan, make_account(ref(), 10_000), NOW, "s", "x").loan
        with pytest.raises(LoanStateError):
            settle_early(engine, settled, make_account(ref(), 10_000), NOW, "s2", "x")

    def test_a_late_fee_after_the_last_instalment_changes_nothing(self, engine) -> None:
        """There is no instalment left to be late for."""
        from dataclasses import replace

        _, loan = open_loan(
            engine,
            "L",
            create_loan_terms(principal=1_000, rate_basis_points=0, periods=2),
            make_account(ref(), 0),
            NOW,
            "o",
            "x",
        )
        past_the_end = replace(loan, paid_instalments=2)
        assert charge_late_fee(past_the_end, 1) is past_the_end

    def test_a_loan_with_nothing_left_to_lose_writes_nothing_off(self, engine) -> None:
        from dataclasses import replace

        from economyworld import LoanState, write_off

        _, loan = open_loan(
            engine,
            "L",
            create_loan_terms(principal=1_000, rate_basis_points=100, periods=2),
            make_account(ref(), 0),
            NOW,
            "o",
            "x",
        )
        # Capital clear, interest not: nothing was issued for the interest, so
        # there is nothing to un-issue.
        clear = replace(loan, principal_outstanding=0, interest_outstanding=5)
        booking, written = write_off(engine, clear, NOW, "w", "x")
        assert booking is None
        assert written.state is LoanState.WRITTEN_OFF
        assert written.total_outstanding == 0

    def test_a_transfer_cannot_take_a_balance_below_the_floor(self, engine) -> None:
        """An overdraft is a permission, not an unlimited one.

        The mint and the sink go arbitrarily negative because that is what they
        are for. A member account with ``allow_negative`` still stops at the
        smallest number both editions can hold, rather than wrapping into
        nonsense.
        """
        from economyworld import MIN_BALANCE, InsufficientFundsError

        source = make_account(ref(), MIN_BALANCE + 1)
        with pytest.raises(InsufficientFundsError):
            engine.transfer(
                source=source,
                target=make_account(ref("bob"), 0),
                amount=100,
                now=NOW,
                operation_id="t",
                reason="x",
                allow_negative=True,
            )

    def test_a_level_payment_on_nothing_is_nothing(self) -> None:
        assert level_payment(0, 500, 12) == 0

    def test_an_instalment_count_is_a_whole_number(self) -> None:
        from economyworld import outstanding_after

        schedule = amortisation_schedule(1_000, 0, 4)
        for value in (1.5, True, "2"):
            with pytest.raises(ValidationError):
                outstanding_after(schedule, value)  # type: ignore[arg-type]

    def test_a_rate_is_a_whole_number_of_basis_points(self) -> None:
        with pytest.raises(RateError):
            amortisation_schedule(1_000, 1.5, 4)  # type: ignore[arg-type]
        with pytest.raises(InvalidAmountError):
            from economyworld import apply_basis_points

            apply_basis_points(1_000, 1.5)  # type: ignore[arg-type]

    def test_a_schedule_whose_totals_disagree_is_refused(self) -> None:
        """Each of the three self-checks, tripped on purpose.

        A schedule is a table a community bills from for a year. If it were ever
        handed back with rows that do not add up, every instalment after the
        first would be wrong and nobody would know which one to trust.
        """
        from dataclasses import replace

        from economyworld.interest import _assert_closes  # noqa: PLC2701 - the check

        schedule = amortisation_schedule(120_000, 100, 12)

        with pytest.raises(RateError):
            _assert_closes(replace(schedule, total_paid=schedule.total_paid + 1))

        first = schedule.instalments[0]
        with pytest.raises(RateError):
            _assert_closes(
                replace(
                    schedule,
                    instalments=(
                        replace(first, interest=first.interest + 1),
                        *schedule.instalments[1:],
                    ),
                )
            )
        with pytest.raises(RateError):
            _assert_closes(
                replace(
                    schedule,
                    instalments=(
                        replace(first, opening_balance=first.opening_balance + 1),
                        *schedule.instalments[1:],
                    ),
                )
            )

    def test_a_posting_line_delta_is_a_whole_number(self) -> None:
        from economyworld.ledger import PostingLine, create_posting

        with pytest.raises(ValidationError):
            create_posting(
                operation_id="x",
                kind=PostingKind.TRANSFER,
                scope="g1",
                currency="COIN",
                amount=100,
                reason="x",
                occurred_at=NOW,
                lines=[
                    PostingLine(ref(), 1.5, 0, 1.5),  # type: ignore[arg-type]
                    PostingLine(ref("bob"), -1.5, 0, -1.5),  # type: ignore[arg-type]
                ],
            )

    def test_a_posting_whose_lines_do_not_sum_to_zero_is_refused(self) -> None:
        """The rule the whole ledger rests on, checked where it is written."""
        from economyworld import UnbalancedPostingError, assert_balanced
        from economyworld.ledger import PostingLine, create_posting

        with pytest.raises(UnbalancedPostingError):
            create_posting(
                operation_id="x",
                kind=PostingKind.TRANSFER,
                scope="g1",
                currency="COIN",
                amount=100,
                reason="x",
                occurred_at=NOW,
                lines=[PostingLine(ref(), -100, 100, 0), PostingLine(ref("bob"), 90, 0, 90)],
            )
        assert assert_balanced is not None

    def test_a_cancelled_order_cannot_be_cancelled_again(self) -> None:
        book = [create_order("o", ref(), "ore", OrderSide.BUY, 100, 1, NOW)]
        cancelled, _ = cancel_order(book, "o")
        with pytest.raises(OrderError):
            cancel_order([cancelled], "o")

    def test_a_closed_auction_takes_no_more_bids(self) -> None:
        auction = open_auction("a", ref("s"), "sword", "COIN", 100, NOW, LATER)
        closed = close_auction(auction, LATER).auction
        with pytest.raises(AuctionStateError):
            place_bid(closed, Bid(ref(), 1_000, NOW, "b"), NOW)

    def test_an_auction_settles_with_the_seller_it_was_opened_for(self, engine) -> None:
        auction = place_bid(
            open_auction("a", ref("s"), "sword", "COIN", 100, NOW, LATER),
            Bid(bidder=ref(), amount=1_000, placed_at=NOW, bid_id="b1"),
            NOW,
        )
        outcome = close_auction(auction, LATER)
        with pytest.raises(AuctionStateError):
            settle_auction(
                engine,
                outcome,
                make_account(ref(), 5_000),
                make_account(ref("eve"), 0),
                LATER,
                "s1",
                "x",
            )

    def test_a_trial_balance_names_the_posting_that_does_not_close(self) -> None:
        from economyworld import assert_books_close
        from economyworld.ledger import Posting, PostingLine

        # Built by hand: create_posting would refuse it, which is the point --
        # a posting this shape can only arrive from a caller's own database.
        broken = Posting(
            operation_id="x",
            kind=PostingKind.TRANSFER,
            scope="g1",
            currency="COIN",
            amount=100,
            reason="x",
            occurred_at=NOW,
            lines=(PostingLine(ref(), -100, 100, 0),),
        )
        with pytest.raises(Exception):  # noqa: B017 - UnbalancedPostingError
            assert_books_close([broken])

    def test_a_shop_can_be_told_to_bank_somewhere_other_than_the_shop(self) -> None:
        """A community that puts sales revenue in the fee pot instead."""
        from economyworld import create_item, create_offer, purchase
        from economyworld.inventory import Inventory

        configured = EconomyEngine(
            currencies=[create_currency("COIN")], shop_account_owner="system:fee"
        )
        result = purchase(
            configured,
            offer=create_offer("o", "potion", 100, "COIN", stock=10),
            item=create_item("potion", max_stack=10),
            buyer=make_account(ref(), 1_000),
            inventory=Inventory(),
            quantity=1,
            now=NOW,
            operation_id="p",
            reason="x",
        )
        fee = system_account("g1", "COIN", SystemAccount.FEE)
        assert result.booking.balances[account_key(fee)] == 100

    def test_a_subscription_stored_at_its_last_charge_has_no_next_one(self) -> None:
        # Reached by a caller reloading a subscription from their own database
        # rather than by charging one: the charge that ends a term also ends
        # the subscription, so this is the reload path.
        from dataclasses import replace

        from economyworld import next_charge_at, start_subscription

        plan = create_plan("p", ref(), ref("guild"), 100, 86_400_000, occurrences=3)
        stored = replace(start_subscription("s", plan, NOW), charges_made=3)
        assert next_charge_at(stored) is None

    def test_a_position_cannot_be_taken_past_the_unit_ceiling(self, engine) -> None:
        from economyworld.instruments import MAX_UNITS

        share = create_instrument("s", InstrumentKind.SHARE, "COIN")
        full = Position(holder=ref(), instrument_id="s", units=MAX_UNITS, cost_basis=0)
        with pytest.raises(InstrumentError):
            buy_units(engine, share, full, make_account(ref(), 10_000), 1, 0, NOW, "b", "x")

    def test_a_posting_that_does_not_balance_is_named_when_asserted(self) -> None:
        from economyworld import UnbalancedPostingError, assert_balanced
        from economyworld.ledger import Posting, PostingLine

        broken = Posting(
            operation_id="x",
            kind=PostingKind.TRANSFER,
            scope="g1",
            currency="COIN",
            amount=100,
            reason="x",
            occurred_at=NOW,
            lines=(PostingLine(ref(), -100, 100, 0),),
        )
        with pytest.raises(UnbalancedPostingError):
            assert_balanced(broken)

    def test_two_postings_can_hide_each_other_in_the_total(self) -> None:
        """Why the trial balance checks each posting as well as the sum.

        Two postings that are each wrong by the same amount in opposite
        directions add up to zero. The sum says the books close; they do not.
        """
        from economyworld import UnbalancedPostingError, assert_books_close, trial_balance
        from economyworld.ledger import Posting, PostingLine

        def posting(operation_id: str, delta: int) -> Posting:
            return Posting(
                operation_id=operation_id,
                kind=PostingKind.TRANSFER,
                scope="g1",
                currency="COIN",
                amount=abs(delta),
                reason="x",
                occurred_at=NOW,
                lines=(PostingLine(ref(), delta, 0, delta),),
            )

        pair = [posting("a", 100), posting("b", -100)]
        result = trial_balance(pair)
        assert result.total == 0
        assert result.unbalanced == ("a", "b")
        assert not result.balances
        with pytest.raises(UnbalancedPostingError):
            assert_books_close(pair)

    def test_an_unrecognised_shop_owner_is_refused_when_the_engine_is_built(self) -> None:
        """Where a scope's takings go is not a thing to get wrong quietly.

        Redirecting them to the shop account anyway, or inventing an account no
        report knows about, both hide the mistake until somebody asks where the
        money went. The engine says so at startup instead.
        """
        with pytest.raises(ConfigurationError):
            EconomyEngine(
                currencies=[create_currency("COIN")],
                shop_account_owner="system:not-a-thing",
            )

    def test_a_tier_rate_is_a_whole_number(self) -> None:
        from economyworld import create_tier

        for value in (1.5, True, "100"):
            with pytest.raises(ConfigurationError):
                create_tier(0, value)  # type: ignore[arg-type]

    def test_a_trade_that_names_an_item_nobody_supplied_is_refused(self, engine) -> None:
        """Settling on an item the caller did not hand over would invent one."""
        from economyworld import (
            ItemError,
            TradeSide,
            accept_trade,
            create_item,
            propose_trade,
            settle_trade,
        )
        from economyworld.inventory import Inventory, InventorySlot

        trade = propose_trade(
            trade_id="t",
            scope="g1",
            currency="COIN",
            left=TradeSide("ada", 0, (InventorySlot("sword", 1),)),
            right=TradeSide("bob", 0, (InventorySlot("shield", 1),)),
            now=NOW,
        )
        accepted = accept_trade(accept_trade(trade, "ada", NOW), "bob", NOW)
        with pytest.raises(ItemError):
            settle_trade(
                engine,
                trade=accepted,
                left_account=make_account(ref("ada"), 0),
                right_account=make_account(ref("bob"), 1_000),
                left_inventory=Inventory([InventorySlot("sword", 1)]),
                right_inventory=Inventory([InventorySlot("shield", 1)]),
                # The sword is supplied and the shield is not, so the removals
                # succeed and the addition is where it falls over.
                items={"sword": create_item("sword", stackable=False)},
                now=NOW,
                operation_id="s",
                reason="x",
            )
