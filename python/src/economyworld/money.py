"""Currencies and integer amount arithmetic.

Amounts are **always integers in the smallest unit**. A currency with
``minor_units=2`` and an amount of ``1234`` means 12.34 of it. Floating-point
money accumulates rounding errors that turn into visible discrepancies over a
few million bookings, and -- worse -- into differences between the Python and
the TypeScript edition. There is no float anywhere in this package.

If you want to show fractions, pick a smaller smallest unit.

This is play money, and nothing here changes that: no conversion to a real
currency, no payment provider, no payout.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .constants import BASIS_POINTS_ONE, MAX_BALANCE, PERMILLE_ONE
from .errors import ConfigurationError, InvalidAmountError, ValidationError
from .rounding import Rounding, divide_rounded

__all__ = [
    "Currency",
    "create_currency",
    "split_minor_units",
    "apply_permille",
    "apply_basis_points",
    "apply_rate",
    "distribute",
    "distribute_evenly",
    "assert_whole_amount",
    "assert_positive_amount",
    "MinorUnits",
]


@dataclass(frozen=True)
class Currency:
    """A currency in a community's economy."""

    #: Short identifier, e.g. ``"COIN"``. Unique within an engine.
    code: str
    #: Human-readable name, for the caller's own display code.
    name: str
    #: Symbol, for the caller's own display code.
    symbol: str
    #: How many decimal places the currency shows.
    #:
    #: ``0`` means whole coins; ``2`` means the stored integer is hundredths.
    #: The package never divides by this -- it is metadata for the caller's
    #: own formatter.
    minor_units: int
    #: Ceiling for a single member account. Guards against overflow.
    max_balance: int


@dataclass(frozen=True)
class MinorUnits:
    """An amount split into its whole and fractional parts."""

    negative: bool
    whole: int
    fraction: int


def create_currency(
    code: str,
    name: str | None = None,
    symbol: str | None = None,
    minor_units: int = 0,
    max_balance: int = MAX_BALANCE,
) -> Currency:
    """Build a validated :class:`Currency`."""
    if not isinstance(code, str) or not code:
        raise ConfigurationError("A currency needs a non-empty code", code=code)
    if not isinstance(minor_units, int) or isinstance(minor_units, bool):
        raise ConfigurationError("minor_units must be an integer", minor_units=minor_units)
    if minor_units < 0 or minor_units > 8:
        raise ConfigurationError(
            "minor_units must be between 0 and 8", minor_units=minor_units
        )
    if not isinstance(max_balance, int) or isinstance(max_balance, bool):
        raise ConfigurationError("max_balance must be an integer", max_balance=max_balance)
    if max_balance <= 0:
        raise ConfigurationError("max_balance must be positive", max_balance=max_balance)
    if max_balance > MAX_BALANCE:
        raise ConfigurationError(
            "max_balance exceeds the range both editions can hold exactly",
            max_balance=max_balance,
            limit=MAX_BALANCE,
        )

    return Currency(
        code=code,
        name=name if name is not None else code,
        symbol=symbol if symbol is not None else code,
        minor_units=minor_units,
        max_balance=max_balance,
    )


def split_minor_units(amount: int, currency: Currency) -> MinorUnits:
    """Split an amount into its whole and fractional parts.

    Pure arithmetic on integers -- this package does not format money, because a
    display format is a locale decision and belongs to the caller. What it can
    do is take the awkward part off your hands: the sign handling that everyone
    gets wrong for negative amounts.

        >>> from economyworld import create_currency, split_minor_units
        >>> split_minor_units(-1234, create_currency("GLD", minor_units=2))
        MinorUnits(negative=True, whole=12, fraction=34)
    """
    assert_whole_amount(amount)
    magnitude = abs(amount)
    divisor = 10**currency.minor_units
    return MinorUnits(
        negative=amount < 0,
        whole=magnitude // divisor,
        fraction=magnitude % divisor,
    )


def apply_permille(amount: int, permilles: Sequence[int]) -> int:
    """Multiply an amount by a chain of permille factors.

    Applied one after another, in the order given. The order is part of the
    contract: rounding twice is not commutative, and two editions that
    disagreed about the order would disagree about the balance.

    Rounds towards zero, which is what the 1.x behaviour was for positive
    amounts. Use :func:`apply_rate` when you want to choose.

    **A factor above 1000 can produce an answer outside the range both editions
    hold exactly, and that is refused rather than returned.** Python would hand
    back the exact integer and JavaScript a rounded one, which is the single
    failure this package is built to make impossible -- see the 2.0.0 changelog
    for what it cost before it was checked.
    """
    value = amount
    for permille in permilles:
        if not isinstance(permille, int) or isinstance(permille, bool) or permille < 0:
            raise InvalidAmountError(
                "A permille factor must be a non-negative integer", permille=permille
            )
        value = divide_rounded(value * permille, PERMILLE_ONE, Rounding.DOWN)
        assert_whole_amount(value)
    return value


