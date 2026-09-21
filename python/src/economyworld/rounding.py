"""How money is rounded, stated once instead of decided six times.

Every financial subsystem in this package divides: a fee is a share of an
amount, interest is a share of a balance, an instalment is a loan split into
parts. Integer division has to round somewhere, and *where* is a policy
decision an operator should be able to see and set rather than discover.

Three rules govern everything here.

**One rounding, one number.** Whatever a division rounds to, both sides of the
resulting posting use that same number. The fee the payer pays is the fee the
recipient receives, to the unit. Money cannot leak through a rounding because
no posting is ever built from two separately-rounded halves.

**Splitting is exact.** :func:`~economyworld.money.distribute` hands out a
remainder rather than dropping it, so three members sharing 1000 receive 334,
333 and 333 -- not 333 each with a unit lost. That is the largest-remainder
method, and the tie-break is by position so both editions agree.

**Rounding is symmetric about zero.** ``DOWN`` means towards zero and ``UP``
means away from it, not towards minus infinity. A refund of a fee is then the
same size as the fee, which is the behaviour a member expects and the one an
auditor can check.
"""

from __future__ import annotations

from enum import Enum

from .errors import ValidationError

__all__ = [
    "Rounding",
    "divide_rounded",
]


class Rounding(str, Enum):
    """Where a division that does not come out even is sent.

    All four are symmetric about zero, so ``-x`` rounds to ``-round(x)``.
    """

    #: Towards zero. The payer keeps the fraction.
    DOWN = "DOWN"
    #: Away from zero. The recipient gets the fraction.
    UP = "UP"
    #: To the nearer, and away from zero exactly halfway. What people mean by
    #: "rounding" when they are not thinking about it.
    HALF_UP = "HALF_UP"
    #: To the nearer, and to the even one exactly halfway. Removes the upward
    #: bias HALF_UP has over many roundings, which is why accountants use it.
    HALF_EVEN = "HALF_EVEN"


def divide_rounded(numerator: int, denominator: int, mode: Rounding = Rounding.DOWN) -> int:
    """``numerator / denominator`` as an integer, rounded by ``mode``.

    The one division in this package. Everything that computes a share of an
    amount comes through here, so there is exactly one place where a rounding
    decision is made and exactly one place to check that both editions make it
    the same way.

        >>> from economyworld import Rounding, divide_rounded
        >>> divide_rounded(7, 2, Rounding.DOWN)
        3
        >>> divide_rounded(7, 2, Rounding.HALF_UP)
        4
        >>> divide_rounded(-7, 2, Rounding.DOWN)
        -3

    Python's ``//`` floors towards minus infinity and JavaScript's ``Math.floor``
    does the same, so neither is used: the sign is taken off first, the division
    is done on magnitudes, and the sign is put back. That is what makes the
    result symmetric, and it is why ``-7 // 2`` (which is ``-4``) is not the
    answer above.
    """
    if not isinstance(numerator, int) or isinstance(numerator, bool):
        raise ValidationError("numerator must be an integer", numerator=numerator)
    if not isinstance(denominator, int) or isinstance(denominator, bool):
        raise ValidationError("denominator must be an integer", denominator=denominator)
    if denominator == 0:
        raise ValidationError("Cannot divide by zero")

    negative = (numerator < 0) != (denominator < 0)
    top = abs(numerator)
    bottom = abs(denominator)

    quotient, remainder = divmod(top, bottom)

    if remainder != 0:
        if mode is Rounding.UP:
            quotient += 1
        elif mode is Rounding.HALF_UP:
            if remainder * 2 >= bottom:
                quotient += 1
        elif mode is Rounding.HALF_EVEN:
            doubled = remainder * 2
            if doubled > bottom or (doubled == bottom and quotient % 2 == 1):
                quotient += 1
        # Rounding.DOWN keeps the truncated quotient.

    return -quotient if negative else quotient
