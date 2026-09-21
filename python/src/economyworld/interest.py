"""Interest, and the schedules built out of it.

Everything a savings account, a term deposit, a loan or an instalment plan
needs, as pure integer arithmetic on whole minor units.

# Rates are in basis points, per period

A basis point is a hundredth of a percent, so 2.5 % is ``250``. Permille could
not express that without losing the half, and a percentage as a float is how
two editions end up with two different balances.

**A rate is per period, and a period is whatever the caller says it is.** This
package does not know whether your economy compounds daily, weekly or per
message; it knows how to apply a rate ``n`` times. Converting "5 % a year" into
a per-period figure is a decision about your economy, and it is yours.

# Interest is computed period by period, not by a formula

The closed form for compound interest is ``P * (1 + r)^n``. Applied to money it
is subtly wrong, because it compounds fractions of a unit that were never
credited to anybody. A real account is credited a whole number of units each
period, and the next period's interest is charged on *that*.

So every function here iterates:

    balance += round(balance * rate / 10000)

once per period. Slower than a formula, exact by construction, identical in
both editions, and -- the part that matters -- it produces the schedule a
member can check against their own statement.

# Nothing here is random

The rate is an argument. There is no market, no volatility, no chance. That is
a legal boundary rather than a simplification: a return that varies by chance is
the mechanism behind gambling regulation, and this package stays on the other
side of it. See the README's "Deliberately absent".
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .constants import BASIS_POINTS_ONE, MAX_BALANCE
from .errors import RateError, ValidationError
from .money import apply_basis_points, assert_whole_amount, distribute_evenly
from .rounding import Rounding, divide_rounded

__all__ = [
    "AccrualBasis",
    "AmortisationMethod",
    "Instalment",
    "AmortisationSchedule",
    "MAX_PERIODS",
    "accrue_interest",
    "project_balance",
    "level_payment",
    "amortisation_schedule",
    "total_interest",
    "outstanding_after",
]

#: How many periods any one call will iterate over.
#:
#: A thousand years of monthly instalments, and a bound on the work a single
#: call can be asked to do. A schedule longer than this is a denial of service
#: rather than a loan, and :file:`SECURITY.md` counts it as one.
MAX_PERIODS = 12_000


class AccrualBasis(str, Enum):
    """Whether interest earns interest."""

    #: Interest is charged on the original principal every period. Ten periods
    #: at 5 % is 50 % of the starting amount, exactly.
    SIMPLE = "SIMPLE"
    #: Interest is charged on the balance including interest already credited.
    #: What a savings account does, and what a loan left unpaid does.
    COMPOUND = "COMPOUND"


class AmortisationMethod(str, Enum):
    """How a loan's principal is spread across its instalments."""

    #: Every instalment is the same size; the split between interest and
    #: principal shifts across the term. What most consumer credit looks like.
    EQUAL_INSTALMENT = "EQUAL_INSTALMENT"
    #: Every instalment repays the same slice of principal, so the total falls
    #: as the interest does. Cheaper overall, harder at the start.
    EQUAL_PRINCIPAL = "EQUAL_PRINCIPAL"
    #: Interest only, with the whole principal due at the end. A bond, or a
    #: bridging loan.
    INTEREST_ONLY = "INTEREST_ONLY"


@dataclass(frozen=True)
class Instalment:
    """One row of an amortisation schedule."""

    #: 1 for the first instalment.
    number: int
    #: What is owed at the start of the period.
    opening_balance: int
    #: The whole payment due. ``interest + principal``, always.
    payment: int
    #: The part of the payment that is interest.
    interest: int
    #: The part that reduces the debt.
    principal: int
    #: What is owed after the payment. Zero on the last row, by construction.
    closing_balance: int


@dataclass(frozen=True)
class AmortisationSchedule:
    """Every instalment of a loan, and what it adds up to.

    The invariant worth knowing: ``sum(payment) == principal + total_interest``
    and the last row's ``closing_balance`` is zero. Both are checked before the
    schedule leaves this module, because a schedule that does not add up is a
    loan that quietly creates or destroys currency.
    """

    principal: int
    rate_basis_points: int
    method: AmortisationMethod
    instalments: tuple[Instalment, ...]
    total_interest: int
    total_paid: int

    @property
    def periods(self) -> int:
        return len(self.instalments)


