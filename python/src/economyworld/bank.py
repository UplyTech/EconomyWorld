"""Deposits, term accounts and holds.

A current account is a balance. A **deposit** is a balance that has been put
somewhere for a reason: to earn interest, or to be locked until a date. This
module is the difference between the two.

# A deposit is a real movement, not a flag

When a member deposits, the currency leaves their account and arrives in the
scope's ``system:bank`` account. That is deliberate and it costs a posting,
because the alternative -- a "savings" number stored beside the balance -- makes
"how much is on deposit in this community?" a question you answer by summing
every member's row and hoping none of them is stale. Here it is one balance,
and the books close on it.

# Interest is minted, and the posting says so

Interest paid on a deposit is new currency: it comes from ``system:mint``, like
every other issuance, and the mint's balance goes more negative by exactly the
amount paid. There is no other honest way to do it in a closed economy, and
pretending otherwise is how a community ends up unable to say where its money
came from.

An operator who wants interest funded out of collected fees rather than minted
passes the fee account as the source. The posting then says *that*, and the
money supply does not move.

# A hold is not a posting

A hold reserves funds without moving them: an order placed, a bid made, a
purchase authorised but not captured. Nothing is booked until the hold is
captured, and a hold that expires releases itself.

That is why :func:`place_hold` returns a :class:`Hold` rather than a posting.
The caller stores it, and every balance check that should respect it goes
through :func:`available_balance`.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace

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
    DepositError,
    HoldError,
    InsufficientFundsError,
    ValidationError,
)
from .interest import AccrualBasis, accrue_interest
from .ledger import PostingKind
from .money import apply_basis_points, assert_positive_amount, assert_whole_amount
from .rounding import Rounding
from .types import BookingResult

__all__ = [
    "DepositTerms",
    "Deposit",
    "Hold",
    "create_deposit_terms",
    "open_deposit",
    "deposit",
    "withdraw",
    "accrue_deposit_interest",
    "is_mature",
    "maturity_value",
    "early_withdrawal_penalty",
    "place_hold",
    "release_hold",
    "capture_hold",
    "held_amount",
    "available_balance",
    "active_holds",
    "place_in_escrow",
    "release_from_escrow",
    "settle_from_escrow",
]


@dataclass(frozen=True)
class DepositTerms:
    """What a deposit account pays, and what it asks in return."""

    #: What the deposit earns each period, in basis points.
    rate_basis_points: int = 0
    #: Whether interest earns interest.
    basis: AccrualBasis = AccrualBasis.COMPOUND
    #: How each period's interest is rounded. ``DOWN`` favours the economy,
    #: ``UP`` favours the member; whichever is chosen, both sides of the
    #: posting use the same number.
    rounding: Rounding = Rounding.DOWN
    #: How long the money is locked, in milliseconds. ``0`` is an on-demand
    #: account: deposit and withdraw whenever you like.
    term_ms: int = 0
    #: What withdrawing before maturity costs, in basis points of the interest
    #: earned so far. ``10000`` forfeits all of it.
    #:
    #: The penalty is taken out of the *interest*, never out of the principal.
    #: A term account that can hand a member back less than they put in is a
    #: product nobody should ship by accident.
    early_withdrawal_penalty_bp: int = 0
    #: The least that may be left on deposit. A withdrawal that would leave
    #: less takes the whole balance instead.
    minimum_balance: int = 0


@dataclass(frozen=True)
class Deposit:
    """A member's deposit, as the caller stores it."""

    deposit_id: str
    #: Whose it is. The account the money came from and returns to.
    owner: AccountRef
    terms: DepositTerms
    #: The amount put in, less anything withdrawn. Never includes interest.
    principal: int
    #: Interest credited so far and not yet withdrawn.
    accrued_interest: int
    #: When the deposit was opened, in epoch milliseconds.
    opened_at: int
    #: When interest was last credited. Interest accrues from here.
    last_accrued_at: int
    #: Periods already credited, so a caller can see the history line up.
    periods_accrued: int = 0

    @property
    def balance(self) -> int:
        """Principal plus interest: what the member would get back today."""
        return self.principal + self.accrued_interest


