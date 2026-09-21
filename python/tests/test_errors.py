"""The error hierarchy."""

from __future__ import annotations

import pytest

from economyworld import (
    BalanceOverflowError,
    ConfigurationError,
    CurrencyMismatchError,
    DuplicateOperationError,
    EconomyError,
    InsufficientFundsError,
    InsufficientQuantityError,
    InvalidAmountError,
    ItemError,
    OfferError,
    ReversalError,
    TradeStateError,
    UnbalancedPostingError,
    UnknownReferenceError,
    ValidationError,
)

SIMPLE = [
    (ConfigurationError, "CONFIGURATION_ERROR"),
    (ValidationError, "VALIDATION_ERROR"),
    (InvalidAmountError, "INVALID_AMOUNT"),
    (ItemError, "ITEM_ERROR"),
    (OfferError, "OFFER_ERROR"),
    (TradeStateError, "TRADE_STATE_ERROR"),
    (ReversalError, "REVERSAL_ERROR"),
]


@pytest.mark.parametrize(("cls", "code"), SIMPLE)
def test_one_base_class_catches_everything(cls: type, code: str) -> None:
    with pytest.raises(EconomyError):
        raise cls("boom")


@pytest.mark.parametrize(("cls", "code"), SIMPLE)
def test_carries_a_stable_code(cls: type, code: str) -> None:
    assert cls("boom").code == code


def test_the_base_class_has_its_own_code() -> None:
    assert EconomyError("boom").code == "ECONOMY_ERROR"


def test_carries_structured_details() -> None:
    error = ValidationError("bad amount", amount=-1)
    assert error.details["amount"] == -1
    assert error.message == "bad amount"


def test_details_are_read_only() -> None:
    error = ValidationError("bad amount", amount=-1)
    with pytest.raises(TypeError):
        error.details["amount"] = 0  # type: ignore[index]


def test_details_default_to_empty() -> None:
    assert dict(EconomyError("x").details) == {}


def test_is_a_plain_exception() -> None:
    assert isinstance(ValidationError("x"), Exception)
    assert str(ValidationError("x")) == "x"


class TestMoneyErrorsCarryTheNumbers:
    def test_insufficient_funds_reports_the_shortfall(self) -> None:
        error = InsufficientFundsError(
            account="guild-1/ana/COIN", balance=40, required=100, currency="COIN"
        )
        assert error.code == "INSUFFICIENT_FUNDS"
        assert error.balance == 40
        assert error.required == 100
        assert error.shortfall == 60
        assert "guild-1/ana/COIN" in error.message

    def test_balance_overflow_names_the_ceiling(self) -> None:
        error = BalanceOverflowError(
            account="guild-1/ana/COIN", balance=999, amount=5, max_balance=1000
        )
        assert error.code == "BALANCE_OVERFLOW"
        assert error.details["max_balance"] == 1000

    def test_currency_mismatch_names_both(self) -> None:
        error = CurrencyMismatchError(expected="COIN", received="GLD")
        assert error.code == "CURRENCY_MISMATCH"
        assert "COIN" in error.message
        assert "GLD" in error.message

    def test_unknown_reference_names_the_kind_and_id(self) -> None:
        error = UnknownReferenceError("currency", "NOPE")
        assert error.code == "UNKNOWN_REFERENCE"
        assert error.message == "Unknown currency: NOPE"

    def test_duplicate_operation_names_the_operation(self) -> None:
        error = DuplicateOperationError("op-1")
        assert error.code == "DUPLICATE_OPERATION"
        assert error.details["operation_id"] == "op-1"

    def test_unbalanced_posting_reports_how_far_off(self) -> None:
        error = UnbalancedPostingError("op-1", -50)
        assert error.code == "UNBALANCED_POSTING"
        assert error.details["sum"] == -50
        assert "-50" in error.message

    def test_insufficient_quantity_reports_held_and_required(self) -> None:
        error = InsufficientQuantityError(item_id="potion", held=1, required=3)
        assert error.code == "INSUFFICIENT_QUANTITY"
        assert error.details["held"] == 1
