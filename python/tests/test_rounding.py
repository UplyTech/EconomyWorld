"""Rounding, rate application and exact splitting.

The arithmetic every financial subsystem stands on, and the place the 1.x
editions disagreed: ``apply_permille`` multiplied before it divided, and for
821 of 14,443 sampled amounts the product passed 2^53 and the two editions
returned different balances.
"""

from __future__ import annotations

import pytest

from economyworld import (
    MAX_BALANCE,
    InvalidAmountError,
    Rounding,
    ValidationError,
    apply_basis_points,
    apply_permille,
    apply_rate,
    distribute,
    distribute_evenly,
    divide_rounded,
)


class TestDivideRounded:
    @pytest.mark.parametrize(
        ("mode", "expected"),
        [
            (Rounding.DOWN, 3),
            (Rounding.UP, 4),
            (Rounding.HALF_UP, 4),
            (Rounding.HALF_EVEN, 4),
        ],
    )
    def test_seven_halves(self, mode: Rounding, expected: int) -> None:
        assert divide_rounded(7, 2, mode) == expected

    @pytest.mark.parametrize(
        ("mode", "expected"),
        [
            (Rounding.DOWN, 2),
            (Rounding.UP, 3),
            (Rounding.HALF_UP, 3),
            (Rounding.HALF_EVEN, 2),
        ],
    )
    def test_five_halves_shows_half_even_apart(self, mode: Rounding, expected: int) -> None:
        # 5/2 is exactly halfway. HALF_UP goes away from zero; HALF_EVEN goes to
        # the even neighbour, which is the whole reason accountants prefer it.
        assert divide_rounded(5, 2, mode) == expected

    def test_is_symmetric_about_zero(self) -> None:
        # DOWN means towards zero, not towards minus infinity. A refund of a fee
        # is then the same size as the fee.
        for mode in Rounding:
            for numerator in range(-50, 51):
                for denominator in (1, 2, 3, 7, 10):
                    assert divide_rounded(numerator, denominator, mode) == -divide_rounded(
                        -numerator, denominator, mode
                    ), (mode, numerator, denominator)

    def test_is_not_python_floor_division(self) -> None:
        # The distinction that makes the symmetry work: -7 // 2 is -4.
        assert -7 // 2 == -4
        assert divide_rounded(-7, 2, Rounding.DOWN) == -3

    def test_exact_division_never_rounds(self) -> None:
        for mode in Rounding:
            assert divide_rounded(100, 4, mode) == 25
            assert divide_rounded(-100, 4, mode) == -25

    def test_negative_denominator(self) -> None:
        assert divide_rounded(7, -2, Rounding.DOWN) == -3
        assert divide_rounded(-7, -2, Rounding.DOWN) == 3

    def test_refuses_zero_and_non_integers(self) -> None:
        with pytest.raises(ValidationError):
            divide_rounded(1, 0)
        with pytest.raises(ValidationError):
            divide_rounded(1.5, 2)  # type: ignore[arg-type]
        with pytest.raises(ValidationError):
            divide_rounded(1, 2.5)  # type: ignore[arg-type]

    def test_never_returns_negative_zero(self) -> None:
        # Python has no -0 for integers; the TypeScript edition does, and a
        # number the two editions spell differently is the failure this package
        # exists to prevent.
        assert divide_rounded(-1, 2, Rounding.DOWN) == 0
        assert str(divide_rounded(-1, 2, Rounding.DOWN)) == "0"


class TestTheDivisionThatWasWrong:
    """`Math.floor(a / b)` is not integer division, and this is where it showed.

    Found by the differential harness. IEEE division is correctly rounded to
    the nearest *double*, and near 2^53 the nearest double can sit on the wrong
    side of an integer -- so the TypeScript edition's floor came back one too
    low, and the remainder computed from it was then nonsense. Python was right
    all along, which is exactly why a Python-only test would never have caught
    it: these cases exist to keep the *other* edition honest.
    """

    def test_the_case_the_harness_found(self) -> None:
        assert divide_rounded(9_007_199_254_737_658, 360) == 25_019_997_929_826

    def test_a_sweep_of_divisors_near_the_ceiling(self) -> None:
        # Every one of these is exact in Python by construction. The point is
        # that the same numbers are in the shared vectors, so the TypeScript
        # edition has to reproduce them.
        for numerator in (
            MAX_BALANCE,
            MAX_BALANCE - 1,
            MAX_BALANCE - 333,
            9_007_199_254_737_658,
        ):
            for denominator in (3, 7, 12, 360, 9973):
                expected = numerator // denominator
                assert divide_rounded(numerator, denominator) == expected
                assert divide_rounded(-numerator, denominator) == -expected

    def test_the_remainder_still_decides_the_rounding(self) -> None:
        # The bug was not only in the quotient: a wrong quotient gives a wrong
        # remainder, and every mode but DOWN reads the remainder.
        numerator, denominator = 9_007_199_254_737_658, 360
        exact, remainder = divmod(numerator, denominator)
        assert divide_rounded(numerator, denominator, Rounding.UP) == exact + 1
        assert divide_rounded(numerator, denominator, Rounding.HALF_UP) == (
            exact + 1 if remainder * 2 >= denominator else exact
        )


