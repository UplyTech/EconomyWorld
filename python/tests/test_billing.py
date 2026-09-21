"""Subscriptions, financed purchases and payroll."""

from __future__ import annotations

import pytest

from economyworld import (
    AmortisationMethod,
    CurrencyMismatchError,
    EconomyEngine,
    InsufficientFundsError,
    InvalidAmountError,
    PostingKind,
    ScheduleError,
    ScheduleState,
    SystemAccount,
    ValidationError,
    account_key,
    cancel_subscription,
    charge_subscription,
    charges_due,
    create_currency,
    create_plan,
    finance_purchase,
    make_account,
    member_account,
    next_charge_at,
    pause_subscription,
    resume_subscription,
    run_payroll,
    split_payroll,
    start_subscription,
    system_account,
)
from economyworld.billing import MAX_CATCH_UP, PayrollLine

NOW = 1_700_000_000_000
DAY = 86_400_000


@pytest.fixture
def engine() -> EconomyEngine:
    return EconomyEngine(currencies=[create_currency("COIN"), create_currency("GEM")])


def ref(name: str, currency: str = "COIN"):
    return member_account("g1", name, currency)


def plan(**overrides):
    base = {
        "plan_id": "p1",
        "payer": ref("ada"),
        "payee": ref("guild"),
        "amount": 100,
        "interval_ms": DAY,
    }
    base.update(overrides)
    return create_plan(**base)


def subscription(**overrides):
    return start_subscription("s1", plan(**overrides), NOW)


class TestPlans:
    def test_refuses_a_plan_that_charges_nothing_or_never(self) -> None:
        with pytest.raises(InvalidAmountError):
            plan(amount=0)
        with pytest.raises((ScheduleError, ValidationError)):
            plan(interval_ms=0)

    def test_refuses_paying_yourself(self) -> None:
        with pytest.raises(ScheduleError):
            plan(payee=ref("ada"))

    def test_refuses_crossing_currencies(self) -> None:
        with pytest.raises(CurrencyMismatchError):
            plan(payee=ref("guild", "GEM"))

    def test_refuses_a_negative_occurrence_count(self) -> None:
        with pytest.raises((ScheduleError, ValidationError)):
            plan(occurrences=0)

    def test_a_new_subscription_is_active_and_owes_nothing(self) -> None:
        sub = subscription()
        assert sub.state is ScheduleState.ACTIVE
        assert sub.charges_made == 0
        assert charges_due(sub, NOW) == 0


class TestChargesDue:
    def test_one_charge_falls_due_each_interval(self) -> None:
        sub = subscription()
        assert charges_due(sub, NOW + DAY - 1) == 0
        assert charges_due(sub, NOW + DAY) == 1
        assert charges_due(sub, NOW + 3 * DAY) == 3

    def test_asking_twice_gives_the_same_answer(self) -> None:
        """A scheduler that runs every minute must not bill every minute."""
        sub = subscription()
        assert charges_due(sub, NOW + DAY) == charges_due(sub, NOW + DAY) == 1

    def test_a_fixed_term_stops_owing_at_the_end(self) -> None:
        sub = subscription(occurrences=3)
        assert charges_due(sub, NOW + 10 * DAY) == 3

    def test_a_clock_that_went_backwards_owes_nothing(self) -> None:
        assert charges_due(subscription(), NOW - DAY) == 0

    def test_the_next_charge_is_one_interval_after_the_last(self) -> None:
        sub = subscription()
        assert next_charge_at(sub) == NOW + DAY

    def test_a_finished_term_has_no_next_charge(self, engine) -> None:
        sub = subscription(occurrences=1)
        result = charge_subscription(
            engine, sub, make_account(ref("ada"), 1_000), NOW + DAY, "c1", "sub"
        )
        assert result.subscription.state is ScheduleState.ENDED
        assert next_charge_at(result.subscription) is None


