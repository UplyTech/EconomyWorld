"""Money that moves on a schedule: subscriptions, financing and payroll.

# Periods are milliseconds, not calendar months

There is no "monthly" here, because a month is a calendar question and a
calendar is a locale, a timezone and a set of rules about the 31st that this
package has no business holding an opinion about. A schedule has an interval in
milliseconds and a start; the caller decides what that means.

# Missed charges are caught up, not skipped

A bot that was down for three days owes three charges, not one.
:func:`charges_due` answers "how many are owed as of ``now``" from the schedule
alone, so an outage costs the operator nothing and a member is billed exactly
what they agreed to -- no more, because the count is bounded by the plan, and no
less, because it is computed rather than counted as they happen.

That is why a subscription stores ``charges_made`` rather than a "last charged"
flag: the number of charges owed is a function of the schedule and the clock,
and the two can be compared.

# Financing pays the seller now and bills the buyer later

An instalment plan is the seller being paid in full, immediately, out of
``system:credit`` -- and the buyer owing that credit account on a schedule. The
seller carries no risk and needs no special handling; the community carries the
debt, and it is on the books where it can be seen.

That is a different thing from a cash loan (:mod:`economyworld.credit`), which
pays the borrower. Both use the same amortisation arithmetic, so the two agree
about what an instalment costs.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
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
    CurrencyMismatchError,
    ScheduleError,
    ValidationError,
)
from .interest import AmortisationMethod, AmortisationSchedule, amortisation_schedule
from .ledger import PostingKind, PostingLine, create_posting, resulting_balances
from .money import assert_positive_amount, assert_whole_amount, distribute
from .rounding import Rounding
from .types import BookingResult

__all__ = [
    "ScheduleState",
    "RecurringPlan",
    "Subscription",
    "ChargeResult",
    "InstalmentPlan",
    "PayrollLine",
    "MAX_CATCH_UP",
    "create_plan",
    "start_subscription",
    "charges_due",
    "next_charge_at",
    "charge_subscription",
    "pause_subscription",
    "resume_subscription",
    "cancel_subscription",
    "finance_purchase",
    "run_payroll",
    "split_payroll",
]

#: Most charges one call will catch up on.
#:
#: A bot that has been down for a year should not silently take three hundred
#: and sixty-five payments out of a member's balance in one go. Past this the
#: call refuses and an operator has to decide what to do, which is the right
#: outcome for a situation nobody planned for.
MAX_CATCH_UP = 100


class ScheduleState(str, Enum):
    """Where a recurring arrangement is in its life."""

    ACTIVE = "ACTIVE"
    #: Temporarily stopped. Charges do not accrue while paused.
    PAUSED = "PAUSED"
    #: Stopped for good by somebody.
    CANCELLED = "CANCELLED"
    #: Ran to the end of its term.
    ENDED = "ENDED"


@dataclass(frozen=True)
class RecurringPlan:
    """What is charged, to whom, how often."""

    plan_id: str
    payer: AccountRef
    payee: AccountRef
    amount: int
    #: How long between charges, in milliseconds.
    interval_ms: int
    #: How many times it charges in total. ``None`` runs until cancelled.
    occurrences: int | None = None


@dataclass(frozen=True)
class Subscription:
    """A plan in progress, as the caller stores it."""

    subscription_id: str
    plan: RecurringPlan
    state: ScheduleState
    #: When the first charge became due.
    started_at: int
    #: How many charges have actually been taken.
    charges_made: int = 0
    #: Everything charged so far. For a statement.
    total_charged: int = 0
    #: When it was paused, so the pause can be subtracted from the schedule.
    paused_at: int | None = None
    #: Time spent paused, in milliseconds. Charges do not accrue during it.
    paused_ms: int = 0

    @property
    def is_active(self) -> bool:
        return self.state is ScheduleState.ACTIVE


@dataclass(frozen=True)
class ChargeResult:
    """What a run of charges did. Write both parts in one transaction."""

    booking: BookingResult | None
    subscription: Subscription
    #: How many charges this call took.
    charges: int
    amount: int


@dataclass(frozen=True)
class InstalmentPlan:
    """Goods bought now and paid for over time."""

    plan_id: str
    buyer: AccountRef
    seller: AccountRef
    #: What the goods cost. What the seller was paid.
    cash_price: int
    schedule: AmortisationSchedule
    opened_at: int
    paid_instalments: int = 0

    @property
    def total_payable(self) -> int:
        """What the buyer pays in the end, interest included."""
        return self.schedule.total_paid

    @property
    def cost_of_credit(self) -> int:
        """What financing it costs over paying cash."""
        return self.schedule.total_paid - self.cash_price


@dataclass(frozen=True)
class PayrollLine:
    """One person's share of a payroll run."""

    recipient: AccountRef
    amount: int


