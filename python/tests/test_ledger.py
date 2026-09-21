"""Currencies, account references and postings."""

from __future__ import annotations

import json

import pytest

from economyworld import (
    MAX_BALANCE,
    ConfigurationError,
    EconomyEngine,
    InMemoryOperationLog,
    InvalidAmountError,
    PostingKind,
    PostingLine,
    SystemAccount,
    UnbalancedPostingError,
    ValidationError,
    account_key,
    apply_permille,
    assert_balanced,
    assert_positive_amount,
    assert_whole_amount,
    create_currency,
    create_posting,
    deserialize_posting,
    empty_account,
    is_balanced,
    is_system_account,
    make_account,
    member_account,
    net_change,
    parse_account_key,
    resulting_balances,
    same_account,
    serialize_posting,
    split_minor_units,
    system_account,
)

SCOPE = "guild-1"
COIN = "COIN"
NOW = 1_700_000_000_000

ANA = member_account(SCOPE, "ana", COIN)
BEN = member_account(SCOPE, "ben", COIN)


class TestCurrencies:
    def test_defaults_to_whole_units(self) -> None:
        currency = create_currency(COIN)
        assert currency.minor_units == 0
        assert currency.name == COIN
        assert currency.symbol == COIN
        assert currency.max_balance == MAX_BALANCE

    def test_carries_display_metadata(self) -> None:
        currency = create_currency(
            "GLD", name="Gold", symbol="G", minor_units=2, max_balance=1_000_000
        )
        assert currency.name == "Gold"
        assert currency.minor_units == 2

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"code": ""},
            {"code": "X", "minor_units": -1},
            {"code": "X", "minor_units": 9},
            {"code": "X", "max_balance": 0},
            {"code": "X", "max_balance": MAX_BALANCE + 10},
        ],
    )
    def test_rejects_impossible_currencies(self, kwargs: dict) -> None:
        with pytest.raises(ConfigurationError):
            create_currency(**kwargs)

    def test_splits_minor_units_without_losing_the_sign(self) -> None:
        currency = create_currency("GLD", minor_units=2)
        assert split_minor_units(1234, currency).whole == 12
        assert split_minor_units(1234, currency).fraction == 34
        assert split_minor_units(-1234, currency).negative is True
        assert split_minor_units(-1234, currency).whole == 12
        assert split_minor_units(5, currency).whole == 0

    def test_applies_permille_with_floor_division_in_order(self) -> None:
        assert apply_permille(100, []) == 100
        assert apply_permille(100, [1500]) == 150
        assert apply_permille(7, [1500, 1100]) == 11
        assert apply_permille(7, [1100, 1500]) == 10
        with pytest.raises(InvalidAmountError):
            apply_permille(10, [-1])

    def test_refuses_amounts_that_are_not_whole_minor_units(self) -> None:
        with pytest.raises(InvalidAmountError):
            assert_whole_amount(1.5)  # type: ignore[arg-type]
        with pytest.raises(InvalidAmountError):
            assert_positive_amount(0)
        with pytest.raises(InvalidAmountError):
            assert_positive_amount(-1)
        with pytest.raises(InvalidAmountError):
            assert_whole_amount(MAX_BALANCE + 1)
        assert_whole_amount(0)


