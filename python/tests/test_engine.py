"""Credits, debits, transfers, earning, reversals and decay."""

from __future__ import annotations

import json
from typing import Any

import pytest

from economyworld import (
    MAX_BALANCE,
    BalanceOverflowError,
    ConfigurationError,
    CurrencyMismatchError,
    DecayRule,
    EarnOutcome,
    EconomyEngine,
    InsufficientFundsError,
    InvalidAmountError,
    PostingKind,
    ReversalError,
    SystemAccount,
    ValidationError,
    account_key,
    clone_earn_state,
    create_currency,
    create_earn_rule,
    create_earn_state,
    deserialize_earn_state,
    empty_account,
    make_account,
    member_account,
    serialize_earn_state,
    system_account,
)

SCOPE = "guild-1"
COIN = "COIN"
NOW = 1_700_000_000_000
MINUTE = 60_000
HOUR = 60 * MINUTE
DAY = 24 * HOUR

ANA = member_account(SCOPE, "ana", COIN)
BEN = member_account(SCOPE, "ben", COIN)


def engine(**overrides: Any) -> EconomyEngine:
    defaults: dict[str, Any] = {
        "currencies": [create_currency(COIN, max_balance=1_000_000)],
        "earn_rules": [
            create_earn_rule("message", 10, COIN, cooldown_seconds=60, period_cap_amount=100)
        ],
    }
    defaults.update(overrides)
    return EconomyEngine(**defaults)


def opts(operation_id: str, now: int = NOW) -> dict[str, Any]:
    return {"now": now, "operation_id": operation_id, "reason": "test"}


class TestCredit:
    def test_issues_currency_against_the_mint(self) -> None:
        result = engine().credit(empty_account(ANA), 500, **opts("op-1"))
        assert result.posting.kind is PostingKind.CREDIT
        assert len(result.posting.lines) == 2
        assert result.balances["guild-1/ana/COIN"] == 500
        # The mint goes negative by exactly what it issued -- the record of how
        # much currency exists.
        assert result.balances["guild-1/system:mint/COIN"] == -500

    def test_always_produces_a_balanced_posting(self) -> None:
        result = engine().credit(empty_account(ANA), 500, **opts("op-1"))
        assert sum(line.delta for line in result.posting.lines) == 0

    def test_refuses_to_exceed_the_currency_ceiling(self) -> None:
        with pytest.raises(BalanceOverflowError):
            engine().credit(make_account(ANA, 999_999), 2, **opts("op-1"))

    @pytest.mark.parametrize("amount", [0, -5, 1.5])
    def test_refuses_an_impossible_amount(self, amount: object) -> None:
        with pytest.raises(InvalidAmountError):
            engine().credit(empty_account(ANA), amount, **opts("op-1"))  # type: ignore[arg-type]

    def test_refuses_a_non_integer_timestamp(self) -> None:
        with pytest.raises(ValidationError):
            engine().credit(empty_account(ANA), 5, now=1.5, operation_id="op", reason="x")  # type: ignore[arg-type]

    def test_can_credit_from_an_explicit_source(self) -> None:
        source = make_account(system_account(SCOPE, COIN, SystemAccount.SHOP), 1000)
        result = engine().credit(empty_account(ANA), 200, source=source, **opts("op-1"))
        assert result.balances["guild-1/system:shop/COIN"] == 800