def create_plan(
    plan_id: str,
    payer: AccountRef,
    payee: AccountRef,
    amount: int,
    interval_ms: int,
    occurrences: int | None = None,
) -> RecurringPlan:
    """Build a validated recurring plan."""
    if not isinstance(plan_id, str) or not plan_id:
        raise ScheduleError("A plan needs a non-empty id", plan_id=plan_id)
    assert_positive_amount(amount)
    if not isinstance(interval_ms, int) or isinstance(interval_ms, bool) or interval_ms <= 0:
        raise ScheduleError(
            "interval_ms must be a positive integer number of milliseconds",
            interval_ms=interval_ms,
        )
    if occurrences is not None and (
        not isinstance(occurrences, int) or isinstance(occurrences, bool) or occurrences <= 0
    ):
        raise ScheduleError(
            "occurrences must be a positive integer or None", occurrences=occurrences
        )
    if payer == payee:
        raise ScheduleError(
            "A plan cannot charge an account to itself", account=account_key(payer)
        )
    if payer.currency != payee.currency:
        raise CurrencyMismatchError(expected=payer.currency, received=payee.currency)
    return RecurringPlan(
        plan_id=plan_id,
        payer=payer,
        payee=payee,
        amount=amount,
        interval_ms=interval_ms,
        occurrences=occurrences,
    )


def start_subscription(subscription_id: str, plan: RecurringPlan, now: int) -> Subscription:
    """Begin a plan.

    The first charge falls due one interval after the start, not immediately.
    A caller who wants to charge on sign-up books that themselves -- making the
    schedule do it would mean the first period is billed twice by anybody who
    also takes a joining payment.
    """
    if not isinstance(subscription_id, str) or not subscription_id:
        raise ScheduleError(
            "A subscription needs a non-empty id", subscription_id=subscription_id
        )
    _assert_timestamp(now)
    return Subscription(
        subscription_id=subscription_id,
        plan=plan,
        state=ScheduleState.ACTIVE,
        started_at=now,
    )


def charges_due(subscription: Subscription, now: int) -> int:
    """How many charges are owed as of ``now``.

    A function of the schedule, not a counter. A bot that missed a week comes
    back, asks this, and gets the number it owes -- and a bot that asks twice in
    the same second gets the same answer both times and charges once.
    """
    _assert_timestamp(now)
    if not subscription.is_active:
        return 0

    elapsed = now - subscription.started_at - subscription.paused_ms
    if elapsed < 0:
        return 0

    earned = elapsed // subscription.plan.interval_ms
    if subscription.plan.occurrences is not None:
        earned = min(earned, subscription.plan.occurrences)
    return max(0, earned - subscription.charges_made)


def next_charge_at(subscription: Subscription) -> int | None:
    """When the next charge falls due, or ``None`` when there is no next one."""
    plan = subscription.plan
    if not subscription.is_active:
        return None
    if plan.occurrences is not None and subscription.charges_made >= plan.occurrences:
        return None
    return (
        subscription.started_at
        + subscription.paused_ms
        + (subscription.charges_made + 1) * plan.interval_ms
    )