@dataclass(frozen=True)
class Hold:
    """Funds reserved on an account without being moved.

    An authorisation, not a payment. It exists so that a member cannot spend the
    same balance twice while an order sits on a book or a bid stands in an
    auction, and it disappears on its own when it expires.
    """

    hold_id: str
    account: AccountRef
    amount: int
    placed_at: int
    #: When the hold stops reserving anything. ``None`` never expires, which
    #: should be rare: a hold nobody releases is a member who cannot spend.
    expires_at: int | None
    reason: str


def create_deposit_terms(
    rate_basis_points: int = 0,
    basis: AccrualBasis = AccrualBasis.COMPOUND,
    rounding: Rounding = Rounding.DOWN,
    term_ms: int = 0,
    early_withdrawal_penalty_bp: int = 0,
    minimum_balance: int = 0,
) -> DepositTerms:
    """Build validated deposit terms."""
    if not isinstance(term_ms, int) or isinstance(term_ms, bool) or term_ms < 0:
        raise DepositError("term_ms must be a non-negative integer", term_ms=term_ms)
    if (
        not isinstance(early_withdrawal_penalty_bp, int)
        or isinstance(early_withdrawal_penalty_bp, bool)
        or not 0 <= early_withdrawal_penalty_bp <= 10_000
    ):
        raise DepositError(
            "early_withdrawal_penalty_bp must be between 0 and 10000 basis points",
            early_withdrawal_penalty_bp=early_withdrawal_penalty_bp,
        )
    if term_ms == 0 and early_withdrawal_penalty_bp != 0:
        raise DepositError(
            "An on-demand account cannot have an early-withdrawal penalty: "
            "there is nothing to be early for",
            term_ms=term_ms,
            early_withdrawal_penalty_bp=early_withdrawal_penalty_bp,
        )
    assert_whole_amount(minimum_balance)
    if minimum_balance < 0:
        raise DepositError(
            "minimum_balance cannot be negative", minimum_balance=minimum_balance
        )
    return DepositTerms(
        rate_basis_points=rate_basis_points,
        basis=basis,
        rounding=rounding,
        term_ms=term_ms,
        early_withdrawal_penalty_bp=early_withdrawal_penalty_bp,
        minimum_balance=minimum_balance,
    )


def open_deposit(deposit_id: str, owner: AccountRef, terms: DepositTerms, now: int) -> Deposit:
    """An empty deposit, before anything has been paid into it."""
    if not isinstance(deposit_id, str) or not deposit_id:
        raise ValidationError("A deposit needs a non-empty id", deposit_id=deposit_id)
    _assert_timestamp(now)
    return Deposit(
        deposit_id=deposit_id,
        owner=owner,
        terms=terms,
        principal=0,
        accrued_interest=0,
        opened_at=now,
        last_accrued_at=now,
        periods_accrued=0,
    )


def deposit(
    engine: EconomyEngine,
    account: Deposit,
    from_account: Account,
    amount: int,
    now: int,
    operation_id: str,
    reason: str,
    bank_account: Account | None = None,
    metadata: Mapping[str, str] | None = None,
) -> tuple[BookingResult, Deposit]:
    """Move currency out of a member's balance and onto deposit.

    Returns the posting *and* the updated deposit. Both belong in the same
    database transaction, for the same reason every other pair in this package
    does: a deposit whose principal grew but whose posting was never written is
    currency invented by a crash.
    """
    assert_positive_amount(amount)
    _assert_timestamp(now)
    _assert_owner(account, from_account)

    booking = engine.transfer(
        source=from_account,
        target=bank_account
        or empty_account(
            system_account(account.owner.scope, account.owner.currency, SystemAccount.BANK)
        ),
        amount=amount,
        now=now,
        operation_id=operation_id,
        reason=reason,
        kind=PostingKind.DEPOSIT,
        metadata=metadata,
    )
    return booking, replace(account, principal=account.principal + amount)


