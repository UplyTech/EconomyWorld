"""Account references, and the system accounts every scope implicitly has.

Every booking in EconomyWorld is double-entry: what leaves one account arrives
in another, and the lines of a posting always sum to zero. That is what makes
"no currency appeared from nowhere" a property you can *check* rather than hope
for.

But new money does have to enter the economy somewhere, and spent money has to
leave it. The system accounts are that somewhere. They are allowed to go
arbitrarily negative -- the mint's balance is simply how much currency it has
issued, with a minus sign.

**Whether you store them is your choice.** When you do not hand a system
account to :meth:`~economyworld.engine.EconomyEngine.credit`, ``debit``,
``earn`` or ``apply_decay``, the engine fills one in with a balance of zero. The
member's line is exact either way, and the posting still balances -- but the
system line's ``balance_before`` and ``balance_after`` are then meaningless,
because the engine has no idea what the mint held. So pick one and stay with it:

- **Do not store system accounts.** Simplest. Ignore the system lines'
  before/after values; the member lines are what you write.
- **Store them like any other account.** Then you can ask what the money supply
  is and check that the books close -- but you must load and pass them on every
  call, or you will write a wrong system balance.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .constants import MAX_BALANCE, MIN_BALANCE, SYSTEM_OWNER_PREFIX
from .errors import ValidationError

__all__ = [
    "AccountRef",
    "Account",
    "SystemAccount",
    "member_account",
    "system_account",
    "is_system_account",
    "account_key",
    "parse_account_key",
    "same_account",
    "make_account",
    "empty_account",
]


@dataclass(frozen=True)
class AccountRef:
    """Which account a balance belongs to.

    A reference, not the balance itself: the caller holds balances in its own
    database, and hands them in as :class:`Account` objects when it wants
    something booked.
    """

    #: The world the account lives in: one server, one forum, one game.
    scope: str
    #: Who owns it -- a member id, or a ``system:`` owner.
    owner: str
    #: Which currency it holds.
    currency: str


@dataclass(frozen=True)
class Account:
    """An account reference together with the balance the caller loaded."""

    ref: AccountRef
    balance: int


class SystemAccount(str, Enum):
    """The system accounts every scope implicitly has."""

    #: Where new currency is issued from. Goes negative by design.
    MINT = "system:mint"
    #: Where currency that is taken out of circulation goes.
    SINK = "system:sink"
    #: Where shop payments land.
    SHOP = "system:shop"
    #: Where funds sit while a trade is open.
    ESCROW = "system:escrow"
    #: Where deposits sit while they are on deposit. A member's savings balance
    #: leaves their current account and arrives here, which is what makes
    #: "how much is on deposit in this scope" a number you can read off the
    #: books rather than sum across members.
    BANK = "system:bank"
    #: Where lending is paid out from and repayments arrive. Its balance is the
    #: scope's outstanding credit, with a minus sign.
    CREDIT = "system:credit"
    #: Where fees and taxes collect. Kept apart from the sink because a fee is
    #: revenue the operator may want to spend again, and currency in the sink is
    #: gone.
    FEE = "system:fee"
    #: Where an order's funds and an auction's bids sit until the trade settles.
    #: Separate from escrow so a stuck market cannot be confused with a stuck
    #: trade when the books are being reconciled.
    MARKET = "system:market"


def member_account(scope: str, member_id: str, currency: str) -> AccountRef:
    """Build a reference to a member's account."""
    _assert_identifier(scope, "scope")
    _assert_identifier(member_id, "member_id")
    _assert_identifier(currency, "currency")
    if member_id.startswith(SYSTEM_OWNER_PREFIX):
        raise ValidationError(
            f'A member id must not start with "{SYSTEM_OWNER_PREFIX}"',
            member_id=member_id,
        )
    return AccountRef(scope=scope, owner=member_id, currency=currency)


def system_account(
    scope: str, currency: str, kind: SystemAccount = SystemAccount.MINT
) -> AccountRef:
    """Build a reference to one of the scope's system accounts."""
    _assert_identifier(scope, "scope")
    _assert_identifier(currency, "currency")
    return AccountRef(scope=scope, owner=kind.value, currency=currency)


def is_system_account(ref: AccountRef) -> bool:
    """True when the reference points at a system account."""
    return ref.owner.startswith(SYSTEM_OWNER_PREFIX)


def account_key(ref: AccountRef) -> str:
    """A stable string form of a reference.

    Useful as a dict key and as a primary key in the caller's database. The
    separator is ``/``, and the parts are validated against it, so the key can
    be parsed back unambiguously.
    """
    return f"{ref.scope}/{ref.owner}/{ref.currency}"


def parse_account_key(key: str) -> AccountRef:
    """Parse a key produced by :func:`account_key`."""
    parts = key.split("/")
    if len(parts) != 3:
        raise ValidationError("An account key has exactly three parts", key=key)
    scope, owner, currency = parts
    _assert_identifier(scope, "scope")
    _assert_identifier(owner, "owner")
    _assert_identifier(currency, "currency")
    return AccountRef(scope=scope, owner=owner, currency=currency)


def same_account(a: AccountRef, b: AccountRef) -> bool:
    """True when two references point at the same account."""
    return a == b


def make_account(ref: AccountRef, balance: int) -> Account:
    """Pair a reference with a balance the caller has loaded."""
    if not isinstance(balance, int) or isinstance(balance, bool):
        raise ValidationError("A balance must be an integer", balance=balance)
    if balance > MAX_BALANCE or balance < MIN_BALANCE:
        raise ValidationError(
            "A balance must stay inside the range both editions can hold exactly",
            balance=balance,
        )
    return Account(ref=ref, balance=balance)


def empty_account(ref: AccountRef) -> Account:
    """An account the caller has not stored yet.

    A member who has never held any currency has no row, and that is not an
    error: their balance is zero. This is the shorthand for that case.
    """
    return Account(ref=ref, balance=0)


def _assert_identifier(value: str, name: str) -> None:
    if not isinstance(value, str) or not value:
        raise ValidationError(f"{name} must be a non-empty string", **{name: value})
    if "/" in value:
        raise ValidationError(f'{name} must not contain "/"', **{name: value})