def accrue_interest(
    principal: int,
    rate_basis_points: int,
    periods: int,
    basis: AccrualBasis = AccrualBasis.COMPOUND,
    rounding: Rounding = Rounding.DOWN,
) -> int:
    """The interest earned or owed over ``periods``, as a whole amount.

    Returns the *interest*, not the new balance -- because that is the number
    that has to be booked, and a booking needs an amount rather than a total.

        >>> from economyworld import accrue_interest
        >>> accrue_interest(10_000, 500, 1)      # 5 % of 10,000 for one period
        500
        >>> accrue_interest(10_000, 500, 2)      # compounded
        1025

    ``Rounding.DOWN`` by default, so an account never earns a unit the
    arithmetic did not justify. A community that would rather round in the
    member's favour passes ``Rounding.UP`` and knows it is doing so.
    """
    return project_balance(principal, rate_basis_points, periods, basis, rounding) - principal


def project_balance(
    principal: int,
    rate_basis_points: int,
    periods: int,
    basis: AccrualBasis = AccrualBasis.COMPOUND,
    rounding: Rounding = Rounding.DOWN,
) -> int:
    """What a balance grows to over ``periods``.

    The sibling of :func:`accrue_interest` for the caller who wants the total
    rather than the delta -- a projection screen, a maturity figure.
    """
    _assert_principal(principal)
    _assert_rate(rate_basis_points)
    _assert_periods(periods)

    if periods == 0 or rate_basis_points == 0 or principal == 0:
        return principal

    if basis is AccrualBasis.SIMPLE:
        # One multiplication, not a loop: simple interest does not compound, so
        # every period charges the same amount on the same principal.
        per_period = apply_basis_points(principal, rate_basis_points, rounding)
        total = principal + per_period * periods
        assert_whole_amount(total)
        return total

    balance = principal
    for _ in range(periods):
        balance += apply_basis_points(balance, rate_basis_points, rounding)
        # Checked every period rather than at the end: compounding runs away
        # fast, and the caller wants to know which period broke the ceiling.
        assert_whole_amount(balance)
    return balance


def level_payment(
    principal: int,
    rate_basis_points: int,
    periods: int,
    rounding: Rounding = Rounding.DOWN,
) -> int:
    """The smallest equal payment that clears the loan in ``periods``.

    **Found by search rather than by the annuity formula, and that is the
    point.** The textbook formula assumes interest is charged on unrounded
    fractions of a unit; this package charges it on whole units, because that is
    what an account can actually hold. A payment derived from the formula can
    therefore leave a few units outstanding after the final instalment -- a
    "rounding tail" that has to be swept up somewhere, and that members notice.

    So the payment is *defined* as the smallest one that works under the
    arithmetic actually used: binary search on the payment, simulating the
    schedule each time. It costs a few hundred iterations and it is exact by
    construction, with no fractional power anywhere for the two editions to
    disagree about.

    ``rounding`` says how each period's *interest* is rounded, exactly as it
    does everywhere else -- the payment itself is a whole number by
    construction. The default matches :func:`amortisation_schedule`'s, so the
    two always agree about what an instalment is.

        >>> from economyworld import level_payment
        >>> level_payment(120_000, 100, 12)     # 1 % a period over a year
        10662
    """
    _assert_principal(principal)
    _assert_rate(rate_basis_points)
    _assert_periods(periods)
    if periods == 0:
        raise RateError("A level payment needs at least one period", periods=periods)
    if principal == 0:
        return 0

    # Both bounds are proved rather than guessed, because a bracket that is
    # merely "wide enough" costs a bisection step for every bit of slack:
    #
    #   low   Each period reduces the debt by at most the payment, so ``n``
    #         payments must come to at least the principal. Anything below
    #         ``principal / n`` can never clear it, whatever the rate.
    #   high  A payment of ``ceil(principal / n)`` plus one period's interest on
    #         the *whole* principal clears it: the balance only ever falls, so
    #         no period's interest exceeds that first one, and every period
    #         therefore takes at least ``ceil(principal / n)`` off the capital.
    #
    # The gap between them is one period's interest rather than the whole
    # principal, which is where the iterations went: about eleven steps on a
    # year of 1 % monthly instead of seventeen.
    first_interest = apply_basis_points(principal, rate_basis_points, Rounding.UP)
    low = principal // periods
    high = divide_rounded(principal, periods, Rounding.UP) + first_interest + 1
    assert_whole_amount(high)

    while low < high:
        # ``low + (high - low) // 2``, not ``(low + high) // 2``. Python's
        # integers make both exact, so this edition is correct either way -- but
        # the TypeScript one is not: there the obvious form adds two amounts
        # that are each inside the safe range and whose sum is not, and the
        # search then never converges. The two editions are written the same way
        # so that a reader comparing them sees one algorithm, not two.
        middle = low + (high - low) // 2
        if _clears(principal, rate_basis_points, periods, middle, rounding):
            high = middle
        else:
            low = middle + 1
    return low


