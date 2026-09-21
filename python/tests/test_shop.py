"""Offers and purchases."""

from __future__ import annotations

from typing import Any

import pytest

from economyworld import (
    ConfigurationError,
    CurrencyMismatchError,
    EconomyEngine,
    InsufficientFundsError,
    Inventory,
    InventorySlot,
    ItemError,
    OfferError,
    PostingKind,
    ValidationError,
    create_currency,
    create_item,
    create_offer,
    empty_account,
    is_available,
    make_account,
    max_purchasable,
    member_account,
    purchase,
)

SCOPE = "guild-1"
COIN = "COIN"
NOW = 1_700_000_000_000
HOUR = 3_600_000

ANA = member_account(SCOPE, "ana", COIN)
POTION = create_item("potion", name="Potion", max_stack=10)


def engine() -> EconomyEngine:
    return EconomyEngine(currencies=[create_currency(COIN, max_balance=1_000_000)])


def offer(**overrides: Any):
    defaults: dict[str, Any] = {
        "offer_id": "offer-potion",
        "item_id": "potion",
        "unit_price": 50,
        "currency": COIN,
    }
    defaults.update(overrides)
    return create_offer(**defaults)


OPTS: dict[str, Any] = {
    "now": NOW,
    "operation_id": "op-1",
    "reason": "shop purchase",
}


class TestCreateOffer:
    def test_defaults_to_an_unlimited_open_offer(self) -> None:
        created = offer()
        assert created.stock is None
        assert created.per_member_limit is None
        assert created.enabled is True
        assert created.available_from is None

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"offer_id": ""},
            {"item_id": ""},
            {"unit_price": -1},
            {"stock": -1},
            {"per_member_limit": 0},
            {"available_from": NOW + HOUR, "available_until": NOW},
        ],
    )
    def test_rejects_impossible_offers(self, kwargs: dict) -> None:
        with pytest.raises(ConfigurationError):
            offer(**kwargs)