class TestDebit:
    def test_takes_currency_out_of_circulation(self) -> None:
        result = engine().debit(make_account(ANA, 500), 200, **opts("op-1"))
        assert result.posting.kind is PostingKind.DEBIT
        assert result.balances["guild-1/ana/COIN"] == 300
        assert result.balances["guild-1/system:sink/COIN"] == 200

    def test_refuses_to_overdraw_by_default(self) -> None:
        with pytest.raises(InsufficientFundsError):
            engine().debit(make_account(ANA, 100), 200, **opts("op-1"))

    def test_reports_the_shortfall(self) -> None:
        with pytest.raises(InsufficientFundsError) as excinfo:
            engine().debit(make_account(ANA, 100), 250, **opts("op-1"))
        assert excinfo.value.balance == 100
        assert excinfo.value.required == 250
        assert excinfo.value.shortfall == 150

    def test_allows_an_overdraft_when_the_caller_opts_in(self) -> None:
        result = engine().debit(
            make_account(ANA, 100), 200, allow_negative=True, **opts("op-1")
        )
        assert result.balances["guild-1/ana/COIN"] == -100

    def test_allows_an_overdraft_when_configured(self) -> None:
        result = engine(allow_negative=True).debit(make_account(ANA, 100), 200, **opts("op-1"))
        assert result.balances["guild-1/ana/COIN"] == -100


class TestTransfer:
    def test_moves_currency_between_members(self) -> None:
        result = engine().transfer(
            make_account(ANA, 500), make_account(BEN, 20), 300, **opts("op-1")
        )
        assert result.posting.kind is PostingKind.TRANSFER
        assert result.balances["guild-1/ana/COIN"] == 200
        assert result.balances["guild-1/ben/COIN"] == 320

    def test_creates_and_destroys_nothing(self) -> None:
        result = engine().transfer(
            make_account(ANA, 500), make_account(BEN, 20), 300, **opts("op-1")
        )
        after = result.balances["guild-1/ana/COIN"] + result.balances["guild-1/ben/COIN"]
        assert after == 520

    def test_refuses_an_overdraft(self) -> None:
        with pytest.raises(InsufficientFundsError):
            engine().transfer(
                make_account(ANA, 100), make_account(BEN, 0), 300, **opts("op-1")
            )

    def test_refuses_to_overfill_the_recipient(self) -> None:
        with pytest.raises(BalanceOverflowError):
            engine().transfer(
                make_account(ANA, 500), make_account(BEN, 999_999), 300, **opts("op-1")
            )

    def test_refuses_a_self_transfer(self) -> None:
        with pytest.raises(ValidationError):
            engine().transfer(
                make_account(ANA, 500), make_account(ANA, 500), 100, **opts("op-1")
            )

    def test_refuses_to_cross_scopes(self) -> None:
        other = member_account("guild-2", "ben", COIN)
        with pytest.raises(ValidationError):
            engine().transfer(
                make_account(ANA, 500), make_account(other, 0), 100, **opts("op-1")
            )

    def test_refuses_to_cross_currencies(self) -> None:
        other = member_account(SCOPE, "ben", "GLD")
        with pytest.raises(CurrencyMismatchError):
            engine().transfer(
                make_account(ANA, 500), make_account(other, 0), 100, **opts("op-1")
            )


