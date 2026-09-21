"""The trade state machine and settlement."""

from __future__ import annotations

from typing import Any

import pytest

from economyworld import (
    ConfigurationError,
    EconomyEngine,
    InsufficientFundsError,
    Inventory,
    InventorySlot,
    ItemError,
    Trade,
    TradeSide,
    TradeState,
    TradeStateError,
    ValidationError,
    accept_trade,
    cancel_trade,
    create_currency,
    create_item,
    empty_account,
    expire_trade,
    is_final,
    is_open,
    make_account,
    member_account,
    propose_trade,
    revoke_acceptance,
    settle_trade,
)

SCOPE = "guild-1"
COIN = "COIN"
NOW = 1_700_000_000_000
MINUTE = 60_000

ANA = member_account(SCOPE, "ana", COIN)
BEN = member_account(SCOPE, "ben", COIN)

SWORD = create_item("sword", stackable=False)
POTION = create_item("potion", max_stack=10)
TROPHY = create_item("trophy", tradable=False)
ITEMS = {"sword": SWORD, "potion": POTION, "trophy": TROPHY}


def engine() -> EconomyEngine:
    return EconomyEngine(currencies=[create_currency(COIN, max_balance=1_000_000)])


def trade(**overrides: Any) -> Trade:
    defaults: dict[str, Any] = {
        "trade_id": "trade-1",
        "scope": SCOPE,
        "currency": COIN,
        "left": TradeSide("ana", 100, (InventorySlot("sword", 1),)),
        "right": TradeSide("ben", 0, (InventorySlot("potion", 3),)),
        "now": NOW,
    }
    defaults.update(overrides)
    return propose_trade(**defaults)


def accepted() -> Trade:
    return accept_trade(accept_trade(trade(), "ana", NOW), "ben", NOW)


SETTLE: dict[str, Any] = {
    "now": NOW + MINUTE,
    "operation_id": "op-trade-1",
    "reason": "trade settlement",
}


def inventories() -> dict[str, Inventory]:
    return {
        "left_inventory": Inventory([InventorySlot("sword", 1)]),
        "right_inventory": Inventory([InventorySlot("potion", 5)]),
    }


class TestProposeTrade:
    def test_starts_proposed_with_nothing_moved(self) -> None:
        proposed = trade()
        assert proposed.state is TradeState.PROPOSED
        assert proposed.accepted_by == ()
        assert proposed.settled_at is None
        assert proposed.expires_at == NOW + 300_000

    def test_takes_a_custom_lifetime(self) -> None:
        assert trade(ttl_seconds=60).expires_at == NOW + 60_000

    def test_refuses_a_trade_with_itself(self) -> None:
        with pytest.raises(ValidationError):
            trade(left=TradeSide("ana", 100), right=TradeSide("ana", 50))

    def test_refuses_a_trade_where_nobody_offers_anything(self) -> None:
        with pytest.raises(ValidationError):
            trade(left=TradeSide("ana", 0), right=TradeSide("ben", 0))

    def test_refuses_a_missing_id_or_lifetime(self) -> None:
        with pytest.raises(ConfigurationError):
            trade(trade_id="")
        with pytest.raises(ConfigurationError):
            trade(ttl_seconds=0)

    def test_refuses_a_non_integer_timestamp(self) -> None:
        with pytest.raises(ValidationError):
            trade(now=1.5)

    @pytest.mark.parametrize(
        "side",
        [
            TradeSide("", 1),
            TradeSide("ana", -1),
            TradeSide("ana", 0, (InventorySlot("sword", 0),)),
            TradeSide("ana", 0, (InventorySlot("sword", 1), InventorySlot("sword", 1))),
        ],
    )
    def test_refuses_malformed_sides(self, side: TradeSide) -> None:
        with pytest.raises(ValidationError):
            trade(left=side)


