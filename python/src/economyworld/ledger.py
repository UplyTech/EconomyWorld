"""Postings: the complete, indivisible bookings this package produces.

# The one rule this package cannot enforce for you

A posting's lines always sum to zero: whatever leaves one account arrives in
another.

**EconomyWorld does not store anything, so it cannot make the write atomic.
You must.**

.. code-block:: sql

    BEGIN;
      UPDATE accounts SET balance = ... WHERE ...;   -- every line
      UPDATE accounts SET balance = ... WHERE ...;
      INSERT INTO postings (operation_id, ...) ...;  -- the posting itself
    COMMIT;

Writing the lines one at a time, outside a transaction, is how currency appears
from nowhere or vanishes. In a community both are noticed, and both destroy
trust in the whole system. This is the limit of being storage-agnostic, and it
is stated plainly rather than glossed over.

The second half of the same obligation: ``operation_id`` must be a UNIQUE
column. A retried request that books twice is the other way balances go wrong,
and only your database can prevent it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType
from typing import Any

from .accounts import AccountRef, account_key, parse_account_key
from .errors import UnbalancedPostingError, ValidationError

__all__ = [
    "PostingKind",
    "PostingLine",
    "Posting",
    "create_posting",
    "is_balanced",
    "assert_balanced",
    "net_change",
    "resulting_balances",
    "serialize_posting",
    "deserialize_posting",
    "InMemoryOperationLog",
]


class PostingKind(str, Enum):
    """What kind of event produced a posting."""

    #: New currency issued into the economy.
    CREDIT = "CREDIT"
    #: Currency taken out of the economy.
    DEBIT = "DEBIT"
    #: Currency moved between two member accounts.
    TRANSFER = "TRANSFER"
    #: Currency issued by an earning rule.
    EARN = "EARN"
    #: Payment for a shop offer.
    PURCHASE = "PURCHASE"
    #: Settlement of a trade between two members.
    TRADE = "TRADE"
    #: The exact inverse of an earlier posting.
    REVERSAL = "REVERSAL"
    #: Currency removed by decay or demurrage.
    DECAY = "DECAY"
    #: Currency moved from a member's balance onto deposit.
    DEPOSIT = "DEPOSIT"
    #: Currency taken back off deposit.
    WITHDRAWAL = "WITHDRAWAL"
    #: Interest credited on a deposit, or charged on a debt.
    INTEREST = "INTEREST"
    #: A loan paid out to the borrower.
    LOAN_DISBURSEMENT = "LOAN_DISBURSEMENT"
    #: An instalment, or a repayment in full.
    LOAN_REPAYMENT = "LOAN_REPAYMENT"
    #: A debt given up on, removed from the books.
    WRITE_OFF = "WRITE_OFF"
    #: A fee or a tax.
    FEE = "FEE"
    #: A coupon or dividend paid on an instrument.
    DISTRIBUTION = "DISTRIBUTION"
    #: One currency swapped for another, or an instrument bought or sold.
    EXCHANGE = "EXCHANGE"
    #: A market order or an auction settling.
    SETTLEMENT = "SETTLEMENT"
    #: A scheduled charge: a subscription, a standing order, a payroll run.
    RECURRING = "RECURRING"
    #: Currency moved into escrow while a deal is open.
    ESCROW = "ESCROW"
    #: Escrowed currency given back because the deal fell through. Distinct from
    #: ``SETTLEMENT`` on purpose: "you got your money back" and "the seller was
    #: paid" are the two outcomes an operator is asked to tell apart later.
    ESCROW_RELEASE = "ESCROW_RELEASE"


@dataclass(frozen=True)
class PostingLine:
    """One account's share of a posting."""

    account: AccountRef
    #: Signed change. Negative leaves the account, positive arrives.
    delta: int
    balance_before: int
    balance_after: int


@dataclass(frozen=True)
class Posting:
    """A complete, indivisible booking."""

    #: The caller's idempotency key. Must be unique across all postings.
    operation_id: str
    kind: PostingKind
    scope: str
    currency: str
    #: The absolute amount that moved. Always positive.
    amount: int
    #: Why this happened, in the caller's own words. Shown in audit trails.
    reason: str
    #: Epoch milliseconds, handed in by the caller.
    occurred_at: int
    lines: tuple[PostingLine, ...]
    #: The ``operation_id`` this posting reverses, or ``None``.
    reverses: str | None = None
    #: Free-form context. Strings only, so it survives any storage layer.
    metadata: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))