def charge_subscription(
    engine: EconomyEngine,
    subscription: Subscription,
    payer: Account,
    now: int,
    operation_id: str,
    reason: str,
    payee: Account | None = None,
    limit: int | None = None,
    metadata: Mapping[str, str] | None = None,
) -> ChargeResult:
    """Take every charge that is due, as one posting.

    One posting rather than one per charge: three missed weeks is one payment of
    three times the amount, which is what a member sees on their statement and
    what a single ``operation_id`` can make idempotent. A caller who wants them
    separate calls this once per charge with ``limit=1``.

    ``None`` comes back as the booking when nothing is due, which is the normal
    result of a scheduler that runs more often than the interval.
    """
    _assert_timestamp(now)
    due = charges_due(subscription, now)
    if limit is not None:
        if not isinstance(limit, int) or isinstance(limit, bool) or limit <= 0:
            raise ValidationError("limit must be a positive integer", limit=limit)
        due = min(due, limit)

    if due == 0:
        return ChargeResult(booking=None, subscription=subscription, charges=0, amount=0)
    if due > MAX_CATCH_UP:
        raise ScheduleError(
            f"{due} charges are due, which is past the {MAX_CATCH_UP} this will "
            "take at once. Decide what to do about the gap, then charge with a "
            "limit.",
            subscription_id=subscription.subscription_id,
            due=due,
            limit=MAX_CATCH_UP,
        )

    if payer.ref != subscription.plan.payer:
        raise ScheduleError(
            "That account is not the payer",
            expected=account_key(subscription.plan.payer),
            given=account_key(payer.ref),
        )

    amount = subscription.plan.amount * due
    assert_whole_amount(amount)

    booking = engine.transfer(
        source=payer,
        target=payee or empty_account(subscription.plan.payee),
        amount=amount,
        now=now,
        operation_id=operation_id,
        reason=reason,
        kind=PostingKind.RECURRING,
        metadata=metadata,
    )

    charges_made = subscription.charges_made + due
    ended = (
        subscription.plan.occurrences is not None
        and charges_made >= subscription.plan.occurrences
    )
    updated = replace(
        subscription,
        charges_made=charges_made,
        total_charged=subscription.total_charged + amount,
        state=ScheduleState.ENDED if ended else subscription.state,
    )
    return ChargeResult(booking=booking, subscription=updated, charges=due, amount=amount)


def pause_subscription(subscription: Subscription, now: int) -> Subscription:
    """Stop charges accruing, without ending the arrangement.

    The paused time is remembered and subtracted from the schedule, so a member
    who pauses for a month is not billed for it when they come back. Without
    that the pause would only postpone the bill, which is not what anybody means
    by pausing.
    """
    _assert_timestamp(now)
    if subscription.state is not ScheduleState.ACTIVE:
        raise ScheduleError(
            "Only an active subscription can be paused",
            subscription_id=subscription.subscription_id,
            state=subscription.state.value,
        )
    return replace(subscription, state=ScheduleState.PAUSED, paused_at=now)


def resume_subscription(subscription: Subscription, now: int) -> Subscription:
    """Start charges accruing again."""
    _assert_timestamp(now)
    if subscription.state is not ScheduleState.PAUSED:
        raise ScheduleError(
            "Only a paused subscription can be resumed",
            subscription_id=subscription.subscription_id,
            state=subscription.state.value,
        )
    paused_for = max(0, now - (subscription.paused_at or now))
    return replace(
        subscription,
        state=ScheduleState.ACTIVE,
        paused_at=None,
        paused_ms=subscription.paused_ms + paused_for,
    )


def cancel_subscription(subscription: Subscription, now: int) -> Subscription:
    """End it. Charges already due are still due until they are taken."""
    _assert_timestamp(now)
    if subscription.state in (ScheduleState.CANCELLED, ScheduleState.ENDED):
        raise ScheduleError(
            "That subscription is already over",
            subscription_id=subscription.subscription_id,
            state=subscription.state.value,
        )
    return replace(subscription, state=ScheduleState.CANCELLED)


# ---------------------------------------------------------------------------
# Financing
# ---------------------------------------------------------------------------


def finance_purchase(
    engine: EconomyEngine,
    plan_id: str,
    buyer: AccountRef,
    seller: Account,
    cash_price: int,
    rate_basis_points: int,
    instalments: int,
    now: int,
    operation_id: str,
    reason: str,
    method: AmortisationMethod = AmortisationMethod.EQUAL_INSTALMENT,
    rounding: Rounding = Rounding.DOWN,
    credit_account: Account | None = None,
    metadata: Mapping[str, str] | None = None,
) -> tuple[BookingResult, InstalmentPlan]:
    """Buy now, pay over time: the seller is paid in full today.

    The currency goes from ``system:credit`` to the seller, and the buyer owes
    the credit account on the returned schedule. Repayments go through
    :func:`~economyworld.credit.repay` with a loan built from the same schedule,
    or through the caller's own booking -- what matters is that the debt is on
    the books from the moment the goods change hands.

    The buyer's balance is untouched here. That is the point of financing.
    """
    _assert_timestamp(now)
    assert_positive_amount(cash_price)
    if buyer.currency != seller.ref.currency:
        raise CurrencyMismatchError(expected=seller.ref.currency, received=buyer.currency)
    if buyer == seller.ref:
        raise ScheduleError(
            "A member cannot finance a purchase from themselves",
            account=account_key(buyer),
        )

    schedule = amortisation_schedule(
        principal=cash_price,
        rate_basis_points=rate_basis_points,
        periods=instalments,
        method=method,
        rounding=rounding,
    )

    booking = engine.transfer(
        source=credit_account
        or empty_account(
            system_account(seller.ref.scope, seller.ref.currency, SystemAccount.CREDIT)
        ),
        target=seller,
        amount=cash_price,
        now=now,
        operation_id=operation_id,
        reason=reason,
        kind=PostingKind.LOAN_DISBURSEMENT,
        allow_negative=True,
        metadata=metadata,
    )

    return booking, InstalmentPlan(
        plan_id=plan_id,
        buyer=buyer,
        seller=seller.ref,
        cash_price=cash_price,
        schedule=schedule,
        opened_at=now,
    )