class TestStateMachine:
    def test_needs_both_sides_before_it_is_accepted(self) -> None:
        half = accept_trade(trade(), "ana", NOW)
        assert half.state is TradeState.PROPOSED
        assert half.accepted_by == ("ana",)
        assert accept_trade(half, "ben", NOW).state is TradeState.ACCEPTED

    def test_ignores_a_repeated_acceptance(self) -> None:
        once = accept_trade(trade(), "ana", NOW)
        assert accept_trade(once, "ana", NOW) is once

    def test_lets_a_party_take_their_agreement_back(self) -> None:
        revoked = revoke_acceptance(accepted(), "ben", NOW)
        assert revoked.state is TradeState.PROPOSED
        assert revoked.accepted_by == ("ana",)

    def test_lets_either_party_walk_away(self) -> None:
        cancelled = cancel_trade(accepted(), "ben", NOW + 1000)
        assert cancelled.state is TradeState.CANCELLED
        assert cancelled.settled_at == NOW + 1000
        assert is_final(cancelled) is True

    def test_expires_once_its_time_is_up(self) -> None:
        expired = expire_trade(trade(), NOW + 301_000)
        assert expired.state is TradeState.EXPIRED
        assert is_final(expired) is True

    def test_refuses_to_expire_a_trade_that_still_has_time(self) -> None:
        with pytest.raises(TradeStateError):
            expire_trade(trade(), NOW + 1000)

    def test_leaves_a_final_trade_alone_when_expiring(self) -> None:
        cancelled = cancel_trade(trade(), "ana", NOW)
        assert expire_trade(cancelled, NOW + 999_999) is cancelled

    def test_refuses_transitions_out_of_a_final_state(self) -> None:
        cancelled = cancel_trade(trade(), "ana", NOW)
        for action in (accept_trade, cancel_trade, revoke_acceptance):
            with pytest.raises(TradeStateError):
                action(cancelled, "ben", NOW)

    def test_refuses_transitions_after_expiry(self) -> None:
        stale = trade()
        with pytest.raises(TradeStateError):
            accept_trade(stale, "ana", NOW + 400_000)
        assert is_open(stale, NOW + 400_000) is False
        assert is_open(stale, NOW + 1000) is True

    def test_refuses_anyone_who_is_not_a_party(self) -> None:
        with pytest.raises(ValidationError):
            accept_trade(trade(), "cai", NOW)
        with pytest.raises(ValidationError):
            cancel_trade(trade(), "cai", NOW)