def _clears(
    principal: int, rate_basis_points: int, periods: int, payment: int, rounding: Rounding
) -> bool:
    """Whether this payment repays the loan within the term.

    The early exit is load-bearing, not an optimisation. A payment smaller than
    one period's interest leaves a balance that grows every period, and the
    binary search starts at a payment of one: without the check the simulation
    compounds its way past the ceiling and raises, on the way to an answer that
    was only ever going to be "no".

    The range check is load-bearing for a different reason. ``balance +
    interest`` can leave the range a JavaScript number holds exactly while the
    principal, the interest and the answer all sit inside it. Python would keep
    simulating, exactly, and return a payment the TypeScript edition disagrees
    with by a unit -- which is not a difference a borrower should discover.
    Found by the differential harness on a principal of 9,007,199,254,737,658
    at 5 % over 360 periods.
    """
    balance = principal
    for _ in range(periods):
        interest = apply_basis_points(balance, rate_basis_points, rounding)
        if payment <= interest and balance > 0:
            # The debt cannot fall from here, so no number of further periods
            # will clear it.
            return False
        # ``balance > MAX_BALANCE - interest`` rather than the sum, because the
        # sum is the thing that cannot be represented.
        if balance > MAX_BALANCE - interest:
            raise RateError(
                "The balance would leave the range both editions hold exactly "
                "before this payment could clear it",
                principal=principal,
                rate_basis_points=rate_basis_points,
                payment=payment,
                limit=MAX_BALANCE,
            )
        balance = balance + interest - payment
        if balance <= 0:
            return True
    return balance <= 0


def amortisation_schedule(
    principal: int,
    rate_basis_points: int,
    periods: int,
    method: AmortisationMethod = AmortisationMethod.EQUAL_INSTALMENT,
    rounding: Rounding = Rounding.DOWN,
) -> AmortisationSchedule:
    """Every instalment of a loan, adding up exactly.

    The last instalment absorbs whatever the rounding left over, which is what
    a real lender does and the only way the totals can be exact. It is usually
    a unit or two smaller than the others; occasionally larger.

        >>> from economyworld import amortisation_schedule
        >>> schedule = amortisation_schedule(120_000, 100, 12)
        >>> schedule.instalments[0].payment
        10662
        >>> schedule.instalments[-1].closing_balance
        0
        >>> sum(row.payment for row in schedule.instalments) == schedule.total_paid
        True

    Interest is charged on the opening balance of each period, rounded once, to
    a whole number of minor units. That is the same arithmetic
    :func:`accrue_interest` uses, so a loan and a savings account in the same
    economy agree about what a rate means.
    """
    _assert_principal(principal)
    _assert_rate(rate_basis_points)
    _assert_periods(periods)
    if periods == 0:
        raise RateError("A schedule needs at least one period", periods=periods)

    rows: list[Instalment] = []
    balance = principal

    if method is AmortisationMethod.EQUAL_INSTALMENT:
        payment = level_payment(principal, rate_basis_points, periods, rounding)
        for number in range(1, periods + 1):
            interest = apply_basis_points(balance, rate_basis_points, rounding)
            last = number == periods
            # The final row pays whatever is actually left, so the schedule
            # closes at zero instead of at a rounding tail.
            due = balance + interest if last else min(payment, balance + interest)
            rows.append(_row(number, balance, due, interest))
            balance = balance + interest - due

    elif method is AmortisationMethod.EQUAL_PRINCIPAL:
        # Distributed rather than divided: the slices add back up to exactly the
        # principal, so no unit is lost across the term.
        slices = distribute_evenly(principal, periods)
        for number, slice_amount in enumerate(slices, start=1):
            interest = apply_basis_points(balance, rate_basis_points, rounding)
            last = number == periods
            capital = balance if last else slice_amount
            rows.append(_row(number, balance, capital + interest, interest))
            balance -= capital

    else:  # INTEREST_ONLY
        for number in range(1, periods + 1):
            interest = apply_basis_points(balance, rate_basis_points, rounding)
            last = number == periods
            due = interest + balance if last else interest
            rows.append(_row(number, balance, due, interest))
            balance = balance + interest - due

    schedule = AmortisationSchedule(
        principal=principal,
        rate_basis_points=rate_basis_points,
        method=method,
        instalments=tuple(rows),
        total_interest=sum(row.interest for row in rows),
        total_paid=sum(row.payment for row in rows),
    )
    _assert_closes(schedule)
    return schedule


def total_interest(
    principal: int,
    rate_basis_points: int,
    periods: int,
    method: AmortisationMethod = AmortisationMethod.EQUAL_INSTALMENT,
    rounding: Rounding = Rounding.DOWN,
) -> int:
    """What a loan costs in interest over its whole term."""
    return amortisation_schedule(
        principal, rate_basis_points, periods, method, rounding
    ).total_interest