def withdraw(
    engine: EconomyEngine,
    account: Deposit,
    to_account: Account,
    amount: int,
    now: int,
    operation_id: str,
    reason: str,
    bank_account: Account | None = None,
    metadata: Mapping[str, str] | None = None,
) -> tuple[BookingResult, Deposit]:
    """Take currency back off deposit.

    Interest is drawn down before principal, which is the order every deposit
    product uses and the one that makes an early-withdrawal penalty possible:
    the penalty comes out of interest, so it has to be spent last.

    Withdrawing before maturity costs
    :meth:`~DepositTerms.early_withdrawal_penalty_bp` of the interest earned.
    The penalty is *forfeited*, not paid to anybody -- it never left the mint,
    so the posting simply issues less.
    """
    assert_positive_amount(amount)
    _assert_timestamp(now)
    _assert_owner(account, to_account)

    penalty = early_withdrawal_penalty(account, now)
    withdrawable = account.balance - penalty

    if amount > withdrawable:
        raise DepositError(
            "The deposit does not hold that much",
            deposit_id=account.deposit_id,
            available=withdrawable,
            requested=amount,
            penalty=penalty,
        )

    remaining = withdrawable - amount
    if 0 < remaining < account.terms.minimum_balance:
        raise DepositError(
            "That withdrawal would leave less than the minimum balance; "
            "withdraw everything or less",
            deposit_id=account.deposit_id,
            minimum_balance=account.terms.minimum_balance,
            would_leave=remaining,
        )

    # Interest first, then principal. The penalty is taken off the interest
    # before any of it is drawn, so a member who forfeits it cannot also spend
    # it in the same call.
    interest_available = max(0, account.accrued_interest - penalty)
    from_interest = min(amount, interest_available)
    from_principal = amount - from_interest

    booking = engine.transfer(
        source=bank_account
        or empty_account(
            system_account(account.owner.scope, account.owner.currency, SystemAccount.BANK)
        ),
        target=to_account,
        amount=amount,
        now=now,
        operation_id=operation_id,
        reason=reason,
        kind=PostingKind.WITHDRAWAL,
        allow_negative=True,
        metadata=metadata,
    )

    updated = replace(
        account,
        principal=account.principal - from_principal,
        # Whatever the penalty forfeited leaves with the withdrawal: it is not
        # kept on the books as interest the member no longer has a claim to.
        accrued_interest=account.accrued_interest - from_interest - penalty,
    )
    return booking, updated


def accrue_deposit_interest(
    engine: EconomyEngine,
    account: Deposit,
    periods: int,
    now: int,
    operation_id: str,
    reason: str,
    source: Account | None = None,
    bank_account: Account | None = None,
    metadata: Mapping[str, str] | None = None,
) -> tuple[BookingResult | None, Deposit]:
    """Credit interest for a number of periods.

    ``None`` comes back instead of a posting when there is nothing to credit --
    a zero rate, an empty account, a rate too small to earn a whole unit. That
    is an ordinary outcome and not an error, and a caller running this nightly
    across a whole community will see a lot of it.

    **How long a period is, is yours.** This function applies a rate ``periods``
    times; whether that means a day or a message is a decision about your
    economy. ``now`` is recorded so a caller can tell when interest was last
    paid, but it is never used to work out how much: a function that read the
    clock could not be tested.
    """
    _assert_timestamp(now)
    if not isinstance(periods, int) or isinstance(periods, bool) or periods < 0:
        raise ValidationError("periods must be a non-negative integer", periods=periods)

    interest = accrue_interest(
        principal=account.balance,
        rate_basis_points=account.terms.rate_basis_points,
        periods=periods,
        basis=account.terms.basis,
        rounding=account.terms.rounding,
    )

    updated = replace(
        account,
        accrued_interest=account.accrued_interest + interest,
        last_accrued_at=now,
        periods_accrued=account.periods_accrued + periods,
    )

    if interest == 0:
        return None, updated

    booking = engine.transfer(
        source=source
        or empty_account(
            system_account(account.owner.scope, account.owner.currency, SystemAccount.MINT)
        ),
        target=bank_account
        or empty_account(
            system_account(account.owner.scope, account.owner.currency, SystemAccount.BANK)
        ),
        amount=interest,
        now=now,
        operation_id=operation_id,
        reason=reason,
        kind=PostingKind.INTEREST,
        allow_negative=True,
        metadata=metadata,
    )
    return booking, updated