# ---------------------------------------------------------------------------
# Payroll
# ---------------------------------------------------------------------------


def run_payroll(
    engine: EconomyEngine,
    employer: Account,
    lines: Sequence[PayrollLine],
    now: int,
    operation_id: str,
    reason: str,
    recipients: Mapping[str, Account] | None = None,
    metadata: Mapping[str, str] | None = None,
) -> BookingResult:
    """Pay several members at once, as one posting.

    One posting because it is one event: a payroll run either happens or it does
    not, and half a payroll is the worst possible outcome. That is also why it
    is one posting rather than a list of transfers -- the caller writes it in a
    single transaction, and the "all or nothing" is the database's to enforce.

    ``recipients`` gives the current balances, keyed by account key, when the
    caller stores them and wants the posting's before-and-after figures to be
    right. Leave it out and they are computed from zero, exactly as the system
    accounts are elsewhere.
    """
    _assert_timestamp(now)
    if not lines:
        raise ScheduleError("A payroll run needs at least one line")

    total = 0
    for line in lines:
        assert_positive_amount(line.amount)
        if line.recipient.currency != employer.ref.currency:
            raise CurrencyMismatchError(
                expected=employer.ref.currency, received=line.recipient.currency
            )
        if line.recipient.scope != employer.ref.scope:
            raise ValidationError(
                "A payroll run cannot cross scopes",
                employer=employer.ref.scope,
                recipient=line.recipient.scope,
            )
        if line.recipient == employer.ref:
            raise ScheduleError(
                "A payroll run cannot pay the employer", account=account_key(employer.ref)
            )
        total += line.amount
    assert_whole_amount(total)

    seen = set()
    for line in lines:
        key = account_key(line.recipient)
        if key in seen:
            raise ScheduleError(
                "A payroll run must not pay the same account twice: add the "
                "amounts together instead",
                account=key,
            )
        seen.add(key)

    engine.currency(employer.ref.currency)
    if employer.balance < total:
        from .errors import InsufficientFundsError

        raise InsufficientFundsError(
            account=account_key(employer.ref),
            balance=employer.balance,
            required=total,
            currency=employer.ref.currency,
        )

    posting_lines = [
        PostingLine(
            account=employer.ref,
            delta=-total,
            balance_before=employer.balance,
            balance_after=employer.balance - total,
        )
    ]
    for line in lines:
        key = account_key(line.recipient)
        before = recipients[key].balance if recipients and key in recipients else 0
        posting_lines.append(
            PostingLine(
                account=line.recipient,
                delta=line.amount,
                balance_before=before,
                balance_after=before + line.amount,
            )
        )

    posting = create_posting(
        operation_id=operation_id,
        kind=PostingKind.RECURRING,
        scope=employer.ref.scope,
        currency=employer.ref.currency,
        amount=total,
        reason=reason,
        occurred_at=now,
        lines=posting_lines,
        metadata=metadata,
    )
    return BookingResult(posting=posting, balances=resulting_balances(posting))


def split_payroll(
    total: int, recipients: Sequence[AccountRef], weights: Sequence[int] | None = None
) -> list[PayrollLine]:
    """Divide a pot between recipients, exactly.

    For a community that pays out a fixed budget rather than fixed salaries.
    The shares add up to the pot; see
    :func:`~economyworld.money.distribute` for why that needs saying.
    """
    if not recipients:
        raise ScheduleError("There is nobody to pay")
    shares = distribute(total, list(weights) if weights is not None else [1] * len(recipients))
    return [
        PayrollLine(recipient=recipient, amount=share)
        for recipient, share in zip(recipients, shares, strict=True)
        if share > 0
    ]


def _assert_timestamp(now: int) -> None:
    if not isinstance(now, int) or isinstance(now, bool):
        raise ValidationError("Timestamps are epoch milliseconds as integers", timestamp=now)