class TestSettleTrade:
    def test_moves_both_sides_at_once(self) -> None:
        settled = settle_trade(
            engine(),
            trade=accepted(),
            left_account=make_account(ANA, 500),
            right_account=make_account(BEN, 20),
            items=ITEMS,
            **inventories(),
            **SETTLE,
        )
        assert settled.trade.state is TradeState.COMPLETED
        assert settled.trade.settled_at == SETTLE["now"]
        assert settled.booking is not None
        assert settled.booking.balances["guild-1/ana/COIN"] == 400
        assert settled.booking.balances["guild-1/ben/COIN"] == 120
        assert settled.left_inventory.inventory.quantity_of("sword") == 0
        assert settled.left_inventory.inventory.quantity_of("potion") == 3
        assert settled.right_inventory.inventory.quantity_of("potion") == 2
        assert settled.right_inventory.inventory.quantity_of("sword") == 1

    def test_nets_the_currency_into_a_single_movement(self) -> None:
        netted_trade = accept_trade(
            accept_trade(
                trade(left=TradeSide("ana", 100), right=TradeSide("ben", 30)),
                "ana",
                NOW,
            ),
            "ben",
            NOW,
        )
        settled = settle_trade(
            engine(),
            trade=netted_trade,
            left_account=make_account(ANA, 500),
            right_account=make_account(BEN, 500),
            left_inventory=Inventory(),
            right_inventory=Inventory(),
            items=ITEMS,
            **SETTLE,
        )
        assert settled.booking is not None
        assert settled.booking.posting.amount == 70
        assert settled.booking.balances["guild-1/ana/COIN"] == 430
        assert settled.booking.balances["guild-1/ben/COIN"] == 570

    def test_books_nothing_when_only_items_change_hands(self) -> None:
        items_only = accept_trade(
            accept_trade(
                trade(
                    left=TradeSide("ana", 0, (InventorySlot("sword", 1),)),
                    right=TradeSide("ben", 0, (InventorySlot("potion", 1),)),
                ),
                "ana",
                NOW,
            ),
            "ben",
            NOW,
        )
        settled = settle_trade(
            engine(),
            trade=items_only,
            left_account=make_account(ANA, 500),
            right_account=make_account(BEN, 500),
            items=ITEMS,
            **inventories(),
            **SETTLE,
        )
        assert settled.booking is None

    def test_conserves_currency_and_items(self) -> None:
        settled = settle_trade(
            engine(),
            trade=accepted(),
            left_account=make_account(ANA, 500),
            right_account=make_account(BEN, 20),
            items=ITEMS,
            **inventories(),
            **SETTLE,
        )
        assert settled.booking is not None
        after = (
            settled.booking.balances["guild-1/ana/COIN"]
            + settled.booking.balances["guild-1/ben/COIN"]
        )
        assert after == 520

        swords = settled.left_inventory.inventory.quantity_of(
            "sword"
        ) + settled.right_inventory.inventory.quantity_of("sword")
        potions = settled.left_inventory.inventory.quantity_of(
            "potion"
        ) + settled.right_inventory.inventory.quantity_of("potion")
        assert swords == 1
        assert potions == 5

    def test_only_settles_an_accepted_trade(self) -> None:
        with pytest.raises(TradeStateError):
            settle_trade(
                engine(),
                trade=trade(),
                left_account=make_account(ANA, 500),
                right_account=make_account(BEN, 20),
                items=ITEMS,
                **inventories(),
                **SETTLE,
            )

    def test_refuses_to_settle_after_expiry(self) -> None:
        with pytest.raises(TradeStateError):
            settle_trade(
                engine(),
                trade=accepted(),
                left_account=make_account(ANA, 500),
                right_account=make_account(BEN, 20),
                items=ITEMS,
                **inventories(),
                now=NOW + 400_000,
                operation_id="op",
                reason="late",
            )

    def test_refuses_when_a_party_cannot_pay(self) -> None:
        with pytest.raises(InsufficientFundsError):
            settle_trade(
                engine(),
                trade=accepted(),
                left_account=make_account(ANA, 10),
                right_account=make_account(BEN, 20),
                items=ITEMS,
                **inventories(),
                **SETTLE,
            )

    def test_refuses_when_a_party_does_not_hold_what_they_offered(self) -> None:
        with pytest.raises(ItemError):
            settle_trade(
                engine(),
                trade=accepted(),
                left_account=make_account(ANA, 500),
                right_account=make_account(BEN, 20),
                left_inventory=Inventory(),
                right_inventory=Inventory([InventorySlot("potion", 5)]),
                items=ITEMS,
                **SETTLE,
            )

    def test_refuses_to_trade_a_bound_item(self) -> None:
        bound = accept_trade(
            accept_trade(
                trade(
                    left=TradeSide("ana", 0, (InventorySlot("trophy", 1),)),
                    right=TradeSide("ben", 50),
                ),
                "ana",
                NOW,
            ),
            "ben",
            NOW,
        )
        with pytest.raises(ItemError):
            settle_trade(
                engine(),
                trade=bound,
                left_account=make_account(ANA, 500),
                right_account=make_account(BEN, 500),
                left_inventory=Inventory([InventorySlot("trophy", 1)]),
                right_inventory=Inventory(),
                items=ITEMS,
                **SETTLE,
            )

    def test_needs_every_item_it_references(self) -> None:
        with pytest.raises(ItemError):
            settle_trade(
                engine(),
                trade=accepted(),
                left_account=make_account(ANA, 500),
                right_account=make_account(BEN, 20),
                items={"sword": SWORD},
                **inventories(),
                **SETTLE,
            )

    @pytest.mark.parametrize(
        "left_ref",
        [
            member_account(SCOPE, "cai", COIN),
            member_account("guild-2", "ana", COIN),
            member_account(SCOPE, "ana", "GLD"),
        ],
    )
    def test_refuses_accounts_that_do_not_match(self, left_ref: Any) -> None:
        with pytest.raises(ValidationError):
            settle_trade(
                engine(),
                trade=accepted(),
                left_account=empty_account(left_ref),
                right_account=make_account(BEN, 20),
                items=ITEMS,
                **inventories(),
                **SETTLE,
            )

    def test_leaves_no_damage_behind_when_it_refuses(self) -> None:
        left = Inventory([InventorySlot("sword", 1)])
        right = Inventory([InventorySlot("potion", 5)])
        with pytest.raises(InsufficientFundsError):
            settle_trade(
                engine(),
                trade=accepted(),
                left_account=make_account(ANA, 0),
                right_account=make_account(BEN, 20),
                left_inventory=left,
                right_inventory=right,
                items=ITEMS,
                **SETTLE,
            )
        # The inputs are untouched: an abandoned trade costs nobody anything.
        assert left.quantity_of("sword") == 1
        assert right.quantity_of("potion") == 5