def is_mature(account: Deposit, now: int) -> bool:
    """Whether the lock-up has run out. Always true for an on-demand account."""
    _assert_timestamp(now)
    if account.terms.term_ms == 0:
        return True
    return now >= account.opened_at + account.terms.term_ms


def maturity_value(account: Deposit, periods: int) -> int:
    """What the deposit would be worth after another ``periods`` of interest.

    A projection, for a screen that tells a member what locking their money up
    is worth. It books nothing and reads no clock.
    """
    return account.balance + accrue_interest(
        principal=account.balance,
        rate_basis_points=account.terms.rate_basis_points,
        periods=periods,
        basis=account.terms.basis,
        rounding=account.terms.rounding,
    )


def early_withdrawal_penalty(account: Deposit, now: int) -> int:
    """What withdrawing right now would forfeit.

    Zero once the deposit is mature, and zero for an on-demand account. Always
    a share of the *interest*, never of the principal.
    """
    if is_mature(account, now) or account.terms.early_withdrawal_penalty_bp == 0:
        return 0
    if account.accrued_interest <= 0:
        return 0
    return apply_basis_points(
        account.accrued_interest,
        account.terms.early_withdrawal_penalty_bp,
        Rounding.DOWN,
    )


# ---------------------------------------------------------------------------
# Holds
# ---------------------------------------------------------------------------


def place_hold(
    hold_id: str,
    account: Account,
    amount: int,
    now: int,
    reason: str,
    existing: Sequence[Hold] = (),
    expires_at: int | None = None,
) -> Hold:
    """Reserve funds without moving them.

    Checked against what is *available* rather than against the balance, so two
    holds cannot reserve the same currency twice. That check is the entire
    reason holds exist: without it a member can place an order, bid in an
    auction and buy from a shop with one balance, and two of the three fail at
    settlement when the money has already gone.
    """
    if not isinstance(hold_id, str) or not hold_id:
        raise ValidationError("A hold needs a non-empty id", hold_id=hold_id)
    assert_positive_amount(amount)
    _assert_timestamp(now)
    if expires_at is not None:
        _assert_timestamp(expires_at)
        if expires_at <= now:
            raise HoldError(
                "A hold cannot expire before it is placed",
                placed_at=now,
                expires_at=expires_at,
            )
    for held in existing:
        if held.hold_id == hold_id:
            raise HoldError("That hold id is already in use", hold_id=hold_id)

    available = available_balance(account, existing, now)
    if amount > available:
        raise InsufficientFundsError(
            account=account_key(account.ref),
            balance=available,
            required=amount,
            currency=account.ref.currency,
        )

    return Hold(
        hold_id=hold_id,
        account=account.ref,
        amount=amount,
        placed_at=now,
        expires_at=expires_at,
        reason=reason,
    )


def release_hold(holds: Sequence[Hold], hold_id: str) -> list[Hold]:
    """Drop a hold, freeing the funds. Nothing is booked."""
    remaining = [held for held in holds if held.hold_id != hold_id]
    if len(remaining) == len(holds):
        raise HoldError("No such hold", hold_id=hold_id)
    return remaining