class TestAccountReferences:
    def test_builds_member_and_system_references(self) -> None:
        assert ANA.owner == "ana"
        assert is_system_account(ANA) is False
        mint = system_account(SCOPE, COIN, SystemAccount.MINT)
        assert mint.owner == "system:mint"
        assert is_system_account(mint) is True

    def test_round_trips_through_a_key(self) -> None:
        assert account_key(ANA) == "guild-1/ana/COIN"
        assert parse_account_key(account_key(ANA)) == ANA

    def test_compares_references(self) -> None:
        assert same_account(ANA, member_account(SCOPE, "ana", COIN)) is True
        assert same_account(ANA, BEN) is False

    @pytest.mark.parametrize(
        "args",
        [("a/b", "ana", COIN), (SCOPE, "a/b", COIN), (SCOPE, "ana", "a/b"), ("", "ana", COIN)],
    )
    def test_keeps_the_key_parseable(self, args: tuple) -> None:
        with pytest.raises(ValidationError):
            member_account(*args)

    def test_refuses_a_member_id_that_impersonates_the_system(self) -> None:
        with pytest.raises(ValidationError):
            member_account(SCOPE, "system:mint", COIN)

    def test_refuses_a_malformed_key(self) -> None:
        with pytest.raises(ValidationError):
            parse_account_key("too/few")

    def test_treats_a_member_with_no_row_as_zero(self) -> None:
        assert empty_account(ANA).balance == 0
        assert make_account(ANA, 500).balance == 500
        with pytest.raises(ValidationError):
            make_account(ANA, 1.5)  # type: ignore[arg-type]
        with pytest.raises(ValidationError):
            make_account(ANA, MAX_BALANCE + 1)


def valid_posting():
    return create_posting(
        operation_id="op-1",
        kind=PostingKind.TRANSFER,
        scope=SCOPE,
        currency=COIN,
        amount=100,
        reason="gift",
        occurred_at=NOW,
        lines=[
            PostingLine(account=ANA, delta=-100, balance_before=500, balance_after=400),
            PostingLine(account=BEN, delta=100, balance_before=0, balance_after=100),
        ],
    )