class TestEarn:
    def test_pays_out_and_records_the_cooldown(self) -> None:
        result = engine().earn(
            empty_account(ANA), "message", create_earn_state(), **opts("op-1")
        )
        assert result.outcome is EarnOutcome.EARNED
        assert result.amount == 10
        assert result.new_balance == 10
        assert result.posting is not None
        assert result.posting.kind is PostingKind.EARN
        assert result.posting.metadata["earnRule"] == "message"
        assert result.state.last_earned_at["message"] == NOW
        assert result.booked is True

    def test_never_mutates_the_state_it_was_given(self) -> None:
        state = create_earn_state()
        engine().earn(empty_account(ANA), "message", state, **opts("op-1"))
        assert state.last_earned_at == {}

    def test_blocks_inside_the_cooldown_without_booking(self) -> None:
        economy = engine()
        first = economy.earn(
            empty_account(ANA), "message", create_earn_state(), **opts("op-1")
        )
        blocked = economy.earn(
            make_account(ANA, 10), "message", first.state, **opts("op-2", NOW + 30_000)
        )
        assert blocked.outcome is EarnOutcome.COOLDOWN
        assert blocked.posting is None
        assert blocked.cooldown_remaining_ms == 30_000
        assert blocked.booked is False

    def test_does_not_restart_the_cooldown_when_it_blocks(self) -> None:
        economy = engine()
        first = economy.earn(
            empty_account(ANA), "message", create_earn_state(), **opts("op-1")
        )
        blocked = economy.earn(
            make_account(ANA, 10), "message", first.state, **opts("op-2", NOW + 30_000)
        )
        later = economy.earn(
            make_account(ANA, 10), "message", blocked.state, **opts("op-3", NOW + 61_000)
        )
        assert later.outcome is EarnOutcome.EARNED

    def test_trims_the_last_payout_then_blocks(self) -> None:
        economy = engine(
            earn_rules=[
                create_earn_rule(
                    "message", 30, COIN, cooldown_seconds=0, period_cap_amount=100
                )
            ]
        )
        state = create_earn_state()
        balance = 0
        for index in range(3):
            step = economy.earn(
                make_account(ANA, balance),
                "message",
                state,
                **opts(f"op-{index}", NOW + index),
            )
            state = step.state
            balance = step.new_balance
        assert balance == 90

        trimmed = economy.earn(
            make_account(ANA, balance), "message", state, **opts("op-trim", NOW + 10)
        )
        assert trimmed.outcome is EarnOutcome.EARNED
        assert trimmed.amount == 10
        assert trimmed.gross_amount == 30

        blocked = economy.earn(
            make_account(ANA, trimmed.new_balance),
            "message",
            trimmed.state,
            **opts("op-block", NOW + 20),
        )
        assert blocked.outcome is EarnOutcome.PERIOD_CAP
        assert blocked.period_remaining == 0

    def test_starts_a_fresh_period(self) -> None:
        economy = engine(
            earn_rules=[
                create_earn_rule(
                    "message",
                    100,
                    COIN,
                    cooldown_seconds=0,
                    period_cap_amount=100,
                    period_seconds=3600,
                )
            ]
        )
        first = economy.earn(
            empty_account(ANA), "message", create_earn_state(), **opts("op-1")
        )
        blocked = economy.earn(
            make_account(ANA, 100), "message", first.state, **opts("op-2", NOW + 30 * MINUTE)
        )
        assert blocked.outcome is EarnOutcome.PERIOD_CAP

        fresh = economy.earn(
            make_account(ANA, 100), "message", blocked.state, **opts("op-3", NOW + HOUR)
        )
        assert fresh.outcome is EarnOutcome.EARNED
        assert fresh.amount == 100

    def test_reports_unknown_and_disabled_rules(self) -> None:
        economy = engine(earn_rules=[create_earn_rule("message", 10, COIN, enabled=False)])
        assert (
            economy.earn(
                empty_account(ANA), "nope", create_earn_state(), **opts("op-1")
            ).outcome
            is EarnOutcome.UNKNOWN_RULE
        )
        assert (
            economy.earn(
                empty_account(ANA), "message", create_earn_state(), **opts("op-2")
            ).outcome
            is EarnOutcome.RULE_DISABLED
        )

    def test_reports_a_full_account(self) -> None:
        result = engine().earn(
            make_account(ANA, 1_000_000), "message", create_earn_state(), **opts("op-1")
        )
        assert result.outcome is EarnOutcome.MAX_BALANCE_REACHED
        assert result.posting is None

    def test_trims_to_the_remaining_headroom(self) -> None:
        result = engine().earn(
            make_account(ANA, 999_995), "message", create_earn_state(), **opts("op-1")
        )
        assert result.amount == 5
        assert result.new_balance == 1_000_000

    def test_reports_no_amount_for_a_rule_that_pays_nothing(self) -> None:
        economy = engine(earn_rules=[create_earn_rule("message", 0, COIN)])
        result = economy.earn(
            empty_account(ANA), "message", create_earn_state(), **opts("op-1")
        )
        assert result.outcome is EarnOutcome.NO_AMOUNT

    def test_refuses_a_rule_whose_currency_the_account_does_not_hold(self) -> None:
        economy = EconomyEngine(
            currencies=["COIN", "GLD"],
            earn_rules=[create_earn_rule("message", 10, "GLD")],
        )
        with pytest.raises(CurrencyMismatchError):
            economy.earn(empty_account(ANA), "message", create_earn_state(), **opts("op-1"))

    def test_answers_whether_earning_is_possible(self) -> None:
        economy = engine()
        state = create_earn_state()
        assert economy.can_earn(state, "message", NOW) is True
        assert economy.can_earn(state, "nope", NOW) is False

        earned = economy.earn(empty_account(ANA), "message", state, **opts("op-1"))
        assert economy.can_earn(earned.state, "message", NOW + 1000) is False
        assert economy.can_earn(earned.state, "message", NOW + 61_000) is True

    def test_can_earn_is_false_for_a_disabled_rule(self) -> None:
        economy = engine(earn_rules=[create_earn_rule("message", 10, COIN, enabled=False)])
        assert economy.can_earn(create_earn_state(), "message", NOW) is False

    def test_reports_no_cap_for_an_uncapped_rule(self) -> None:
        economy = engine(earn_rules=[create_earn_rule("message", 10, COIN)])
        assert economy.earn_period_remaining(create_earn_state(), "message", NOW) is None
        assert economy.earn_cooldown_remaining_ms(create_earn_state(), "message", NOW) == 0

    def test_round_trips_its_state_through_json(self) -> None:
        earned = engine().earn(
            empty_account(ANA), "message", create_earn_state(), **opts("op-1")
        )
        restored = deserialize_earn_state(
            json.loads(json.dumps(serialize_earn_state(earned.state)))
        )
        assert restored == earned.state
        assert clone_earn_state(restored) == restored

    def test_reads_the_python_field_names_too(self) -> None:
        restored = deserialize_earn_state({"last_earned_at": {"message": NOW}})
        assert restored.last_earned_at == {"message": NOW}

    @pytest.mark.parametrize(
        "raw", ["nope", {"lastEarnedAt": 5}, {"lastEarnedAt": {"a": "x"}}]
    )
    def test_rejects_stored_state_it_cannot_trust(self, raw: object) -> None:
        with pytest.raises(ValidationError):
            deserialize_earn_state(raw)  # type: ignore[arg-type]

    def test_defaults_an_empty_row(self) -> None:
        assert deserialize_earn_state({}) == create_earn_state()

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"key": "", "amount": 1, "currency": COIN},
            {"key": "a", "amount": 1, "currency": ""},
            {"key": "a", "amount": -1, "currency": COIN},
            {"key": "a", "amount": 1, "currency": COIN, "cooldown_seconds": -1},
            {"key": "a", "amount": 1, "currency": COIN, "period_cap_amount": -1},
            {"key": "a", "amount": 1, "currency": COIN, "period_seconds": 0},
        ],
    )
    def test_rejects_impossible_rules(self, kwargs: dict) -> None:
        with pytest.raises(ConfigurationError):
            create_earn_rule(**kwargs)

    def test_rejects_duplicate_keys_and_unknown_currencies(self) -> None:
        with pytest.raises(ConfigurationError):
            EconomyEngine(
                currencies=["COIN"],
                earn_rules=[
                    create_earn_rule("a", 1, COIN),
                    create_earn_rule("a", 2, COIN),
                ],
            )
        with pytest.raises(ConfigurationError):
            EconomyEngine(currencies=["COIN"], earn_rules=[create_earn_rule("a", 1, "NOPE")])

    def test_rejects_something_that_is_not_a_rule(self) -> None:
        with pytest.raises(ConfigurationError):
            EconomyEngine(currencies=["COIN"], earn_rules=[{"key": "a"}])  # type: ignore[list-item]