def create_posting(
    operation_id: str,
    kind: PostingKind,
    scope: str,
    currency: str,
    amount: int,
    reason: str,
    occurred_at: int,
    lines: Sequence[PostingLine],
    reverses: str | None = None,
    metadata: Mapping[str, str] | None = None,
) -> Posting:
    """Build a posting and check it before it leaves the library.

    The balance check is not a formality: it is the single assertion that makes
    the whole double-entry design worth having. A posting that does not balance
    never reaches the caller.
    """
    if not isinstance(operation_id, str) or not operation_id:
        raise ValidationError(
            "A posting needs a non-empty operation_id", operation_id=operation_id
        )
    if not isinstance(reason, str) or not reason:
        raise ValidationError("A posting needs a non-empty reason", operation_id=operation_id)
    if not isinstance(occurred_at, int) or isinstance(occurred_at, bool):
        raise ValidationError(
            "occurred_at must be an epoch-millisecond timestamp",
            occurred_at=occurred_at,
        )
    if len(lines) < 2:
        raise ValidationError(
            "A posting needs at least two lines -- every booking has a source "
            "and a destination",
            operation_id=operation_id,
            lines=len(lines),
        )

    total = 0
    for line in lines:
        if not isinstance(line.delta, int) or isinstance(line.delta, bool):
            raise ValidationError("A posting line delta must be an integer", delta=line.delta)
        if line.balance_before + line.delta != line.balance_after:
            raise ValidationError(
                "A posting line does not add up: balance_before + delta must "
                "equal balance_after",
                account=account_key(line.account),
                balance_before=line.balance_before,
                delta=line.delta,
                balance_after=line.balance_after,
            )
        if line.account.currency != currency:
            raise ValidationError(
                "Every line of a posting must use its currency",
                expected=currency,
                received=line.account.currency,
            )
        if line.account.scope != scope:
            raise ValidationError(
                "Every line of a posting must be in its scope",
                expected=scope,
                received=line.account.scope,
            )
        total += line.delta

    if total != 0:
        raise UnbalancedPostingError(operation_id, total)

    return Posting(
        operation_id=operation_id,
        kind=kind,
        scope=scope,
        currency=currency,
        amount=amount,
        reason=reason,
        occurred_at=occurred_at,
        lines=tuple(lines),
        reverses=reverses,
        metadata=MappingProxyType(dict(metadata or {})),
    )


def is_balanced(posting: Posting) -> bool:
    """True when the posting's lines sum to zero."""
    return sum(line.delta for line in posting.lines) == 0


def assert_balanced(posting: Posting) -> None:
    """Raise unless the posting balances.

    Worth calling in your own tests, and in an assertion around your
    transaction, if you build postings by hand.
    """
    total = sum(line.delta for line in posting.lines)
    if total != 0:
        raise UnbalancedPostingError(posting.operation_id, total)


def net_change(posting: Posting, ref: AccountRef) -> int:
    """What this posting did to one account. ``0`` when it did not touch it."""
    return sum(line.delta for line in posting.lines if line.account == ref)


def resulting_balances(posting: Posting) -> dict[str, int]:
    """The resulting balance of every account the posting touched."""
    return {account_key(line.account): line.balance_after for line in posting.lines}


def serialize_posting(posting: Posting) -> dict[str, Any]:
    """Plain-dict form, ready for :func:`json.dumps` or a JSONB column."""
    return {
        "operationId": posting.operation_id,
        "kind": posting.kind.value,
        "scope": posting.scope,
        "currency": posting.currency,
        "amount": posting.amount,
        "reason": posting.reason,
        "occurredAt": posting.occurred_at,
        "reverses": posting.reverses,
        "metadata": dict(posting.metadata),
        "lines": [
            {
                "account": account_key(line.account),
                "delta": line.delta,
                "balanceBefore": line.balance_before,
                "balanceAfter": line.balance_after,
            }
            for line in posting.lines
        ],
    }


def deserialize_posting(raw: Mapping[str, Any]) -> Posting:
    """Rebuild a posting from stored data, re-running every check."""
    if not isinstance(raw, Mapping):
        raise ValidationError("A stored posting must be a mapping")
    raw_lines = raw.get("lines")
    if not isinstance(raw_lines, (list, tuple)):
        raise ValidationError("A stored posting must carry its lines")

    lines = [
        PostingLine(
            account=parse_account_key(str(line["account"])),
            delta=int(line["delta"]),
            balance_before=int(line["balanceBefore"]),
            balance_after=int(line["balanceAfter"]),
        )
        for line in raw_lines
    ]

    return create_posting(
        operation_id=str(raw.get("operationId", "")),
        kind=PostingKind(raw["kind"]),
        scope=str(raw.get("scope", "")),
        currency=str(raw.get("currency", "")),
        amount=int(raw.get("amount", 0)),
        reason=str(raw.get("reason", "")),
        occurred_at=int(raw.get("occurredAt", 0)),
        lines=lines,
        reverses=raw.get("reverses"),
        metadata=raw.get("metadata") or {},
    )


class InMemoryOperationLog:
    """An idempotency guard you can use in tests and examples.

    **This is not the real thing.** In production the guarantee has to come from
    a ``UNIQUE`` constraint on the ``operation_id`` column, inside the same
    transaction as the balance updates. An in-memory set does not survive a
    restart, and does not help when two processes handle the retry.
    """

    def __init__(self) -> None:
        self._seen: set[str] = set()

    def is_new(self, operation_id: str) -> bool:
        """True when this operation id has not been booked before."""
        return operation_id not in self._seen

    def record(self, operation_id: str) -> bool:
        """Record an operation id. Returns False when it was already there."""
        if operation_id in self._seen:
            return False
        self._seen.add(operation_id)
        return True

    @property
    def size(self) -> int:
        return len(self._seen)

    def clear(self) -> None:
        self._seen.clear()