def capture_hold(
    engine: EconomyEngine,
    hold: Hold,
    source: Account,
    target: Account,
    now: int,
    operation_id: str,
    reason: str,
    amount: int | None = None,
    holds: Sequence[Hold] = (),
    kind: PostingKind = PostingKind.TRANSFER,
    metadata: Mapping[str, str] | None = None,
) -> tuple[BookingResult, list[Hold]]:
    """Turn a hold into a real movement.

    Capturing for less than was held is allowed and is the normal case for
    anything priced at the time it is authorised: the difference is simply
    released. Capturing for more is not -- that would spend currency the hold
    never reserved.
    """
    _assert_timestamp(now)
    taking = hold.amount if amount is None else amount
    assert_positive_amount(taking)
    if taking > hold.amount:
        raise HoldError(
            "A capture cannot take more than the hold reserved",
            hold_id=hold.hold_id,
            held=hold.amount,
            requested=taking,
        )
    if source.ref != hold.account:
        raise HoldError(
            "The hold is on a different account",
            hold=account_key(hold.account),
            source=account_key(source.ref),
        )
    if hold.expires_at is not None and now >= hold.expires_at:
        raise HoldError(
            "The hold has expired", hold_id=hold.hold_id, expires_at=hold.expires_at
        )

    booking = engine.transfer(
        source=source,
        target=target,
        amount=taking,
        now=now,
        operation_id=operation_id,
        reason=reason,
        kind=kind,
        # The hold already reserved these funds, so the balance check that
        # matters happened when it was placed.
        allow_negative=False,
        metadata=metadata,
    )
    return booking, [held for held in holds if held.hold_id != hold.hold_id]


def active_holds(holds: Sequence[Hold], now: int) -> list[Hold]:
    """The holds that still reserve anything at ``now``."""
    _assert_timestamp(now)
    return [held for held in holds if held.expires_at is None or now < held.expires_at]


def held_amount(holds: Sequence[Hold], now: int) -> int:
    """How much the active holds reserve in total."""
    return sum(held.amount for held in active_holds(holds, now))


def available_balance(account: Account, holds: Sequence[Hold], now: int) -> int:
    """The balance minus what is held: what the member can actually spend.

    The number a bot should show and a spend should be checked against. It can
    be negative if the balance fell below what was held -- through a fee, or a
    decay run -- and that is reported rather than clamped, because a caller
    that sees it needs to decide what to do about it.
    """
    relevant = [held for held in holds if held.account == account.ref]
    return account.balance - held_amount(relevant, now)


# ---------------------------------------------------------------------------
# internals
# ---------------------------------------------------------------------------


def _assert_owner(account: Deposit, member: Account) -> None:
    if member.ref != account.owner:
        raise DepositError(
            "That account does not own this deposit",
            deposit_id=account.deposit_id,
            owner=account_key(account.owner),
            given=account_key(member.ref),
        )
    # No currency check follows: an AccountRef carries its currency, so the
    # comparison above has already settled it.


# ---------------------------------------------------------------------------
# Escrow
#
# A hold reserves a balance where it is. Escrow moves it. Both stop a member
# promising the same currency twice; they differ in what the counterparty can
# see and in what happens if the caller crashes half way through.
# ---------------------------------------------------------------------------


def place_in_escrow(
    engine: EconomyEngine,
    source: Account,
    amount: int,
    now: int,
    operation_id: str,
    reason: str,
    escrow_account: Account | None = None,
    metadata: Mapping[str, str] | None = None,
) -> BookingResult:
    """Move currency out of a member's balance and into the scope's escrow.

    The heavier sibling of :func:`place_hold`, and the choice is a real one:

    ==============  ===========================================================
    :func:`place_hold`   Nothing is booked. The balance stays where it is and is
                         merely not spendable. Cheap, reversible, and invisible
                         to anybody but the caller -- a counterparty has to take
                         the caller's word that the funds exist.
    ``place_in_escrow``  A posting. The currency is really in a third account,
                         which both sides can see, and it is out of the payer's
                         reach even if the caller's process dies.
    ==============  ===========================================================

    Use a hold for an order on a book that may never fill. Use escrow for a
    high-value trade where the seller wants to see the money before they hand
    anything over.

    Escrow is *not* used by :func:`~economyworld.trade.settle_trade`: a trade
    moves nothing until it settles, which is what makes an abandoned trade
    harmless. A caller who wants funds escrowed while a trade is open books it
    here, and releases or settles it themselves.
    """
    assert_positive_amount(amount)
    _assert_timestamp(now)
    return engine.transfer(
        source=source,
        target=escrow_account
        or empty_account(
            system_account(source.ref.scope, source.ref.currency, SystemAccount.ESCROW)
        ),
        amount=amount,
        now=now,
        operation_id=operation_id,
        reason=reason,
        kind=PostingKind.ESCROW,
        metadata=metadata,
    )