class TestCharging:
    def test_a_charge_moves_the_money_to_the_payee(self, engine) -> None:
        result = charge_subscription(
            engine, subscription(), make_account(ref("ada"), 1_000), NOW + DAY, "c1", "sub"
        )
        assert result.charges == 1
        assert result.amount == 100
        assert result.booking.posting.kind is PostingKind.RECURRING
        assert result.booking.balances[account_key(ref("ada"))] == 900
        assert result.booking.balances[account_key(ref("guild"))] == 100

    def test_missed_intervals_are_caught_up_in_one_posting(self, engine) -> None:
        """Three missed weeks is one payment of three times the amount.

        One posting is what a member sees on a statement, and what a single
        operation id can make idempotent.
        """
        result = charge_subscription(
            engine, subscription(), make_account(ref("ada"), 1_000), NOW + 3 * DAY, "c1", "sub"
        )
        assert result.charges == 3
        assert result.amount == 300
        assert result.subscription.charges_made == 3
        assert result.subscription.total_charged == 300

    def test_a_limit_takes_them_one_at_a_time(self, engine) -> None:
        sub = subscription()
        payer = make_account(ref("ada"), 1_000)
        result = charge_subscription(engine, sub, payer, NOW + 3 * DAY, "c1", "sub", limit=1)
        assert result.charges == 1
        assert charges_due(result.subscription, NOW + 3 * DAY) == 2

    def test_nothing_due_books_nothing(self, engine) -> None:
        # The normal result of a scheduler running more often than the interval.
        result = charge_subscription(
            engine, subscription(), make_account(ref("ada"), 1_000), NOW, "c1", "sub"
        )
        assert result.booking is None
        assert result.charges == 0
        assert result.amount == 0

    def test_a_gap_too_big_to_bill_is_a_decision_not_a_charge(self, engine) -> None:
        """Coming back after a year should not empty an account in silence."""
        sub = subscription()
        with pytest.raises(ScheduleError) as caught:
            charge_subscription(
                engine,
                sub,
                make_account(ref("ada"), 100_000_000),
                NOW + (MAX_CATCH_UP + 1) * DAY,
                "c1",
                "sub",
            )
        assert caught.value.details["limit"] == MAX_CATCH_UP

    def test_a_payer_without_the_money_is_refused(self, engine) -> None:
        with pytest.raises(InsufficientFundsError):
            charge_subscription(
                engine, subscription(), make_account(ref("ada"), 10), NOW + DAY, "c1", "sub"
            )

    def test_the_account_must_be_the_payer(self, engine) -> None:
        with pytest.raises(ScheduleError):
            charge_subscription(
                engine, subscription(), make_account(ref("eve"), 1_000), NOW + DAY, "c1", "sub"
            )

    def test_refuses_a_limit_that_is_not_a_positive_count(self, engine) -> None:
        for limit in (0, -1):
            with pytest.raises(ValidationError):
                charge_subscription(
                    engine,
                    subscription(),
                    make_account(ref("ada"), 1_000),
                    NOW + DAY,
                    "c1",
                    "sub",
                    limit=limit,
                )

    def test_a_fixed_term_never_charges_more_than_its_occurrences(self, engine) -> None:
        sub = subscription(occurrences=2)
        result = charge_subscription(
            engine, sub, make_account(ref("ada"), 10_000), NOW + 99 * DAY, "c1", "sub"
        )
        assert result.charges == 2
        assert result.subscription.state is ScheduleState.ENDED
        again = charge_subscription(
            engine,
            result.subscription,
            make_account(ref("ada"), 10_000),
            NOW + 200 * DAY,
            "c2",
            "sub",
        )
        assert again.charges == 0