def apply_basis_points(
    amount: int, basis_points: int, rounding: Rounding = Rounding.DOWN
) -> int:
    """A share of an amount, in hundredths of a percent.

    Basis points rather than permille because that is the unit interest and fees
    come in: 2.5 % is 250 basis points, and a permille figure could not express
    it without losing the half. One basis point on a thousand-unit balance is a
    tenth of a unit, which rounds -- so the rounding mode is an argument rather
    than a decision made here.

        >>> from economyworld import apply_basis_points
        >>> apply_basis_points(10_000, 250)     # 2.5 % of 10,000
        250

    A figure above 10000 is a factor greater than one, which is allowed -- but
    the answer still has to be a number both editions hold exactly, and one
    that is not is refused rather than returned.
    """
    assert_whole_amount(amount)
    if not isinstance(basis_points, int) or isinstance(basis_points, bool):
        raise InvalidAmountError(
            "A basis-point figure must be an integer", basis_points=basis_points
        )
    if basis_points < 0:
        raise InvalidAmountError(
            "A basis-point figure must not be negative", basis_points=basis_points
        )
    result = divide_rounded(amount * basis_points, BASIS_POINTS_ONE, rounding)
    assert_whole_amount(result)
    return result


def apply_rate(
    amount: int, numerator: int, denominator: int, rounding: Rounding = Rounding.DOWN
) -> int:
    """``amount * numerator / denominator``, exact and rounded as asked.

    The general form the other two are special cases of, for a caller with a
    rate this package has no unit for -- an exchange rate, a revenue share, a
    price expressed as a fraction.
    """
    assert_whole_amount(amount)
    if not isinstance(numerator, int) or isinstance(numerator, bool):
        raise InvalidAmountError("A rate numerator must be an integer", numerator=numerator)
    if not isinstance(denominator, int) or isinstance(denominator, bool):
        raise InvalidAmountError(
            "A rate denominator must be an integer", denominator=denominator
        )
    if denominator <= 0:
        raise InvalidAmountError(
            "A rate denominator must be positive", denominator=denominator
        )
    result = divide_rounded(amount * numerator, denominator, rounding)
    assert_whole_amount(result)
    return result


def distribute(amount: int, weights: Sequence[int]) -> list[int]:
    """Split an amount into shares that add back up to exactly it.

    The largest-remainder method. Divide by the weights, hand each share its
    whole part, then give the units left over to the shares whose discarded
    fraction was largest -- one each, until none are left.

        >>> from economyworld import distribute
        >>> distribute(1000, [1, 1, 1])
        [334, 333, 333]
        >>> sum(distribute(1000, [1, 1, 1]))
        1000

    The naive version of this is how a community loses a unit of currency every
    time three people split a prize. Here nothing is lost, because the sum is
    the postcondition rather than a hope: 334 + 333 + 333 is 1000, and the
    posting balances.

    Ties are broken by position, so the earlier weight wins the spare unit. Any
    rule would do; what matters is that both editions use the same one and that
    it does not depend on a dictionary's iteration order.
    """
    assert_whole_amount(amount)
    if not weights:
        raise ValidationError("Cannot distribute across no weights")

    total_weight = 0
    for weight in weights:
        if not isinstance(weight, int) or isinstance(weight, bool):
            raise ValidationError("A weight must be an integer", weight=weight)
        if weight < 0:
            raise ValidationError("A weight must not be negative", weight=weight)
        total_weight += weight

    if total_weight == 0:
        raise ValidationError("The weights must not all be zero")

    negative = amount < 0
    magnitude = abs(amount)

    shares = [magnitude * weight // total_weight for weight in weights]
    remainders = [magnitude * weight % total_weight for weight in weights]
    left_over = magnitude - sum(shares)

    # The indices with the largest discarded fraction, earliest first. Sorting
    # by a tuple keeps it deterministic where two remainders are equal.
    order = sorted(range(len(weights)), key=lambda i: (-remainders[i], i))
    for index in order[:left_over]:
        shares[index] += 1

    return [-share for share in shares] if negative else shares


def distribute_evenly(amount: int, parts: int) -> list[int]:
    """Split an amount into ``parts`` shares that add back up to exactly it.

    :func:`distribute` with every weight equal, which is the case that comes up
    most: an instalment plan, a prize split, a bill divided between members.
    """
    if not isinstance(parts, int) or isinstance(parts, bool) or parts <= 0:
        raise ValidationError("parts must be a positive integer", parts=parts)
    return distribute(amount, [1] * parts)


def assert_whole_amount(amount: int) -> None:
    """Reject anything that is not a whole number of minor units."""
    if not isinstance(amount, int) or isinstance(amount, bool):
        raise InvalidAmountError("Amounts must be whole numbers of minor units", amount=amount)
    if amount > MAX_BALANCE or amount < -MAX_BALANCE:
        raise InvalidAmountError(
            "Amounts must stay inside the range both editions can hold exactly",
            amount=amount,
        )


def assert_positive_amount(amount: int) -> None:
    """Reject anything that is not a positive whole number of minor units."""
    assert_whole_amount(amount)
    if amount <= 0:
        raise InvalidAmountError("Amount must be greater than zero", amount=amount)
