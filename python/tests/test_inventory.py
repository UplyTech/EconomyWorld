"""Items and inventories."""

from __future__ import annotations

import json

import pytest

from economyworld import (
    MAX_ITEM_QUANTITY,
    ConfigurationError,
    InsufficientQuantityError,
    Inventory,
    InventorySlot,
    ItemError,
    ValidationError,
    add_item,
    apply_changes,
    create_item,
    move_item,
    remove_item,
)

SWORD = create_item("sword", name="Sword", stackable=False)
POTION = create_item("potion", name="Potion", max_stack=10)
TROPHY = create_item("trophy", name="Trophy", tradable=False)
BAG = create_item("bag")


class TestCreateItem:
    def test_defaults_to_stackable_and_tradable(self) -> None:
        assert BAG.stackable is True
        assert BAG.tradable is True
        assert BAG.max_stack is None
        assert BAG.name == "bag"

    def test_caps_a_non_stackable_item_at_one(self) -> None:
        assert SWORD.max_stack == 1

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"item_id": ""},
            {"item_id": "x", "max_stack": 0},
            {"item_id": "x", "max_stack": 1.5},
            {"item_id": "x", "stackable": False, "max_stack": 5},
        ],
    )
    def test_rejects_impossible_items(self, kwargs: dict) -> None:
        with pytest.raises(ConfigurationError):
            create_item(**kwargs)

    def test_metadata_is_read_only(self) -> None:
        item = create_item("x", metadata={"rarity": "rare"})
        assert item.metadata["rarity"] == "rare"
        with pytest.raises(TypeError):
            item.metadata["rarity"] = "common"  # type: ignore[index]


class TestInventory:
    def test_starts_empty(self) -> None:
        inventory = Inventory()
        assert inventory.is_empty is True
        assert inventory.size == 0
        assert inventory.quantity_of("sword") == 0
        assert inventory.has("sword") is False

    def test_reports_slots_in_a_stable_order(self) -> None:
        inventory = Inventory(
            [
                InventorySlot("sword", 1),
                InventorySlot("bag", 3),
                InventorySlot("potion", 2),
            ]
        )
        assert [slot.item_id for slot in inventory.slots] == ["bag", "potion", "sword"]

    def test_merges_duplicates_and_drops_empty_slots(self) -> None:
        inventory = Inventory(
            [
                InventorySlot("potion", 2),
                InventorySlot("potion", 3),
                InventorySlot("bag", 0),
            ]
        )
        assert inventory.quantity_of("potion") == 5
        assert inventory.quantity_of("bag") == 0
        assert inventory.size == 1

    def test_accepts_plain_tuples(self) -> None:
        assert Inventory([("potion", 4)]).quantity_of("potion") == 4

    def test_round_trips_through_json(self) -> None:
        inventory = Inventory([InventorySlot("potion", 4)])
        restored = Inventory.from_list(json.loads(json.dumps(inventory.to_list())))
        assert restored.quantity_of("potion") == 4
        assert restored == inventory

    @pytest.mark.parametrize(
        "slots",
        [
            [InventorySlot("", 1)],
            [InventorySlot("x", -1)],
            [InventorySlot("x", 1.5)],
        ],
    )
    def test_rejects_data_it_cannot_trust(self, slots: list) -> None:
        with pytest.raises(ValidationError):
            Inventory(slots)

    def test_rejects_a_stored_value_that_is_not_a_list(self) -> None:
        with pytest.raises(ValidationError):
            Inventory.from_list("nope")  # type: ignore[arg-type]

    def test_compares_by_contents(self) -> None:
        assert Inventory([("potion", 2)]) == Inventory([("potion", 1), ("potion", 1)])
        assert Inventory([("potion", 2)]) != Inventory([("potion", 3)])
        assert Inventory().__eq__("not an inventory") is NotImplemented