class TestPurchase:
    def test_moves_money_and_items_together(self) -> None:
        result = purchase(
            engine(),
            offer=offer(stock=5),
            item=POTION,
            buyer=make_account(ANA, 500),
            inventory=Inventory(),
            **OPTS,
        )
        assert result.total_price == 50
        assert result.booking.balances["guild-1/ana/COIN"] == 450
        assert result.booking.balances["guild-1/system:shop/COIN"] == 50
        assert result.inventory.inventory.quantity_of("potion") == 1
        assert result.offer.stock == 4

    def test_multiplies_the_price_by_the_quantity(self) -> None:
        result = purchase(
            engine(),
            offer=offer(stock=10),
            item=POTION,
            buyer=make_account(ANA, 500),
            inventory=Inventory(),
            quantity=3,
            **OPTS,
        )
        assert result.total_price == 150
        assert result.inventory.inventory.quantity_of("potion") == 3
        assert result.offer.stock == 7

    def test_leaves_an_unlimited_offer_unlimited(self) -> None:
        result = purchase(
            engine(),
            offer=offer(),
            item=POTION,
            buyer=make_account(ANA, 500),
            inventory=Inventory(),
            **OPTS,
        )
        assert result.offer.stock is None

    def test_refuses_when_the_buyer_cannot_pay(self) -> None:
        with pytest.raises(InsufficientFundsError):
            purchase(
                engine(),
                offer=offer(),
                item=POTION,
                buyer=make_account(ANA, 10),
                inventory=Inventory(),
                **OPTS,
            )

    def test_refuses_when_the_item_would_not_fit(self) -> None:
        with pytest.raises(ItemError):
            purchase(
                engine(),
                offer=offer(),
                item=POTION,
                buyer=make_account(ANA, 5000),
                inventory=Inventory([InventorySlot("potion", 10)]),
                **OPTS,
            )

    @pytest.mark.parametrize(
        "patch",
        [
            {"stock": 0},
            {"enabled": False},
            {"available_from": NOW + HOUR},
            {"available_until": NOW},
        ],
    )
    def test_refuses_an_offer_that_cannot_be_bought(self, patch: dict) -> None:
        with pytest.raises(OfferError):
            purchase(
                engine(),
                offer=offer(**patch),
                item=POTION,
                buyer=make_account(ANA, 5000),
                inventory=Inventory(),
                **OPTS,
            )

    def test_refuses_to_sell_more_than_is_in_stock(self) -> None:
        with pytest.raises(OfferError):
            purchase(
                engine(),
                offer=offer(stock=2),
                item=POTION,
                buyer=make_account(ANA, 5000),
                inventory=Inventory(),
                quantity=3,
                **OPTS,
            )

    def test_enforces_the_per_member_limit(self) -> None:
        limited = offer(per_member_limit=3)
        with pytest.raises(OfferError):
            purchase(
                engine(),
                offer=limited,
                item=POTION,
                buyer=make_account(ANA, 5000),
                inventory=Inventory(),
                quantity=2,
                already_purchased=2,
                **OPTS,
            )
        allowed = purchase(
            engine(),
            offer=limited,
            item=POTION,
            buyer=make_account(ANA, 5000),
            inventory=Inventory(),
            already_purchased=2,
            **OPTS,
        )
        assert allowed.quantity == 1

    def test_refuses_a_mismatched_item(self) -> None:
        with pytest.raises(ValidationError):
            purchase(
                engine(),
                offer=offer(),
                item=create_item("sword"),
                buyer=make_account(ANA, 5000),
                inventory=Inventory(),
                **OPTS,
            )

    def test_refuses_a_mismatched_currency(self) -> None:
        with pytest.raises(CurrencyMismatchError):
            purchase(
                engine(),
                offer=offer(currency="GLD"),
                item=POTION,
                buyer=make_account(ANA, 5000),
                inventory=Inventory(),
                **OPTS,
            )

    @pytest.mark.parametrize("quantity", [0, -1, 1.5])
    def test_refuses_a_nonsensical_quantity(self, quantity: object) -> None:
        with pytest.raises(ValidationError):
            purchase(
                engine(),
                offer=offer(),
                item=POTION,
                buyer=make_account(ANA, 5000),
                inventory=Inventory(),
                quantity=quantity,  # type: ignore[arg-type]
                **OPTS,
            )

    def test_still_books_a_free_offer(self) -> None:
        result = purchase(
            engine(),
            offer=offer(unit_price=0),
            item=POTION,
            buyer=make_account(ANA, 0),
            inventory=Inventory(),
            **OPTS,
        )
        assert result.total_price == 0
        assert result.booking.posting.kind is PostingKind.PURCHASE
        assert result.booking.posting.metadata["free"] == "true"
        assert result.inventory.inventory.quantity_of("potion") == 1

    def test_can_send_the_money_elsewhere(self) -> None:
        treasury = member_account(SCOPE, "treasury", COIN)
        result = purchase(
            engine(),
            offer=offer(),
            item=POTION,
            buyer=make_account(ANA, 500),
            inventory=Inventory(),
            shop_account=empty_account(treasury),
            **OPTS,
        )
        assert result.booking.balances["guild-1/treasury/COIN"] == 50


class TestAvailability:
    @pytest.mark.parametrize(
        ("patch", "expected"),
        [
            ({}, True),
            ({"enabled": False}, False),
            ({"stock": 0}, False),
            ({"available_from": NOW + HOUR}, False),
            ({"available_until": NOW}, False),
            ({"available_from": NOW - HOUR, "available_until": NOW + HOUR}, True),
        ],
    )
    def test_reports_whether_the_offer_can_be_bought(
        self, patch: dict, expected: bool
    ) -> None:
        assert is_available(offer(**patch), NOW) is expected


class TestMaxPurchasable:
    def test_is_limited_by_the_balance(self) -> None:
        assert max_purchasable(offer(), 175, 0, NOW) == 3

    def test_is_limited_by_the_stock(self) -> None:
        assert max_purchasable(offer(stock=2), 5000, 0, NOW) == 2

    def test_is_limited_by_the_member_allowance(self) -> None:
        assert max_purchasable(offer(per_member_limit=5), 5000, 4, NOW) == 1
        assert max_purchasable(offer(per_member_limit=5), 5000, 5, NOW) == 0

    def test_is_zero_for_an_unavailable_offer(self) -> None:
        assert max_purchasable(offer(enabled=False), 5000, 0, NOW) == 0

    def test_is_unbounded_for_a_free_unlimited_offer(self) -> None:
        assert max_purchasable(offer(unit_price=0), 0, 0, NOW) == 9007199254740991