class TestApplyBasisPoints:
    def test_two_and_a_half_percent(self) -> None:
        assert apply_basis_points(10_000, 250) == 250

    def test_a_basis_point_is_a_hundredth_of_a_percent(self) -> None:
        assert apply_basis_points(1_000_000, 1) == 100

    def test_the_rounding_mode_is_the_caller_s(self) -> None:
        assert apply_basis_points(1001, 250, Rounding.DOWN) == 25
        assert apply_basis_points(1001, 250, Rounding.UP) == 26

    def test_stays_exact_past_the_double_boundary(self) -> None:
        # amount * basis_points passes 2^53 while the amount and the answer
        # both stay comfortably inside it. This is the 1.x divergence.
        amount = 9_007_199_254_740_000
        assert apply_basis_points(amount, 10_000) == amount
        assert apply_basis_points(amount, 5_000) == amount // 2

    def test_refuses_an_answer_outside_the_shared_range(self) -> None:
        with pytest.raises(InvalidAmountError):
            apply_basis_points(MAX_BALANCE, 20_000)

    def test_refuses_a_negative_rate(self) -> None:
        with pytest.raises(InvalidAmountError):
            apply_basis_points(100, -1)


class TestApplyPermille:
    def test_applies_a_chain_in_order(self) -> None:
        # floor(floor(x*a)*b) is not always floor(floor(x*b)*a), which is why
        # the order is part of the contract.
        assert apply_permille(1000, [1500, 1500]) == 2250

    def test_stays_exact_past_the_double_boundary(self) -> None:
        assert apply_permille(9_007_199_254_740_991, [1000]) == 9_007_199_254_740_991
        assert apply_permille(9_007_199_254_740_991, [500]) == 4_503_599_627_370_495

    def test_refuses_an_answer_outside_the_shared_range(self) -> None:
        with pytest.raises(InvalidAmountError):
            apply_permille(MAX_BALANCE, [2000])

    def test_refuses_a_negative_factor(self) -> None:
        with pytest.raises(InvalidAmountError):
            apply_permille(100, [-1])


class TestApplyRate:
    def test_is_the_general_form(self) -> None:
        assert apply_rate(1000, 1, 3) == 333
        assert apply_rate(1000, 1, 3, Rounding.UP) == 334

    def test_refuses_a_non_positive_denominator(self) -> None:
        with pytest.raises(InvalidAmountError):
            apply_rate(100, 1, 0)
        with pytest.raises(InvalidAmountError):
            apply_rate(100, 1, -3)


class TestDistribute:
    def test_shares_add_up_to_the_amount(self) -> None:
        assert distribute(1000, [1, 1, 1]) == [334, 333, 333]
        assert sum(distribute(1000, [1, 1, 1])) == 1000

    def test_weights_are_respected(self) -> None:
        assert distribute(100, [1, 2, 7]) == [10, 20, 70]

    def test_nothing_is_ever_lost(self) -> None:
        """The property the naive version breaks.

        Three people splitting a prize is where a community loses a unit of
        currency, every time, until somebody notices the books are out.
        """
        for amount in range(0, 500):
            for weights in ([1, 1, 1], [1, 2, 3], [7], [0, 1, 0, 1], [5, 5, 5, 5, 5, 5, 5]):
                shares = distribute(amount, weights)
                assert sum(shares) == amount, (amount, weights)
                assert len(shares) == len(weights)

    def test_ties_are_broken_by_position(self) -> None:
        # Any rule would do; what matters is that both editions use the same
        # one and that it does not depend on iteration order.
        assert distribute(10, [1, 1, 1]) == [4, 3, 3]

    def test_negative_amounts_keep_the_sum(self) -> None:
        assert distribute(-1000, [1, 1, 1]) == [-334, -333, -333]
        assert sum(distribute(-1000, [1, 1, 1])) == -1000

    def test_a_zero_weight_gets_nothing(self) -> None:
        assert distribute(100, [0, 1]) == [0, 100]

    def test_stays_exact_past_the_double_boundary(self) -> None:
        shares = distribute(MAX_BALANCE, [1, 1, 1])
        assert sum(shares) == MAX_BALANCE

    def test_refuses_impossible_input(self) -> None:
        with pytest.raises(ValidationError):
            distribute(100, [])
        with pytest.raises(ValidationError):
            distribute(100, [0, 0])
        with pytest.raises(ValidationError):
            distribute(100, [-1, 1])


class TestDistributeEvenly:
    def test_splits_into_equal_parts(self) -> None:
        assert distribute_evenly(7, 4) == [2, 2, 2, 1]
        assert sum(distribute_evenly(7, 4)) == 7

    def test_refuses_a_non_positive_count(self) -> None:
        with pytest.raises(ValidationError):
            distribute_evenly(100, 0)