def outstanding_after(schedule: AmortisationSchedule, paid_instalments: int) -> int:
    """What is still owed after a number of instalments have been paid.

    The figure an early-repayment quote is built on, and the one a statement
    shows. Reading it off the schedule rather than recomputing it is deliberate:
    the schedule is the agreement, and a second computation that disagreed with
    it by a unit would be a dispute nobody could settle.
    """
    if not isinstance(paid_instalments, int) or isinstance(paid_instalments, bool):
        raise ValidationError(
            "paid_instalments must be an integer", paid_instalments=paid_instalments
        )
    if paid_instalments < 0:
        raise ValidationError(
            "paid_instalments cannot be negative", paid_instalments=paid_instalments
        )
    if paid_instalments == 0:
        return schedule.principal
    if paid_instalments >= len(schedule.instalments):
        return 0
    return schedule.instalments[paid_instalments - 1].closing_balance


# ---------------------------------------------------------------------------
# internals
# ---------------------------------------------------------------------------


def _row(number: int, opening: int, payment: int, interest: int) -> Instalment:
    return Instalment(
        number=number,
        opening_balance=opening,
        payment=payment,
        interest=interest,
        principal=payment - interest,
        closing_balance=opening + interest - payment,
    )


def _assert_closes(schedule: AmortisationSchedule) -> None:
    """The two properties that make a schedule a schedule rather than a guess.

    Checked here rather than trusted, because both failure modes are silent: a
    schedule that does not close leaves a debt nobody bills for, and one whose
    payments do not add up creates currency that no posting minted.
    """
    if not schedule.instalments:
        raise RateError("A schedule cannot be empty")

    # The totals have to be numbers both editions hold exactly, and a schedule
    # is the one place where they can leave the range while every individual
    # instalment stays inside it: a large principal at a real rate over a long
    # term adds up to several times what was borrowed. Python would return the
    # exact total and JavaScript a rounded one, so neither returns it.
    for name, value in (
        ("total_paid", schedule.total_paid),
        ("total_interest", schedule.total_interest),
    ):
        if value > MAX_BALANCE:
            raise RateError(
                f"The schedule's {name} is outside the range both editions hold "
                "exactly: shorten the term, lower the rate, or lend less",
                **{name: value},
                limit=MAX_BALANCE,
            )

    final = schedule.instalments[-1].closing_balance
    if final != 0:
        raise RateError(
            "The schedule does not close: the final instalment leaves a balance",
            outstanding=final,
        )

    expected = schedule.principal + schedule.total_interest
    if schedule.total_paid != expected:
        raise RateError(
            "The instalments do not add up to the principal plus the interest",
            total_paid=schedule.total_paid,
            expected=expected,
        )

    for row in schedule.instalments:
        if row.interest + row.principal != row.payment:
            raise RateError(
                "An instalment's interest and principal do not add up to its payment",
                instalment=row.number,
            )
        if row.opening_balance + row.interest - row.payment != row.closing_balance:
            raise RateError("An instalment's balances do not add up", instalment=row.number)


def _assert_principal(principal: int) -> None:
    assert_whole_amount(principal)
    if principal < 0:
        raise RateError("A principal cannot be negative", principal=principal)


def _assert_rate(rate_basis_points: int) -> None:
    if not isinstance(rate_basis_points, int) or isinstance(rate_basis_points, bool):
        raise RateError(
            "A rate must be an integer number of basis points",
            rate_basis_points=rate_basis_points,
        )
    if rate_basis_points < 0:
        raise RateError(
            "A negative rate is not supported: charge a fee instead, so the "
            "posting says what it is",
            rate_basis_points=rate_basis_points,
        )
    # A rate above 10000 basis points is a factor above two per period. It is
    # allowed -- a joke economy may want it -- but a rate that doubles a balance
    # every period reaches the ceiling in fifty of them, and the caller should
    # find that out here rather than in a projection.
    if rate_basis_points > BASIS_POINTS_ONE * 100:
        raise RateError(
            "A rate above 1,000,000 basis points is not a rate, it is a bug",
            rate_basis_points=rate_basis_points,
        )


def _assert_periods(periods: int) -> None:
    if not isinstance(periods, int) or isinstance(periods, bool):
        raise RateError("periods must be an integer", periods=periods)
    if periods < 0:
        raise RateError("periods cannot be negative", periods=periods)
    if periods > MAX_PERIODS:
        raise RateError(
            f"periods is capped at {MAX_PERIODS}: a longer schedule is a denial "
            "of service rather than a loan",
            periods=periods,
            limit=MAX_PERIODS,
        )