class TestPostings:
    def test_accepts_a_balanced_posting(self) -> None:
        posting = valid_posting()
        assert is_balanced(posting) is True
        assert_balanced(posting)
        assert posting.reverses is None

    def test_refuses_lines_that_do_not_sum_to_zero(self) -> None:
        with pytest.raises(UnbalancedPostingError):
            create_posting(
                operation_id="op-2",
                kind=PostingKind.TRANSFER,
                scope=SCOPE,
                currency=COIN,
                amount=100,
                reason="broken",
                occurred_at=NOW,
                lines=[
                    PostingLine(
                        account=ANA, delta=-100, balance_before=500, balance_after=400
                    ),
                    PostingLine(account=BEN, delta=50, balance_before=0, balance_after=50),
                ],
            )

    def test_refuses_a_line_whose_arithmetic_is_wrong(self) -> None:
        with pytest.raises(ValidationError):
            create_posting(
                operation_id="op-3",
                kind=PostingKind.TRANSFER,
                scope=SCOPE,
                currency=COIN,
                amount=100,
                reason="broken",
                occurred_at=NOW,
                lines=[
                    PostingLine(
                        account=ANA, delta=-100, balance_before=500, balance_after=999
                    ),
                    PostingLine(account=BEN, delta=100, balance_before=0, balance_after=100),
                ],
            )

    def test_refuses_a_single_line_posting(self) -> None:
        with pytest.raises(ValidationError):
            create_posting(
                operation_id="op-4",
                kind=PostingKind.CREDIT,
                scope=SCOPE,
                currency=COIN,
                amount=0,
                reason="nothing",
                occurred_at=NOW,
                lines=[PostingLine(account=ANA, delta=0, balance_before=0, balance_after=0)],
            )

    def test_refuses_lines_from_another_scope_or_currency(self) -> None:
        other_scope = member_account("guild-2", "ben", COIN)
        with pytest.raises(ValidationError):
            create_posting(
                operation_id="op-5",
                kind=PostingKind.TRANSFER,
                scope=SCOPE,
                currency=COIN,
                amount=100,
                reason="cross-scope",
                occurred_at=NOW,
                lines=[
                    PostingLine(
                        account=ANA, delta=-100, balance_before=500, balance_after=400
                    ),
                    PostingLine(
                        account=other_scope, delta=100, balance_before=0, balance_after=100
                    ),
                ],
            )

        gold = member_account(SCOPE, "ben", "GLD")
        with pytest.raises(ValidationError):
            create_posting(
                operation_id="op-6",
                kind=PostingKind.TRANSFER,
                scope=SCOPE,
                currency=COIN,
                amount=100,
                reason="cross-currency",
                occurred_at=NOW,
                lines=[
                    PostingLine(
                        account=ANA, delta=-100, balance_before=500, balance_after=400
                    ),
                    PostingLine(account=gold, delta=100, balance_before=0, balance_after=100),
                ],
            )

    @pytest.mark.parametrize(
        ("operation_id", "reason", "occurred_at"),
        [("", "x", NOW), ("op", "", NOW), ("op", "x", 1.5)],
    )
    def test_refuses_missing_audit_metadata(
        self, operation_id: str, reason: str, occurred_at: object
    ) -> None:
        with pytest.raises(ValidationError):
            create_posting(
                operation_id=operation_id,
                kind=PostingKind.TRANSFER,
                scope=SCOPE,
                currency=COIN,
                amount=100,
                reason=reason,
                occurred_at=occurred_at,  # type: ignore[arg-type]
                lines=[
                    PostingLine(
                        account=ANA, delta=-100, balance_before=500, balance_after=400
                    ),
                    PostingLine(account=BEN, delta=100, balance_before=0, balance_after=100),
                ],
            )

    def test_reports_what_it_did_to_one_account(self) -> None:
        posting = valid_posting()
        assert net_change(posting, ANA) == -100
        assert net_change(posting, BEN) == 100
        assert net_change(posting, member_account(SCOPE, "cai", COIN)) == 0

    def test_reports_the_resulting_balances(self) -> None:
        assert resulting_balances(valid_posting()) == {
            "guild-1/ana/COIN": 400,
            "guild-1/ben/COIN": 100,
        }

    def test_round_trips_through_json(self) -> None:
        posting = valid_posting()
        restored = deserialize_posting(json.loads(json.dumps(serialize_posting(posting))))
        assert restored.operation_id == posting.operation_id
        assert restored.amount == posting.amount
        assert restored.lines == posting.lines

    def test_refuses_stored_data_it_cannot_trust(self) -> None:
        with pytest.raises(ValidationError):
            deserialize_posting("nope")  # type: ignore[arg-type]
        with pytest.raises(ValidationError):
            deserialize_posting({"operationId": "x"})

    def test_metadata_is_read_only(self) -> None:
        with pytest.raises(TypeError):
            valid_posting().metadata["x"] = "y"  # type: ignore[index]


class TestOperationLog:
    def test_recognises_a_repeat(self) -> None:
        log = InMemoryOperationLog()
        assert log.is_new("op-1") is True
        assert log.record("op-1") is True
        assert log.is_new("op-1") is False
        assert log.record("op-1") is False
        assert log.size == 1

    def test_can_be_emptied(self) -> None:
        log = InMemoryOperationLog()
        log.record("op-1")
        log.clear()
        assert log.is_new("op-1") is True


class TestEngineConfiguration:
    def test_needs_at_least_one_currency(self) -> None:
        with pytest.raises(ConfigurationError):
            EconomyEngine(currencies=[])

    def test_accepts_a_bare_currency_code(self) -> None:
        assert EconomyEngine(currencies=["COIN"]).currency("COIN").minor_units == 0

    def test_rejects_duplicate_currencies(self) -> None:
        with pytest.raises(ConfigurationError):
            EconomyEngine(currencies=["COIN", "COIN"])

    def test_rejects_something_that_is_not_a_currency(self) -> None:
        with pytest.raises(ConfigurationError):
            EconomyEngine(currencies=[42])  # type: ignore[list-item]

    def test_reports_an_unknown_currency_clearly(self) -> None:
        engine = EconomyEngine(currencies=["COIN"])
        with pytest.raises(Exception, match="Unknown currency: NOPE"):
            engine.currency("NOPE")