class TestAddItem:
    def test_puts_items_in_and_reports_the_delta(self) -> None:
        change = add_item(Inventory(), POTION, 3)
        assert change.inventory.quantity_of("potion") == 3
        assert change.deltas[0].delta == 3
        assert change.deltas[0].quantity_before == 0
        assert change.deltas[0].quantity_after == 3

    def test_leaves_the_input_untouched(self) -> None:
        before = Inventory([InventorySlot("potion", 1)])
        add_item(before, POTION, 3)
        assert before.quantity_of("potion") == 1

    def test_respects_the_maximum_stack(self) -> None:
        inventory = Inventory([InventorySlot("potion", 8)])
        with pytest.raises(ItemError):
            add_item(inventory, POTION, 3)
        assert add_item(inventory, POTION, 2).inventory.quantity_of("potion") == 10

    def test_refuses_a_second_non_stackable_copy(self) -> None:
        inventory = add_item(Inventory(), SWORD, 1).inventory
        with pytest.raises(ItemError):
            add_item(inventory, SWORD, 1)

    @pytest.mark.parametrize("quantity", [0, -1, MAX_ITEM_QUANTITY + 1])
    def test_refuses_an_absurd_quantity(self, quantity: int) -> None:
        with pytest.raises(ValidationError):
            add_item(Inventory(), BAG, quantity)

    def test_refuses_to_exceed_the_global_ceiling(self) -> None:
        inventory = Inventory([InventorySlot("bag", MAX_ITEM_QUANTITY)])
        with pytest.raises(ItemError):
            add_item(inventory, BAG, 1)


class TestRemoveItem:
    def test_takes_items_out_and_reports_the_delta(self) -> None:
        change = remove_item(Inventory([InventorySlot("potion", 5)]), "potion", 2)
        assert change.inventory.quantity_of("potion") == 3
        assert change.deltas[0].delta == -2

    def test_removes_the_slot_when_it_empties(self) -> None:
        change = remove_item(Inventory([InventorySlot("potion", 2)]), "potion", 2)
        assert change.inventory.is_empty is True

    def test_refuses_to_take_more_than_is_held(self) -> None:
        with pytest.raises(InsufficientQuantityError):
            remove_item(Inventory([InventorySlot("potion", 1)]), "potion", 2)
        with pytest.raises(InsufficientQuantityError):
            remove_item(Inventory(), "potion", 1)


class TestMoveItem:
    def test_hands_an_item_over(self) -> None:
        source = Inventory([InventorySlot("potion", 5)])
        removed, added = move_item(source, Inventory(), POTION, 2)
        assert removed.inventory.quantity_of("potion") == 3
        assert added.inventory.quantity_of("potion") == 2

    def test_conserves_the_total(self) -> None:
        source = Inventory([InventorySlot("potion", 5)])
        target = Inventory([InventorySlot("potion", 1)])
        removed, added = move_item(source, target, POTION, 3)
        assert (
            removed.inventory.quantity_of("potion") + added.inventory.quantity_of("potion")
            == 6
        )

    def test_refuses_to_move_a_bound_item(self) -> None:
        source = Inventory([InventorySlot("trophy", 1)])
        with pytest.raises(ItemError):
            move_item(source, Inventory(), TROPHY, 1)

    def test_refuses_when_the_sender_does_not_hold_it(self) -> None:
        with pytest.raises(InsufficientQuantityError):
            move_item(Inventory(), Inventory(), POTION, 1)


class TestApplyChanges:
    def test_applies_several_changes_in_order(self) -> None:
        change = apply_changes(
            Inventory([InventorySlot("potion", 5)]),
            [(POTION, 3), (POTION, -6), (BAG, 2)],
        )
        assert change.inventory.quantity_of("potion") == 2
        assert change.inventory.quantity_of("bag") == 2
        assert len(change.deltas) == 3

    def test_fails_as_a_whole_if_any_step_is_impossible(self) -> None:
        with pytest.raises(InsufficientQuantityError):
            apply_changes(Inventory(), [(POTION, 2), (POTION, -5)])