class TestPauseAndCancel:
    def test_a_pause_is_not_a_postponement(self, engine) -> None:
        """A member who pauses for a month is not billed for the month.

        Remembering the paused time is what separates pausing from deferring;
        without it the bill arrives anyway, just later.
        """
        sub = subscription()
        sub = pause_subscription(sub, NOW + DAY // 2)
        assert charges_due(sub, NOW + 10 * DAY) == 0
        sub = resume_subscription(sub, NOW + 10 * DAY)
        # Half a day had been earned before the pause; half a day after resuming
        # completes the first interval and no more.
        assert charges_due(sub, NOW + 10 * DAY + DAY // 2) == 1

    def test_only_an_active_subscription_pauses_and_only_a_paused_one_resumes(self) -> None:
        sub = subscription()
        with pytest.raises(ScheduleError):
            resume_subscription(sub, NOW)
        paused = pause_subscription(sub, NOW)
        with pytest.raises(ScheduleError):
            pause_subscription(paused, NOW)

    def test_a_paused_subscription_charges_nothing(self, engine) -> None:
        sub = pause_subscription(subscription(), NOW)
        result = charge_subscription(
            engine, sub, make_account(ref("ada"), 1_000), NOW + 5 * DAY, "c1", "sub"
        )
        assert result.booking is None

    def test_cancelling_stops_it_for_good(self) -> None:
        sub = cancel_subscription(subscription(), NOW + DAY)
        assert sub.state is ScheduleState.CANCELLED
        assert charges_due(sub, NOW + 10 * DAY) == 0
        with pytest.raises(ScheduleError):
            cancel_subscription(sub, NOW + DAY)

    def test_a_cancelled_subscription_has_no_next_charge(self) -> None:
        assert next_charge_at(cancel_subscription(subscription(), NOW)) is None


class TestFinancing:
    def test_the_seller_is_paid_in_full_and_the_buyer_pays_nothing_yet(self, engine) -> None:
        """That is the point of financing, and it is why credit funds it."""
        booking, financed = finance_purchase(
            engine,
            "f1",
            ref("ada"),
            make_account(ref("shop"), 0),
            120_000,
            100,
            12,
            NOW,
            "op1",
            "sofa",
        )
        assert booking.posting.kind is PostingKind.LOAN_DISBURSEMENT
        assert booking.balances[account_key(ref("shop"))] == 120_000
        credit = system_account("g1", "COIN", SystemAccount.CREDIT)
        assert booking.balances[account_key(credit)] == -120_000
        assert account_key(ref("ada")) not in booking.balances
        assert financed.cash_price == 120_000
        assert len(financed.schedule.instalments) == 12

    def test_the_schedule_costs_more_than_the_goods_at_a_rate(self, engine) -> None:
        _, financed = finance_purchase(
            engine,
            "f1",
            ref("ada"),
            make_account(ref("shop"), 0),
            120_000,
            100,
            12,
            NOW,
            "op1",
            "x",
        )
        assert financed.total_payable > 120_000
        assert financed.total_payable == financed.schedule.total_paid

    def test_interest_free_credit_costs_the_cash_price(self, engine) -> None:
        _, financed = finance_purchase(
            engine,
            "f1",
            ref("ada"),
            make_account(ref("shop"), 0),
            1_200,
            0,
            12,
            NOW,
            "op1",
            "x",
        )
        assert financed.total_payable == 1_200

    def test_every_method_is_available_to_a_purchase(self, engine) -> None:
        for method in AmortisationMethod:
            _, financed = finance_purchase(
                engine,
                "f1",
                ref("ada"),
                make_account(ref("shop"), 0),
                120_000,
                100,
                12,
                NOW,
                "op1",
                "x",
                method=method,
            )
            assert financed.schedule.instalments[-1].closing_balance == 0

    def test_refuses_financing_from_yourself_and_across_currencies(self, engine) -> None:
        with pytest.raises(ScheduleError):
            finance_purchase(
                engine,
                "f1",
                ref("ada"),
                make_account(ref("ada"), 0),
                100,
                0,
                2,
                NOW,
                "op1",
                "x",
            )
        with pytest.raises(CurrencyMismatchError):
            finance_purchase(
                engine,
                "f1",
                ref("ada", "GEM"),
                make_account(ref("shop"), 0),
                100,
                0,
                2,
                NOW,
                "op1",
                "x",
            )


class TestPayroll:
    def lines(self, *pairs):
        return [PayrollLine(recipient=ref(name), amount=amount) for name, amount in pairs]

    def test_a_run_is_one_posting_with_a_line_each(self, engine) -> None:
        """Half a payroll is the worst possible outcome, so there is no half."""
        employer = make_account(ref("guild"), 10_000)
        booking = run_payroll(
            engine, employer, self.lines(("ada", 300), ("bob", 200)), NOW, "p1", "wages"
        )
        assert booking.posting.amount == 500
        assert len(booking.posting.lines) == 3
        assert booking.balances[account_key(ref("guild"))] == 9_500
        assert booking.balances[account_key(ref("ada"))] == 300
        assert booking.balances[account_key(ref("bob"))] == 200

    def test_the_lines_of_the_posting_sum_to_zero(self, engine) -> None:
        employer = make_account(ref("guild"), 10_000)
        booking = run_payroll(
            engine, employer, self.lines(("ada", 1), ("bob", 2), ("cat", 3)), NOW, "p1", "w"
        )
        assert sum(line.delta for line in booking.posting.lines) == 0

    def test_known_balances_are_carried_into_the_posting(self, engine) -> None:
        employer = make_account(ref("guild"), 10_000)
        known = {account_key(ref("ada")): make_account(ref("ada"), 50)}
        booking = run_payroll(
            engine, employer, self.lines(("ada", 300)), NOW, "p1", "w", recipients=known
        )
        assert booking.balances[account_key(ref("ada"))] == 350

    def test_an_employer_who_cannot_afford_it_pays_nobody(self, engine) -> None:
        employer = make_account(ref("guild"), 100)
        with pytest.raises(InsufficientFundsError):
            run_payroll(
                engine, employer, self.lines(("ada", 300), ("bob", 200)), NOW, "p1", "w"
            )

    def test_refuses_an_empty_run_a_self_payment_and_a_repeated_recipient(
        self, engine
    ) -> None:
        employer = make_account(ref("guild"), 10_000)
        with pytest.raises(ScheduleError):
            run_payroll(engine, employer, [], NOW, "p1", "w")
        with pytest.raises(ScheduleError):
            run_payroll(engine, employer, self.lines(("guild", 100)), NOW, "p1", "w")
        with pytest.raises(ScheduleError):
            run_payroll(
                engine, employer, self.lines(("ada", 100), ("ada", 200)), NOW, "p1", "w"
            )

    def test_refuses_a_run_that_crosses_currencies_or_scopes(self, engine) -> None:
        employer = make_account(ref("guild"), 10_000)
        with pytest.raises(CurrencyMismatchError):
            run_payroll(
                engine,
                employer,
                [PayrollLine(recipient=ref("ada", "GEM"), amount=100)],
                NOW,
                "p1",
                "w",
            )
        with pytest.raises(ValidationError):
            run_payroll(
                engine,
                employer,
                [PayrollLine(recipient=member_account("g2", "ada", "COIN"), amount=100)],
                NOW,
                "p1",
                "w",
            )

    def test_a_split_pot_adds_up_to_the_pot(self) -> None:
        recipients = [ref("ada"), ref("bob"), ref("cat")]
        for total in (0, 1, 2, 10, 1_000, 99_999):
            lines = split_payroll(total, recipients)
            assert sum(line.amount for line in lines) == total

    def test_a_split_can_be_weighted(self) -> None:
        lines = split_payroll(1_000, [ref("ada"), ref("bob")], [3, 1])
        assert [line.amount for line in lines] == [750, 250]

    def test_a_share_of_nothing_is_left_out_rather_than_paid_zero(self) -> None:
        # A zero-amount line would be a posting line that moves nothing.
        lines = split_payroll(1, [ref("ada"), ref("bob")])
        assert len(lines) == 1

    def test_a_split_with_nobody_to_pay_is_an_error(self) -> None:
        with pytest.raises(ScheduleError):
            split_payroll(100, [])

    def test_a_split_pot_can_be_run_straight_through_payroll(self, engine) -> None:
        employer = make_account(ref("guild"), 10_000)
        lines = split_payroll(1_000, [ref("ada"), ref("bob"), ref("cat")])
        booking = run_payroll(engine, employer, lines, NOW, "p1", "share")
        assert booking.posting.amount == 1_000
        assert booking.balances[account_key(ref("guild"))] == 9_000