class TestReverse:
    def test_books_the_exact_inverse(self) -> None:
        economy = engine()
        original = economy.transfer(
            make_account(ANA, 500), make_account(BEN, 0), 300, **opts("op-1")
        )
        reversal = economy.reverse(
            original.posting,
            {"guild-1/ana/COIN": 200, "guild-1/ben/COIN": 300},
            **opts("op-2", NOW + 1000),
        )
        assert reversal.posting.kind is PostingKind.REVERSAL
        assert reversal.posting.reverses == "op-1"
        assert reversal.balances["guild-1/ana/COIN"] == 500
        assert reversal.balances["guild-1/ben/COIN"] == 0

    def test_uses_the_current_balances(self) -> None:
        economy = engine()
        original = economy.transfer(
            make_account(ANA, 500), make_account(BEN, 0), 300, **opts("op-1")
        )
        reversal = economy.reverse(
            original.posting,
            {"guild-1/ana/COIN": 200, "guild-1/ben/COIN": 999},
            **opts("op-2", NOW + 1000),
        )
        assert reversal.balances["guild-1/ben/COIN"] == 699

    def test_refuses_when_the_recipient_already_spent_it(self) -> None:
        economy = engine()
        original = economy.transfer(
            make_account(ANA, 500), make_account(BEN, 0), 300, **opts("op-1")
        )
        with pytest.raises(InsufficientFundsError):
            economy.reverse(
                original.posting,
                {"guild-1/ana/COIN": 200, "guild-1/ben/COIN": 50},
                **opts("op-2", NOW + 1000),
            )

    def test_can_be_forced_negative(self) -> None:
        economy = engine()
        original = economy.transfer(
            make_account(ANA, 500), make_account(BEN, 0), 300, **opts("op-1")
        )
        reversal = economy.reverse(
            original.posting,
            {"guild-1/ana/COIN": 200, "guild-1/ben/COIN": 50},
            allow_negative=True,
            **opts("op-2", NOW + 1000),
        )
        assert reversal.balances["guild-1/ben/COIN"] == -250

    def test_refuses_to_reverse_a_reversal(self) -> None:
        economy = engine()
        original = economy.transfer(
            make_account(ANA, 500), make_account(BEN, 0), 300, **opts("op-1")
        )
        reversal = economy.reverse(
            original.posting,
            {"guild-1/ana/COIN": 200, "guild-1/ben/COIN": 300},
            **opts("op-2", NOW + 1000),
        )
        with pytest.raises(ReversalError):
            economy.reverse(
                reversal.posting,
                {"guild-1/ana/COIN": 500, "guild-1/ben/COIN": 0},
                **opts("op-3"),
            )

    def test_needs_its_own_operation_id(self) -> None:
        economy = engine()
        original = economy.transfer(
            make_account(ANA, 500), make_account(BEN, 0), 300, **opts("op-1")
        )
        with pytest.raises(ReversalError):
            economy.reverse(
                original.posting,
                {"guild-1/ana/COIN": 200, "guild-1/ben/COIN": 300},
                **opts("op-1"),
            )

    def test_needs_every_balance(self) -> None:
        economy = engine()
        original = economy.transfer(
            make_account(ANA, 500), make_account(BEN, 0), 300, **opts("op-1")
        )
        with pytest.raises(ReversalError):
            economy.reverse(original.posting, {"guild-1/ana/COIN": 200}, **opts("op-2"))

    def test_can_undo_a_credit(self) -> None:
        economy = engine()
        original = economy.credit(empty_account(ANA), 500, **opts("op-1"))
        reversal = economy.reverse(
            original.posting,
            {"guild-1/ana/COIN": 500, "guild-1/system:mint/COIN": -500},
            **opts("op-2", NOW + 1000),
        )
        assert reversal.balances["guild-1/ana/COIN"] == 0
        assert reversal.balances["guild-1/system:mint/COIN"] == 0


