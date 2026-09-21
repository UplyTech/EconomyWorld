"""Interest accrual and amortisation schedules."""

from __future__ import annotations

import pytest

from economyworld import (
    MAX_BALANCE,
    AccrualBasis,
    AmortisationMethod,
    RateError,
    Rounding,
    ValidationError,
    accrue_interest,
    amortisation_schedule,
    level_payment,
    outstanding_after,
    project_balance,
    total_interest,
)
from economyworld.interest import MAX_PERIODS

METHODS = list(AmortisationMethod)


class TestAccrual:
    def test_one_period_is_the_rate(self) -> None:
        assert accrue_interest(10_000, 500, 1) == 500

    def test_compounding_charges_interest_on_interest(self) -> None:
        # 10,000 -> 10,500 -> 11,025. The second period's 525 is 5 % of 10,500,
        # not of 10,000.
        assert accrue_interest(10_000, 500, 2) == 1025

    def test_simple_interest_does_not(self) -> None:
        assert accrue_interest(10_000, 500, 2, AccrualBasis.SIMPLE) == 1000
        assert accrue_interest(10_000, 500, 10, AccrualBasis.SIMPLE) == 5000

    def test_nothing_accrues_at_a_zero_rate_or_over_no_periods(self) -> None:
        assert accrue_interest(10_000, 0, 12) == 0
        assert accrue_interest(10_000, 500, 0) == 0
        assert accrue_interest(0, 500, 12) == 0

    def test_a_rate_too_small_to_earn_a_unit_earns_nothing(self) -> None:
        # 1 basis point of 100 is a hundredth of a unit. Rounding down, that is
        # nothing -- and a member who watches their balance not move deserves
        # the honest answer rather than a rounded-up one.
        assert accrue_interest(100, 1, 1) == 0
        assert accrue_interest(100, 1, 1, rounding=Rounding.UP) == 1

    def test_period_by_period_differs_from_the_closed_form(self) -> None:
        """The reason this package iterates rather than using a formula.

        ``P * (1 + r)^n`` compounds fractions of a unit that were never credited
        to anybody. Charging whole units each period gives a different -- and
        checkable -- answer.
        """
        iterated = project_balance(1_000, 333, 10)
        closed_form = round(1_000 * (1.0333**10))
        assert iterated != closed_form
        assert abs(iterated - closed_form) < 20  # close, but not the same

    def test_projection_is_accrual_plus_principal(self) -> None:
        for periods in (0, 1, 5, 50):
            assert project_balance(7_777, 250, periods) == 7_777 + accrue_interest(
                7_777, 250, periods
            )

    def test_refuses_impossible_input(self) -> None:
        with pytest.raises(RateError):
            accrue_interest(-1, 500, 1)
        with pytest.raises(RateError):
            accrue_interest(100, -1, 1)
        with pytest.raises(RateError):
            accrue_interest(100, 500, -1)
        with pytest.raises(RateError):
            accrue_interest(100, 500, MAX_PERIODS + 1)

    def test_refuses_a_rate_that_is_a_bug(self) -> None:
        with pytest.raises(RateError):
            accrue_interest(100, 1_000_001, 1)

    def test_refuses_to_compound_past_the_ceiling(self) -> None:
        with pytest.raises(Exception):  # noqa: B017 - InvalidAmountError from money
            project_balance(MAX_BALANCE // 2, 10_000, 10)


class TestLevelPayment:
    def test_the_documented_example(self) -> None:
        assert level_payment(120_000, 100, 12) == 10_662

    def test_agrees_with_the_schedule_it_builds(self) -> None:
        # The two entry points must not disagree about what an instalment is.
        for principal in (1_000, 120_000, 987_654):
            for rate in (0, 100, 250, 1000):
                for periods in (1, 6, 12, 60):
                    schedule = amortisation_schedule(principal, rate, periods)
                    assert (
                        schedule.instalments[0].payment
                        == level_payment(principal, rate, periods)
                        or schedule.instalments[0].payment
                        == schedule.instalments[0].opening_balance
                        + schedule.instalments[0].interest
                    )

    def test_a_zero_rate_is_the_principal_split(self) -> None:
        assert level_payment(1200, 0, 12) == 100

    def test_is_the_smallest_payment_that_works(self) -> None:
        # One less must fail to clear the loan; that is what "smallest" means.
        from economyworld.interest import _clears  # noqa: PLC2701 - the definition

        payment = level_payment(120_000, 100, 12)
        assert _clears(120_000, 100, 12, payment, Rounding.DOWN)
        assert not _clears(120_000, 100, 12, payment - 1, Rounding.DOWN)

    def test_a_payment_too_small_to_cover_interest_is_refused_not_hung(self) -> None:
        """The search must terminate even where no payment can ever clear.

        The binary search starts at a payment of one. Without the early exit the
        simulation compounds its way past the ceiling and raises, on the way to
        an answer that was only ever going to be "no".
        """
        assert level_payment(1_000_000, 5_000, 1) > 0

    def test_the_midpoint_cannot_overflow(self) -> None:
        """A principal near the ceiling used to hang the TypeScript edition.

        ``(low + high) / 2`` adds two amounts that are each inside the safe
        range and whose sum is not. Both editions now compute
        ``low + (high - low) / 2`` instead.
        """
        assert level_payment(5_608_265_016_672_255, 0, 1) == 5_608_265_016_672_255

    def test_refuses_a_simulation_that_leaves_the_shared_range(self) -> None:
        """The second thing the differential harness found in one afternoon.

        ``balance + interest`` can leave the range a JavaScript number holds
        exactly while the principal, the interest and the answer all sit inside
        it. Python would keep simulating, exactly, and return a payment the
        other edition disagrees with by a unit -- which is not a difference a
        borrower should discover. Both editions refuse instead.
        """
        with pytest.raises(RateError):
            level_payment(9_007_199_254_737_658, 500, 360)
        with pytest.raises(RateError):
            level_payment(8_873_473_065_615_359, 1000, 12)

    def test_the_narrower_bracket_finds_the_same_payment(self) -> None:
        """The search bracket is proved, not guessed, and it moved no answer.

        ``low`` is ``principal / periods`` because ``n`` payments must come to
        at least the principal; ``high`` is that plus one period's interest on
        the whole principal, which always clears. Narrowing it from "one to the
        whole debt" cut about six bisection steps and changed nothing, which is
        the only acceptable outcome for a performance change here.
        """
        from economyworld.interest import _clears  # noqa: PLC2701 - the definition

        for principal in (1, 7, 1_000, 120_000, 987_654_321):
            for rate in (0, 1, 100, 250, 1000, 5000):
                for periods in (1, 2, 12, 60, 360):
                    payment = level_payment(principal, rate, periods)
                    assert _clears(principal, rate, periods, payment, Rounding.DOWN)
                    if payment > 1:
                        assert not _clears(
                            principal, rate, periods, payment - 1, Rounding.DOWN
                        )

    def test_refuses_zero_periods(self) -> None:
        with pytest.raises(RateError):
            level_payment(1000, 100, 0)


class TestSchedules:
    @pytest.mark.parametrize("method", METHODS)
    def test_every_schedule_closes_at_zero(self, method: AmortisationMethod) -> None:
        for principal in (1, 7, 1000, 120_000, 987_654_321):
            for rate in (0, 1, 250, 1000):
                for periods in (1, 2, 12, 60):
                    schedule = amortisation_schedule(principal, rate, periods, method)
                    assert schedule.instalments[-1].closing_balance == 0

    @pytest.mark.parametrize("method", METHODS)
    def test_the_payments_add_up_exactly(self, method: AmortisationMethod) -> None:
        for principal in (1, 7, 1000, 120_000, 987_654_321):
            for rate in (0, 1, 250, 1000):
                for periods in (1, 2, 12, 60):
                    schedule = amortisation_schedule(principal, rate, periods, method)
                    assert schedule.total_paid == principal + schedule.total_interest
                    assert (
                        sum(row.payment for row in schedule.instalments) == schedule.total_paid
                    )

    @pytest.mark.parametrize("method", METHODS)
    def test_every_row_adds_up(self, method: AmortisationMethod) -> None:
        schedule = amortisation_schedule(100_000, 250, 6, method)
        for row in schedule.instalments:
            assert row.interest + row.principal == row.payment
            assert row.opening_balance + row.interest - row.payment == row.closing_balance

    def test_equal_instalment_is_level_except_the_last(self) -> None:
        schedule = amortisation_schedule(100_000, 250, 6)
        payments = [row.payment for row in schedule.instalments]
        assert len(set(payments[:-1])) == 1
        # The last absorbs the rounding, which is what a real lender does.
        assert payments[-1] != payments[0]

    def test_equal_principal_falls_over_the_term(self) -> None:
        schedule = amortisation_schedule(100_000, 250, 6, AmortisationMethod.EQUAL_PRINCIPAL)
        payments = [row.payment for row in schedule.instalments]
        assert payments == sorted(payments, reverse=True)

    def test_interest_only_defers_the_whole_principal(self) -> None:
        schedule = amortisation_schedule(100_000, 250, 6, AmortisationMethod.INTEREST_ONLY)
        assert all(row.principal == 0 for row in schedule.instalments[:-1])
        assert schedule.instalments[-1].principal == 100_000

    def test_equal_principal_costs_less_than_equal_instalment(self) -> None:
        # Because the debt falls faster. Worth pinning down: it is the reason a
        # community might offer both.
        level = total_interest(100_000, 250, 6, AmortisationMethod.EQUAL_INSTALMENT)
        linear = total_interest(100_000, 250, 6, AmortisationMethod.EQUAL_PRINCIPAL)
        balloon = total_interest(100_000, 250, 6, AmortisationMethod.INTEREST_ONLY)
        assert linear < level < balloon

    def test_a_zero_rate_costs_nothing(self) -> None:
        for method in METHODS:
            schedule = amortisation_schedule(1200, 0, 12, method)
            assert schedule.total_interest == 0
            assert schedule.total_paid == 1200

    def test_refuses_a_schedule_whose_totals_leave_the_shared_range(self) -> None:
        """A big principal at a real rate adds up to more than either edition holds.

        Every instalment stays inside the range; the total does not. Python
        would return the exact figure and JavaScript a rounded one, so both
        refuse -- see the 2.0.0 changelog.
        """
        with pytest.raises(RateError):
            amortisation_schedule(
                9_007_199_254_740_084, 2500, 2, AmortisationMethod.INTEREST_ONLY
            )

    def test_refuses_zero_periods(self) -> None:
        with pytest.raises(RateError):
            amortisation_schedule(1000, 100, 0)


class TestOutstandingAfter:
    def test_reads_the_schedule_rather_than_recomputing(self) -> None:
        schedule = amortisation_schedule(120_000, 100, 12)
        assert outstanding_after(schedule, 0) == 120_000
        assert outstanding_after(schedule, 12) == 0
        assert outstanding_after(schedule, 20) == 0
        assert outstanding_after(schedule, 1) == schedule.instalments[0].closing_balance

    def test_refuses_a_negative_count(self) -> None:
        schedule = amortisation_schedule(120_000, 100, 12)
        with pytest.raises(ValidationError):
            outstanding_after(schedule, -1)
