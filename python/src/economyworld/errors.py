"""Error hierarchy for EconomyWorld.

Every error derives from :class:`EconomyError` so callers can catch a single
base class and still tell the causes apart via ``code``.

The split between an error and an outcome follows the same rule as RankMode:
things that happen in normal operation come back as results -- an earning
cooldown that has not expired, a daily ceiling that is used up. Errors are for
situations where continuing would produce a wrong balance: insufficient funds,
a currency mismatch, a duplicate booking.

:class:`InsufficientFundsError` is an error rather than an outcome on purpose.
A caller who forgets to check it must not accidentally end up with a member in
debt; the exception forces the decision to be made.
"""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType
from typing import Any

__all__ = [
    "EconomyError",
    "ConfigurationError",
    "ValidationError",
    "InvalidAmountError",
    "InsufficientFundsError",
    "BalanceOverflowError",
    "CurrencyMismatchError",
    "UnknownReferenceError",
    "DuplicateOperationError",
    "UnbalancedPostingError",
    "ItemError",
    "InsufficientQuantityError",
    "OfferError",
    "TradeStateError",
    "ReversalError",
    "RateError",
    "HoldError",
    "DepositError",
    "LoanStateError",
    "CreditLimitError",
    "InstrumentError",
    "OrderError",
    "AuctionStateError",
    "ScheduleError",
]


class EconomyError(Exception):
    """Base class for every error raised by this package."""

    #: Stable, machine-readable identifier. Never compare message texts.
    code: str = "ECONOMY_ERROR"

    def __init__(self, message: str, **details: Any) -> None:
        super().__init__(message)
        self.message = message
        self._details: Mapping[str, Any] = MappingProxyType(dict(details))

    @property
    def details(self) -> Mapping[str, Any]:
        """Structured context for the error. Read-only."""
        return self._details

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"{type(self).__name__}({self.message!r}, code={self.code!r})"


class ConfigurationError(EconomyError):
    """A currency, rule, item, offer or engine option was configured impossibly."""

    code = "CONFIGURATION_ERROR"


class ValidationError(EconomyError):
    """A call-site argument was invalid (fractional amount, empty id, bad time)."""

    code = "VALIDATION_ERROR"


class InvalidAmountError(EconomyError):
    """An amount was zero, negative or not a whole number of minor units."""

    code = "INVALID_AMOUNT"


class InsufficientFundsError(EconomyError):
    """The account does not hold enough to cover the debit."""

    code = "INSUFFICIENT_FUNDS"

    def __init__(self, account: str, balance: int, required: int, currency: str) -> None:
        super().__init__(
            f"Account {account} holds {balance} but {required} is required",
            account=account,
            balance=balance,
            required=required,
            currency=currency,
            shortfall=required - balance,
        )
        self.balance = balance
        self.required = required
        self.shortfall = required - balance


class BalanceOverflowError(EconomyError):
    """The credit would push the balance past the currency's ceiling."""

    code = "BALANCE_OVERFLOW"

    def __init__(self, account: str, balance: int, amount: int, max_balance: int) -> None:
        super().__init__(
            f"Crediting {amount} to {account} would exceed the maximum balance "
            f"of {max_balance}",
            account=account,
            balance=balance,
            amount=amount,
            max_balance=max_balance,
        )


class CurrencyMismatchError(EconomyError):
    """Two accounts in one booking hold different currencies."""

    code = "CURRENCY_MISMATCH"

    def __init__(self, expected: str, received: str, account: str | None = None) -> None:
        super().__init__(
            f"Expected currency {expected} but got {received}",
            expected=expected,
            received=received,
            account=account,
        )


class UnknownReferenceError(EconomyError):
    """The currency, item or offer is not known to this engine."""

    code = "UNKNOWN_REFERENCE"

    def __init__(self, kind: str, identifier: str) -> None:
        super().__init__(f"Unknown {kind}: {identifier}", kind=kind, id=identifier)


class DuplicateOperationError(EconomyError):
    """The operation id has already been booked.

    The engine cannot detect this on its own -- it stores nothing. It is raised
    by the operation-log helpers, and by your database's unique constraint,
    which is where the real guarantee lives.
    """

    code = "DUPLICATE_OPERATION"

    def __init__(self, operation_id: str) -> None:
        super().__init__(
            f"Operation {operation_id} has already been booked",
            operation_id=operation_id,
        )


class UnbalancedPostingError(EconomyError):
    """A posting's lines do not sum to zero, or are otherwise malformed."""

    code = "UNBALANCED_POSTING"

    def __init__(self, operation_id: str, total: int) -> None:
        super().__init__(
            f"Posting {operation_id} does not balance: its lines sum to {total}, not 0",
            operation_id=operation_id,
            sum=total,
        )


class ItemError(EconomyError):
    """The item cannot do what was asked of it (not stackable, not tradable)."""

    code = "ITEM_ERROR"


class InsufficientQuantityError(EconomyError):
    """The inventory does not hold enough of the item."""

    code = "INSUFFICIENT_QUANTITY"

    def __init__(self, item_id: str, held: int, required: int) -> None:
        super().__init__(
            f"Inventory holds {held} of {item_id} but {required} is required",
            item_id=item_id,
            held=held,
            required=required,
        )


class OfferError(EconomyError):
    """The offer cannot be bought right now (no stock, disabled, limit reached)."""

    code = "OFFER_ERROR"


class TradeStateError(EconomyError):
    """The trade is not in a state that allows this transition."""

    code = "TRADE_STATE_ERROR"


class ReversalError(EconomyError):
    """A reversal was asked for that cannot be carried out."""

    code = "REVERSAL_ERROR"


class RateError(EconomyError):
    """An interest rate, term or schedule cannot produce a sane result."""

    code = "RATE_ERROR"


class HoldError(EconomyError):
    """A hold cannot be placed, released or captured as asked."""

    code = "HOLD_ERROR"


class DepositError(EconomyError):
    """A deposit account will not take this deposit or withdrawal."""

    code = "DEPOSIT_ERROR"


class LoanStateError(EconomyError):
    """The loan is not in a state that allows this transition."""

    code = "LOAN_STATE_ERROR"


class CreditLimitError(EconomyError):
    """The borrowing asked for is past what the terms allow."""

    code = "CREDIT_LIMIT_ERROR"


class InstrumentError(EconomyError):
    """The instrument, position or valuation cannot be handled as asked."""

    code = "INSTRUMENT_ERROR"


class OrderError(EconomyError):
    """The order cannot be placed, matched or cancelled as asked."""

    code = "ORDER_ERROR"


class AuctionStateError(EconomyError):
    """The auction is not in a state that allows this transition."""

    code = "AUCTION_STATE_ERROR"


class ScheduleError(EconomyError):
    """A recurring schedule is impossible or has run out of room."""

    code = "SCHEDULE_ERROR"
