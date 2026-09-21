"""Loans: currency lent, repaid on a schedule, and what happens when it is not.

A loan is the one thing in an economy that lets a member spend currency they do
not have, and it is therefore the one thing most able to wreck the money supply
if it is done loosely. Three decisions keep it honest here.

# The schedule is the agreement

:func:`open_loan` computes the whole amortisation schedule up front and stores
it on the loan. Every later question -- what is owed, what an instalment costs,
what settling early would cost -- is read off that schedule rather than
recomputed. A second computation that disagreed with the first by a unit would
be a dispute between a member and a bot with no way to settle it.

# Lending is not minting

The principal comes out of ``system:credit``, whose balance is therefore the
scope's outstanding lending with a minus sign. Repayments go back to it. A
community that has lent 10,000 and been repaid 3,000 has a credit account at
-7,000, and that number can be checked against the sum of every open loan.

**Interest is different, and this is the part worth being careful about.** A
repayment is booked as one posting with up to three lines: the capital goes back
to ``system:credit``, and the interest and any fees go to ``system:fee``,
because they are revenue rather than a return of principal. Sending the whole
payment to the credit account would leave it positive by exactly the interest
once every loan had been repaid, and a number that is supposed to mean "currency
currently lent out" would mean nothing at all.

# Default is a booking, not a deletion

Writing a debt off brings ``system:credit`` back to zero for that loan, and the
counter-line is the **mint**.

That is worth a sentence, because the obvious choice is the sink and the obvious
choice is wrong. The sink is where currency is destroyed -- and nothing is
destroyed here. The borrower still has what they were lent; they are simply
never going to give it back. So the currency that was a *claim* becomes currency
that was *issued*, the mint's balance says so, and the money supply rises by
exactly what was lost. Sending it to the sink instead would leave the scope
reporting a negative amount in circulation, which is not a thing.

A loan that was simply deleted would leave the credit account permanently
wrong.

# Nothing here is random

Whether a borrower repays is the caller's news to deliver, not this package's to
decide. There is no default probability, no credit scoring model, no chance.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from enum import Enum

from .accounts import (
    Account,
    AccountRef,
    SystemAccount,
    account_key,
    empty_account,
    system_account,
)
from .engine import EconomyEngine
from .errors import (
    CreditLimitError,
    LoanStateError,
    ValidationError,
)
from .interest import (
    AmortisationMethod,
    AmortisationSchedule,
    Instalment,
    amortisation_schedule,
    outstanding_after,
)
from .ledger import PostingKind, PostingLine, create_posting, resulting_balances
from .money import apply_basis_points, assert_positive_amount, assert_whole_amount
from .rounding import Rounding
from .types import BookingResult

__all__ = [
    "LoanState",
    "LoanTerms",
    "Loan",
    "RepaymentResult",
    "create_loan_terms",
    "open_loan",
    "repay",
    "settlement_quote",
    "settle_early",
    "charge_late_fee",
    "write_off",
    "amount_due",
    "is_in_arrears",
    "next_instalment",
    "assert_within_credit_limit",
]


class LoanState(str, Enum):
    """Where a loan is in its life."""

    #: Money has been paid out and the debt is being repaid.
    ACTIVE = "ACTIVE"
    #: Repaid in full. Nothing further is owed.
    SETTLED = "SETTLED"
    #: Behind on its instalments, but still owed and still collectable.
    IN_ARREARS = "IN_ARREARS"
    #: Given up on. The capital that never came back has been recognised as
    #: permanent issuance, so the credit account is clear and the books close.
    WRITTEN_OFF = "WRITTEN_OFF"


@dataclass(frozen=True)
class LoanTerms:
    """What is borrowed, at what price, over how long."""

    principal: int
    #: Charged per period on the outstanding balance, in basis points.
    rate_basis_points: int
    periods: int
    method: AmortisationMethod = AmortisationMethod.EQUAL_INSTALMENT
    rounding: Rounding = Rounding.DOWN
    #: What a missed instalment costs, in basis points of the instalment.
    #: Charged by :func:`charge_late_fee`, never automatically -- the decision
    #: that a payment is late is the caller's, because only it knows the clock.
    late_fee_basis_points: int = 0
    #: How many instalments may be missed before the loan is in arrears.
    grace_periods: int = 0


@dataclass(frozen=True)
class Loan:
    """A loan as the caller stores it."""

    loan_id: str
    borrower: AccountRef
    terms: LoanTerms
    schedule: AmortisationSchedule
    state: LoanState
    #: Instalments fully paid. Indexes into the schedule.
    paid_instalments: int
    #: Capital still owed. Tracked rather than recomputed, and that is the
    #: point: a member who has part-paid an instalment has paid some of its
    #: interest, and a figure derived from whole instalments would count that
    #: interest as still owed. Writing a loan off on such a figure recognises
    #: the wrong amount of issuance and leaves the credit account holding a
    #: balance for a loan nobody owes -- see the 2.0.0 changelog.
    principal_outstanding: int
    #: Interest still owed, on the same basis.
    interest_outstanding: int
    #: Paid so far against the current instalment, when a member pays in parts.
    part_paid: int
    #: Fees charged and not yet paid. Sit outside the schedule: a late fee is
    #: not interest and must not be confused with it.
    fees_outstanding: int
    opened_at: int
    #: Everything repaid so far, fees included. For a statement.
    total_repaid: int = 0

    @property
    def outstanding(self) -> int:
        """What the schedule still owes: capital and interest together."""
        return self.principal_outstanding + self.interest_outstanding

    @property
    def total_outstanding(self) -> int:
        """Everything still owed: schedule and fees together."""
        return self.outstanding + self.fees_outstanding

    @property
    def is_closed(self) -> bool:
        return self.state in (LoanState.SETTLED, LoanState.WRITTEN_OFF)


@dataclass(frozen=True)
class RepaymentResult:
    """What a repayment did. Write both parts in one transaction."""

    booking: BookingResult
    loan: Loan
    #: How much of the payment went to fees, interest and principal. Adds up to
    #: the payment, always -- a statement line a member can check.
    to_fees: int
    to_interest: int
    to_principal: int
    #: How many instalments this payment completed.
    instalments_cleared: int
    #: True when this payment closed the loan.
    settled: bool


def create_loan_terms(
    principal: int,
    rate_basis_points: int,
    periods: int,
    method: AmortisationMethod = AmortisationMethod.EQUAL_INSTALMENT,
    rounding: Rounding = Rounding.DOWN,
    late_fee_basis_points: int = 0,
    grace_periods: int = 0,
) -> LoanTerms:
    """Build validated loan terms."""
    assert_positive_amount(principal)
    if (
        not isinstance(late_fee_basis_points, int)
        or isinstance(late_fee_basis_points, bool)
        or late_fee_basis_points < 0
    ):
        raise ValidationError(
            "late_fee_basis_points must be a non-negative integer",
            late_fee_basis_points=late_fee_basis_points,
        )
    if (
        not isinstance(grace_periods, int)
        or isinstance(grace_periods, bool)
        or grace_periods < 0
    ):
        raise ValidationError(
            "grace_periods must be a non-negative integer", grace_periods=grace_periods
        )
    return LoanTerms(
        principal=principal,
        rate_basis_points=rate_basis_points,
        periods=periods,
        method=method,
        rounding=rounding,
        late_fee_basis_points=late_fee_basis_points,
        grace_periods=grace_periods,
    )


def assert_within_credit_limit(
    terms: LoanTerms, existing: int, credit_limit: int | None
) -> None:
    """Refuse a loan that would take a member past what they may borrow.

    ``existing`` is what they already owe -- the caller sums it, because only
    the caller knows how many loans a member has. Passing ``None`` for the limit
    means the community has not set one, which is a decision rather than an
    oversight and so is allowed.
    """
    if credit_limit is None:
        return
    assert_whole_amount(existing)
    assert_whole_amount(credit_limit)
    if credit_limit < 0:
        raise ValidationError("A credit limit cannot be negative", credit_limit=credit_limit)
    if existing + terms.principal > credit_limit:
        raise CreditLimitError(
            "That loan would take the borrower past their credit limit",
            existing=existing,
            requested=terms.principal,
            credit_limit=credit_limit,
        )


def open_loan(
    engine: EconomyEngine,
    loan_id: str,
    terms: LoanTerms,
    borrower: Account,
    now: int,
    operation_id: str,
    reason: str,
    credit_account: Account | None = None,
    metadata: Mapping[str, str] | None = None,
) -> tuple[BookingResult, Loan]:
    """Pay a loan out and start its schedule.

    The whole schedule is computed here, once, and stored. Everything that
    happens to the loan afterwards is read off it.
    """
    if not isinstance(loan_id, str) or not loan_id:
        raise ValidationError("A loan needs a non-empty id", loan_id=loan_id)
    _assert_timestamp(now)

    schedule = amortisation_schedule(
        principal=terms.principal,
        rate_basis_points=terms.rate_basis_points,
        periods=terms.periods,
        method=terms.method,
        rounding=terms.rounding,
    )

    booking = engine.transfer(
        source=credit_account
        or empty_account(
            system_account(borrower.ref.scope, borrower.ref.currency, SystemAccount.CREDIT)
        ),
        target=borrower,
        amount=terms.principal,
        now=now,
        operation_id=operation_id,
        reason=reason,
        kind=PostingKind.LOAN_DISBURSEMENT,
        # The credit account is a system account and is meant to go negative:
        # its balance *is* the outstanding lending.
        allow_negative=True,
        metadata=metadata,
    )

    loan = Loan(
        loan_id=loan_id,
        borrower=borrower.ref,
        terms=terms,
        schedule=schedule,
        state=LoanState.ACTIVE,
        paid_instalments=0,
        principal_outstanding=schedule.principal,
        interest_outstanding=schedule.total_interest,
        part_paid=0,
        fees_outstanding=0,
        opened_at=now,
        total_repaid=0,
    )
    return booking, loan


def amount_due(loan: Loan, instalments: int = 1) -> int:
    """What the next ``instalments`` payments come to, fees first.

    The number to put in front of a member before they press pay.
    """
    if not isinstance(instalments, int) or isinstance(instalments, bool) or instalments < 1:
        raise ValidationError(
            "instalments must be a positive integer", instalments=instalments
        )
    if loan.is_closed:
        return 0

    due = loan.fees_outstanding
    remaining = loan.schedule.instalments[loan.paid_instalments :]
    for row in remaining[:instalments]:
        due += row.payment
    return due - loan.part_paid


def next_instalment(loan: Loan) -> Instalment | None:
    """The next unpaid row of the schedule, or ``None`` when there is none."""
    if loan.is_closed or loan.paid_instalments >= len(loan.schedule.instalments):
        return None
    return loan.schedule.instalments[loan.paid_instalments]


def repay(
    engine: EconomyEngine,
    loan: Loan,
    borrower: Account,
    amount: int,
    now: int,
    operation_id: str,
    reason: str,
    credit_account: Account | None = None,
    fee_account: Account | None = None,
    metadata: Mapping[str, str] | None = None,
) -> RepaymentResult:
    """Pay something towards a loan.

    Any amount is accepted up to what is owed; a part payment is recorded
    against the current instalment and the loan does not advance until that
    instalment is complete. Paying more than is owed is refused rather than
    silently credited, because an overpayment a member cannot get back is worse
    than an error message.

    **The payment is split fees, then interest, then principal.** That order is
    a decision and it is the conventional one: it means a member who pays late
    clears the penalty first and their debt last, which is what the schedule
    they agreed to says. The three parts come back on the result so a statement
    can show them.
    """
    assert_positive_amount(amount)
    _assert_timestamp(now)
    _assert_borrower(loan, borrower)
    if loan.is_closed:
        raise LoanStateError(
            "That loan is closed", loan_id=loan.loan_id, state=loan.state.value
        )
    engine.currency(borrower.ref.currency)  # the currency must be configured

    owed = loan.total_outstanding
    if amount > owed:
        raise LoanStateError(
            "That is more than the loan owes; settle it instead",
            loan_id=loan.loan_id,
            outstanding=owed,
            offered=amount,
        )

    # Fees first.
    to_fees = min(amount, loan.fees_outstanding)
    left = amount - to_fees

    # Then interest and principal, instalment by instalment, so the split
    # reported is the split the schedule actually describes.
    to_interest = 0
    to_principal = 0
    paid = loan.paid_instalments
    part = loan.part_paid

    while left > 0 and paid < len(loan.schedule.instalments):
        row = loan.schedule.instalments[paid]
        still_owed_on_row = row.payment - part
        paying = min(left, still_owed_on_row)

        # Within one instalment the same order applies: interest before capital.
        interest_left = max(0, row.interest - min(part, row.interest))
        interest_part = min(paying, interest_left)
        to_interest += interest_part
        to_principal += paying - interest_part

        part += paying
        left -= paying
        if part >= row.payment:
            paid += 1
            part = 0

    booking = _book_repayment(
        loan=loan,
        borrower=borrower,
        to_principal=to_principal,
        to_revenue=to_interest + to_fees,
        now=now,
        operation_id=operation_id,
        reason=reason,
        credit_account=credit_account,
        fee_account=fee_account,
        metadata=metadata,
    )

    settled = paid >= len(loan.schedule.instalments) and part == 0
    updated = replace(
        loan,
        paid_instalments=paid,
        part_paid=part,
        principal_outstanding=loan.principal_outstanding - to_principal,
        interest_outstanding=loan.interest_outstanding - to_interest,
        fees_outstanding=loan.fees_outstanding - to_fees,
        total_repaid=loan.total_repaid + amount,
        state=LoanState.SETTLED
        if settled and loan.fees_outstanding == to_fees
        else loan.state,
    )
    return RepaymentResult(
        booking=booking,
        loan=updated,
        to_fees=to_fees,
        to_interest=to_interest,
        to_principal=to_principal,
        instalments_cleared=paid - loan.paid_instalments,
        settled=updated.state is LoanState.SETTLED,
    )


def settlement_quote(loan: Loan, rebate_basis_points: int = 0) -> int:
    """What it would cost to clear the loan today.

    Everything still owed, less a rebate on the interest that has not been
    reached yet. A community that wants early repayment to be worth doing sets
    a rebate; one that does not, leaves it at zero and the quote is simply the
    outstanding balance.

    The rebate applies only to *future* interest -- the interest inside
    instalments already reached is owed and is not given back.
    """
    if loan.is_closed:
        return 0
    if (
        not isinstance(rebate_basis_points, int)
        or isinstance(rebate_basis_points, bool)
        or not 0 <= rebate_basis_points <= 10_000
    ):
        raise ValidationError(
            "rebate_basis_points must be between 0 and 10000",
            rebate_basis_points=rebate_basis_points,
        )

    # Only interest beyond the instalment currently being paid is rebated: the
    # one in progress has been reached, so its interest is owed.
    future_interest = sum(
        row.interest for row in loan.schedule.instalments[loan.paid_instalments + 1 :]
    )
    # Never rebate more interest than is actually still owed. A part payment
    # can already have cleared some of it, and a rebate larger than the debt
    # would hand the borrower currency for closing their loan.
    future_interest = min(future_interest, loan.interest_outstanding)
    rebate = apply_basis_points(future_interest, rebate_basis_points, Rounding.DOWN)
    return loan.total_outstanding - rebate


def settle_early(
    engine: EconomyEngine,
    loan: Loan,
    borrower: Account,
    now: int,
    operation_id: str,
    reason: str,
    rebate_basis_points: int = 0,
    credit_account: Account | None = None,
    fee_account: Account | None = None,
    metadata: Mapping[str, str] | None = None,
) -> RepaymentResult:
    """Clear the whole loan in one payment.

    The rebate is forgiven interest: currency the member never has to find. It
    is simply not charged, so nothing is booked for it and the money supply does
    not move.
    """
    _assert_timestamp(now)
    _assert_borrower(loan, borrower)
    if loan.is_closed:
        raise LoanStateError(
            "That loan is closed", loan_id=loan.loan_id, state=loan.state.value
        )
    engine.currency(borrower.ref.currency)  # the currency must be configured

    quote = settlement_quote(loan, rebate_basis_points)
    to_principal = min(loan.principal_outstanding, max(0, quote - loan.fees_outstanding))
    booking = _book_repayment(
        loan=loan,
        borrower=borrower,
        to_principal=to_principal,
        to_revenue=quote - to_principal,
        now=now,
        operation_id=operation_id,
        reason=reason,
        credit_account=credit_account,
        fee_account=fee_account,
        metadata=metadata,
    )

    updated = replace(
        loan,
        state=LoanState.SETTLED,
        paid_instalments=len(loan.schedule.instalments),
        part_paid=0,
        principal_outstanding=0,
        interest_outstanding=0,
        fees_outstanding=0,
        total_repaid=loan.total_repaid + quote,
    )
    # The rebate comes off the interest, so the capital is repaid in full and
    # the split still adds up to what was actually paid.
    return RepaymentResult(
        booking=booking,
        loan=updated,
        to_fees=loan.fees_outstanding,
        to_interest=quote - loan.fees_outstanding - to_principal,
        to_principal=to_principal,
        instalments_cleared=len(loan.schedule.instalments) - loan.paid_instalments,
        settled=True,
    )


def charge_late_fee(loan: Loan, missed_instalments: int = 1) -> Loan:
    """Add a late fee to what the loan owes. Nothing is booked yet.

    A fee is charged to the *loan*, not to the member's balance: they owe it,
    they have not paid it. It is booked when they do, out of
    :func:`repay`, which is why this function returns a loan and no posting.

    Marking a loan late is the caller's call. This package reads no clock, so it
    cannot know that an instalment is overdue -- only the caller's scheduler
    does.
    """
    if (
        not isinstance(missed_instalments, int)
        or isinstance(missed_instalments, bool)
        or missed_instalments < 1
    ):
        raise ValidationError(
            "missed_instalments must be a positive integer",
            missed_instalments=missed_instalments,
        )
    if loan.is_closed:
        raise LoanStateError(
            "A closed loan cannot be charged a fee",
            loan_id=loan.loan_id,
            state=loan.state.value,
        )

    row = next_instalment(loan)
    if row is None:
        return loan

    fee = apply_basis_points(
        row.payment * missed_instalments, loan.terms.late_fee_basis_points, Rounding.DOWN
    )
    in_arrears = missed_instalments > loan.terms.grace_periods
    return replace(
        loan,
        fees_outstanding=loan.fees_outstanding + fee,
        state=LoanState.IN_ARREARS if in_arrears else loan.state,
    )


def is_in_arrears(loan: Loan, instalments_expected: int) -> bool:
    """Whether the borrower is further behind than the grace allows.

    ``instalments_expected`` is how many should have been paid by now, which
    only the caller can work out -- it depends on a clock and on what a period
    means in that economy.
    """
    if loan.is_closed:
        return False
    behind = instalments_expected - loan.paid_instalments
    return behind > loan.terms.grace_periods


def write_off(
    engine: EconomyEngine,
    loan: Loan,
    now: int,
    operation_id: str,
    reason: str,
    credit_account: Account | None = None,
    mint_account: Account | None = None,
    metadata: Mapping[str, str] | None = None,
) -> tuple[BookingResult | None, Loan]:
    """Give up on a debt, and say so on the books.

    The principal that is still out there stops being a claim and becomes an
    issuance: ``system:credit`` returns to zero for this loan and the mint goes
    negative by the same amount. The money supply rises by what was lost, which
    is exactly what happened -- the borrower kept it.

    Unpaid *interest and fees* are not written off, because they were never
    issued: nobody minted them, so nothing has to be un-minted. They simply stop
    being owed.

    ``None`` comes back instead of a posting when there was no principal left to
    write off -- a loan that had been fully repaid in capital and was only
    behind on interest.
    """
    _assert_timestamp(now)
    if loan.is_closed:
        raise LoanStateError(
            "That loan is already closed", loan_id=loan.loan_id, state=loan.state.value
        )

    lost_principal = loan.principal_outstanding

    updated = replace(
        loan,
        state=LoanState.WRITTEN_OFF,
        principal_outstanding=0,
        interest_outstanding=0,
        fees_outstanding=0,
        part_paid=0,
    )
    if lost_principal == 0:
        return None, updated

    booking = engine.transfer(
        source=mint_account
        or empty_account(
            system_account(loan.borrower.scope, loan.borrower.currency, SystemAccount.MINT)
        ),
        target=credit_account
        or empty_account(
            system_account(loan.borrower.scope, loan.borrower.currency, SystemAccount.CREDIT)
        ),
        amount=lost_principal,
        now=now,
        operation_id=operation_id,
        reason=reason,
        kind=PostingKind.WRITE_OFF,
        allow_negative=True,
        metadata=metadata,
    )
    return booking, updated


# ---------------------------------------------------------------------------
# internals
# ---------------------------------------------------------------------------


def _book_repayment(
    loan: Loan,
    borrower: Account,
    to_principal: int,
    to_revenue: int,
    now: int,
    operation_id: str,
    reason: str,
    credit_account: Account | None,
    fee_account: Account | None,
    metadata: Mapping[str, str] | None,
) -> BookingResult:
    """One posting, up to three lines: capital back, revenue collected.

    **Capital and revenue go to different places, and that is the whole point of
    booking this by hand rather than as a transfer.** The principal returns to
    ``system:credit``, which lent it; the interest and any fees are revenue and
    go to ``system:fee``. Sending the whole payment to the credit account would
    leave it positive by exactly the interest once every loan in the community
    had been repaid, and the number that is supposed to mean "currency currently
    lent out" would instead mean nothing at all.

    The three lines are one posting because they are one event. A member pays
    once; the books record where the money went.
    """
    scope = loan.borrower.scope
    currency = loan.borrower.currency
    amount = to_principal + to_revenue

    credit = credit_account or empty_account(
        system_account(scope, currency, SystemAccount.CREDIT)
    )
    fees = fee_account or empty_account(system_account(scope, currency, SystemAccount.FEE))

    lines = [
        PostingLine(
            account=borrower.ref,
            delta=-amount,
            balance_before=borrower.balance,
            balance_after=borrower.balance - amount,
        )
    ]
    if to_principal > 0:
        lines.append(
            PostingLine(
                account=credit.ref,
                delta=to_principal,
                balance_before=credit.balance,
                balance_after=credit.balance + to_principal,
            )
        )
    if to_revenue > 0:
        lines.append(
            PostingLine(
                account=fees.ref,
                delta=to_revenue,
                balance_before=fees.balance,
                balance_after=fees.balance + to_revenue,
            )
        )

    posting = create_posting(
        operation_id=operation_id,
        kind=PostingKind.LOAN_REPAYMENT,
        scope=scope,
        currency=currency,
        amount=amount,
        reason=reason,
        occurred_at=now,
        lines=lines,
        metadata=metadata,
    )
    return BookingResult(posting=posting, balances=resulting_balances(posting))


def _assert_borrower(loan: Loan, account: Account) -> None:
    if account.ref != loan.borrower:
        raise LoanStateError(
            "That account is not the borrower",
            loan_id=loan.loan_id,
            borrower=account_key(loan.borrower),
            given=account_key(account.ref),
        )
    # No currency check follows: an AccountRef carries its currency, so the
    # comparison above has already settled it.


def _assert_timestamp(now: int) -> None:
    if not isinstance(now, int) or isinstance(now, bool):
        raise ValidationError("Timestamps are epoch milliseconds as integers", timestamp=now)


def _unused(*_args: object) -> None:  # pragma: no cover - documentation aid
    """Marker for arguments kept for symmetry. See :func:`repay`."""


_ = outstanding_after  # re-exported through economyworld.interest