FLAT = DecayRule(
    amount_per_period=10,
    permille_per_period=0,
    period_seconds=86400,
    floor=0,
    grace_seconds=7 * 86400,
)


class TestDecay:
    def test_does_nothing_inside_the_grace_window(self) -> None:
        result = engine().apply_decay(
            make_account(ANA, 1000),
            FLAT,
            last_activity_at=NOW,
            **opts("op-1", NOW + 3 * DAY),
        )
        assert result.posting is None
        assert result.new_balance == 1000

    def test_charges_whole_periods_after_the_grace_window(self) -> None:
        result = engine().apply_decay(
            make_account(ANA, 1000),
            FLAT,
            last_activity_at=NOW,
            **opts("op-1", NOW + 10 * DAY),
        )
        assert result.periods == 3
        assert result.amount == 30
        assert result.new_balance == 970
        assert result.posting is not None
        assert result.posting.kind is PostingKind.DECAY

    def test_nightly_and_one_off_runs_agree(self) -> None:
        economy = engine()
        at_once = economy.apply_decay(
            make_account(ANA, 1000),
            FLAT,
            last_activity_at=NOW,
            **opts("op-1", NOW + 12 * DAY),
        )

        balance = 1000
        last_applied_at = None
        for day in range(8, 13):
            step = economy.apply_decay(
                make_account(ANA, balance),
                FLAT,
                last_activity_at=NOW,
                last_applied_at=last_applied_at,
                **opts(f"op-{day}", NOW + day * DAY),
            )
            balance = step.new_balance
            last_applied_at = step.applied_up_to
        assert balance == at_once.new_balance

    def test_applies_a_percentage_share(self) -> None:
        percentage = DecayRule(
            amount_per_period=0,
            permille_per_period=100,
            period_seconds=86400,
            floor=0,
            grace_seconds=0,
        )
        result = engine().apply_decay(
            make_account(ANA, 1000),
            percentage,
            last_activity_at=NOW,
            **opts("op-1", NOW + 2 * DAY),
        )
        assert result.new_balance == 810  # 1000 -> 900 -> 810

    def test_never_decays_below_the_floor(self) -> None:
        with_floor = DecayRule(
            amount_per_period=10,
            permille_per_period=0,
            period_seconds=86400,
            floor=500,
            grace_seconds=0,
        )
        result = engine().apply_decay(
            make_account(ANA, 550),
            with_floor,
            last_activity_at=NOW,
            **opts("op-1", NOW + 30 * DAY),
        )
        assert result.new_balance == 500

    def test_does_nothing_at_the_floor(self) -> None:
        with_floor = DecayRule(
            amount_per_period=10,
            permille_per_period=0,
            period_seconds=86400,
            floor=500,
            grace_seconds=0,
        )
        result = engine().apply_decay(
            make_account(ANA, 500),
            with_floor,
            last_activity_at=NOW,
            **opts("op-1", NOW + 30 * DAY),
        )
        assert result.posting is None
        assert result.amount == 0

    @pytest.mark.parametrize(
        "patch",
        [
            {"amount_per_period": -1},
            {"permille_per_period": 1001},
            {"period_seconds": 0},
            {"floor": 1.5},
            {"grace_seconds": -1},
            {"amount_per_period": 0, "permille_per_period": 0},
        ],
    )
    def test_rejects_impossible_rules(self, patch: dict) -> None:
        from dataclasses import replace

        with pytest.raises(ConfigurationError):
            engine().apply_decay(
                make_account(ANA, 100),
                replace(FLAT, **patch),
                last_activity_at=NOW,
                **opts("op-1", NOW + 100 * DAY),
            )


class TestSystemAccounts:
    def test_may_go_negative(self) -> None:
        mint = make_account(system_account(SCOPE, COIN, SystemAccount.MINT), 0)
        result = engine().transfer(mint, empty_account(ANA), 5_000, **opts("op-1"))
        assert result.balances[account_key(mint.ref)] == -5_000

    def test_are_not_subject_to_the_ceiling(self) -> None:
        shop = make_account(system_account(SCOPE, COIN, SystemAccount.SHOP), 999_999)
        result = engine().transfer(make_account(ANA, 5_000), shop, 5_000, **opts("op-1"))
        assert result.balances["guild-1/system:shop/COIN"] == 1_004_999


def test_max_balance_constant_matches_both_editions() -> None:
    assert MAX_BALANCE == 2**53 - 1