def release_from_escrow(
    engine: EconomyEngine,
    target: Account,
    amount: int,
    now: int,
    operation_id: str,
    reason: str,
    escrow_account: Account | None = None,
    metadata: Mapping[str, str] | None = None,
) -> BookingResult:
    """Give escrowed currency back: the deal fell through.

    Books ``PostingKind.ESCROW_RELEASE`` rather than ``ESCROW``, so a statement
    reads "went into escrow, came back out" instead of two identical lines a
    member has to work out for themselves.

    **Pass ``escrow_account`` if you store system balances.** Doing so is what
    stops a release exceeding what is actually in escrow: the engine lets a
    system account go negative on purpose, so without the account this function
    has nothing to check against. See :func:`_assert_escrow_covers`.
    """
    assert_positive_amount(amount)
    _assert_timestamp(now)
    _assert_escrow_covers(escrow_account, amount)
    return engine.transfer(
        source=escrow_account
        or empty_account(
            system_account(target.ref.scope, target.ref.currency, SystemAccount.ESCROW)
        ),
        target=target,
        amount=amount,
        now=now,
        operation_id=operation_id,
        reason=reason,
        kind=PostingKind.ESCROW_RELEASE,
        metadata=metadata,
    )


def settle_from_escrow(
    engine: EconomyEngine,
    target: Account,
    amount: int,
    now: int,
    operation_id: str,
    reason: str,
    escrow_account: Account | None = None,
    metadata: Mapping[str, str] | None = None,
) -> BookingResult:
    """Pay escrowed currency to the counterparty: the deal went through.

    The same posting shape as :func:`release_from_escrow` and a different kind,
    because "the seller was paid" and "the buyer got their money back" are the
    two outcomes an operator will be asked to tell apart six months later. Pass
    ``escrow_account`` for the same reason as there.
    """
    assert_positive_amount(amount)
    _assert_timestamp(now)
    _assert_escrow_covers(escrow_account, amount)
    return engine.transfer(
        source=escrow_account
        or empty_account(
            system_account(target.ref.scope, target.ref.currency, SystemAccount.ESCROW)
        ),
        target=target,
        amount=amount,
        now=now,
        operation_id=operation_id,
        reason=reason,
        kind=PostingKind.SETTLEMENT,
        metadata=metadata,
    )


def _assert_escrow_covers(escrow: Account | None, amount: int) -> None:
    """Refuse to take more out of escrow than the caller says is in it.

    The engine lets a system account go negative on purpose -- the mint issues,
    the market pays a seller before anybody has paid it, and a caller who does
    not store system balances passes nothing and gets a zero it is meant to
    ignore. That rule is right for those accounts and wrong for this one:
    escrow holds what was put in it, and a negative escrow balance is currency
    paid out that nobody ever escrowed.

    So the check is here rather than in the engine, and it is conditional on
    the caller having handed the account over. Pass the escrow account and this
    will not let a release exceed it; pass nothing and it cannot know, which is
    the same bargain the rest of the library strikes about system balances.
    """
    if escrow is not None and escrow.balance < amount:
        raise InsufficientFundsError(
            account=account_key(escrow.ref),
            balance=escrow.balance,
            required=amount,
            currency=escrow.ref.currency,
        )


def _assert_timestamp(now: int) -> None:
    if not isinstance(now, int) or isinstance(now, bool):
        raise ValidationError("Timestamps are epoch milliseconds as integers", timestamp=now)
