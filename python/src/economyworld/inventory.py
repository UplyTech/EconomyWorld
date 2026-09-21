"""Items and inventories.

Items are what makes a balance worth having. Without something to spend it on,
currency is a number that goes up.

Inventories are immutable value objects, like everything else the caller gets
back: every operation returns a new one rather than modifying the old, so a
failed booking cannot leave a half-applied change behind.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any

from .constants import MAX_ITEM_QUANTITY
from .errors import (
    ConfigurationError,
    InsufficientQuantityError,
    ItemError,
    ValidationError,
)

__all__ = [
    "Item",
    "InventorySlot",
    "InventoryDelta",
    "InventoryChange",
    "Inventory",
    "create_item",
    "add_item",
    "remove_item",
    "move_item",
    "apply_changes",
]


@dataclass(frozen=True)
class Item:
    """Something a member can own."""

    item_id: str
    name: str
    #: Whether several of these share one inventory slot.
    #:
    #: A non-stackable item takes one slot per copy -- the usual choice for
    #: anything that should feel individual.
    stackable: bool = True
    #: Whether members may hand it to each other.
    #:
    #: Setting this to ``False`` is the mechanism for anything that would break
    #: if it were transferable: a reward for an achievement, a role token, a
    #: one-per-member cosmetic.
    tradable: bool = True
    #: Largest quantity in one slot, for stackable items.
    max_stack: int | None = None
    metadata: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))


def create_item(
    item_id: str,
    name: str | None = None,
    stackable: bool = True,
    tradable: bool = True,
    max_stack: int | None = None,
    metadata: Mapping[str, str] | None = None,
) -> Item:
    """Build a validated :class:`Item`."""
    if not isinstance(item_id, str) or not item_id:
        raise ConfigurationError("An item needs a non-empty item_id", item_id=item_id)
    if max_stack is not None and (
        not isinstance(max_stack, int) or isinstance(max_stack, bool) or max_stack < 1
    ):
        raise ConfigurationError(
            "max_stack must be a positive integer or None", max_stack=max_stack
        )
    if not stackable and max_stack is not None and max_stack != 1:
        raise ConfigurationError(
            "A non-stackable item cannot have a max_stack above 1",
            item_id=item_id,
            max_stack=max_stack,
        )

    return Item(
        item_id=item_id,
        name=name if name is not None else item_id,
        stackable=stackable,
        tradable=tradable,
        max_stack=max_stack if stackable else 1,
        metadata=MappingProxyType(dict(metadata or {})),
    )


@dataclass(frozen=True)
class InventorySlot:
    """How much of one item a member holds."""

    item_id: str
    quantity: int


@dataclass(frozen=True)
class InventoryDelta:
    """What an inventory change did, so the caller knows what to write."""

    item_id: str
    delta: int
    quantity_before: int
    quantity_after: int


class Inventory:
    """A member's holdings, as an immutable value object."""

    __slots__ = ("_quantities",)

    def __init__(self, slots: Iterable[InventorySlot | tuple[str, int]] = ()) -> None:
        quantities: dict[str, int] = {}
        for slot in slots:
            item_id, quantity = (
                (slot.item_id, slot.quantity)
                if isinstance(slot, InventorySlot)
                else (slot[0], slot[1])
            )
            if not isinstance(item_id, str) or not item_id:
                raise ValidationError("An inventory slot needs a non-empty item_id")
            if not isinstance(quantity, int) or isinstance(quantity, bool) or quantity < 0:
                raise ValidationError(
                    "An inventory quantity must be a non-negative integer",
                    item_id=item_id,
                    quantity=quantity,
                )
            if quantity > 0:
                quantities[item_id] = quantities.get(item_id, 0) + quantity
        self._quantities = quantities

    def quantity_of(self, item_id: str) -> int:
        """How many of this item the member holds."""
        return self._quantities.get(item_id, 0)

    def has(self, item_id: str, quantity: int = 1) -> bool:
        """True when the member holds at least ``quantity`` of the item."""
        return self.quantity_of(item_id) >= quantity

    @property
    def slots(self) -> tuple[InventorySlot, ...]:
        """Every non-empty slot, sorted by item id for a stable order."""
        return tuple(
            InventorySlot(item_id=item_id, quantity=self._quantities[item_id])
            for item_id in sorted(self._quantities)
        )

    @property
    def size(self) -> int:
        """How many distinct items the member holds."""
        return len(self._quantities)

    @property
    def is_empty(self) -> bool:
        """True when the member holds nothing."""
        return not self._quantities

    def to_list(self) -> list[dict[str, Any]]:
        """Plain form, ready for :func:`json.dumps`."""
        return [{"itemId": slot.item_id, "quantity": slot.quantity} for slot in self.slots]

    @staticmethod
    def from_list(raw: Sequence[Mapping[str, Any]]) -> Inventory:
        """Rebuild an inventory from stored data."""
        if not isinstance(raw, (list, tuple)):
            raise ValidationError("A stored inventory must be a list of slots")
        return Inventory(
            InventorySlot(
                item_id=str(entry.get("itemId", entry.get("item_id", ""))),
                quantity=int(entry.get("quantity", 0)),
            )
            for entry in raw
        )

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Inventory):
            return NotImplemented
        return self._quantities == other._quantities

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Inventory({self.to_list()!r})"


@dataclass(frozen=True)
class InventoryChange:
    """The result of an inventory operation."""

    #: The new inventory. The input is left untouched.
    inventory: Inventory
    #: The rows the caller has to update.
    deltas: tuple[InventoryDelta, ...]


def add_item(inventory: Inventory, item: Item, quantity: int = 1) -> InventoryChange:
    """Put items into an inventory."""
    _assert_quantity(quantity)
    before = inventory.quantity_of(item.item_id)
    after = before + quantity

    if after > MAX_ITEM_QUANTITY:
        raise ItemError(
            "An inventory slot cannot hold that many",
            item_id=item.item_id,
            quantity=after,
            limit=MAX_ITEM_QUANTITY,
        )
    if item.max_stack is not None and after > item.max_stack:
        raise ItemError(
            "That would exceed the item's maximum stack"
            if item.stackable
            else "A non-stackable item cannot be held more than once",
            item_id=item.item_id,
            quantity=after,
            max_stack=item.max_stack,
        )

    return InventoryChange(
        inventory=_replace(inventory, item.item_id, after),
        deltas=(
            InventoryDelta(
                item_id=item.item_id,
                delta=quantity,
                quantity_before=before,
                quantity_after=after,
            ),
        ),
    )


def remove_item(inventory: Inventory, item_id: str, quantity: int = 1) -> InventoryChange:
    """Take items out of an inventory."""
    _assert_quantity(quantity)
    before = inventory.quantity_of(item_id)
    if before < quantity:
        raise InsufficientQuantityError(item_id=item_id, held=before, required=quantity)
    after = before - quantity
    return InventoryChange(
        inventory=_replace(inventory, item_id, after),
        deltas=(
            InventoryDelta(
                item_id=item_id,
                delta=-quantity,
                quantity_before=before,
                quantity_after=after,
            ),
        ),
    )


def move_item(
    source: Inventory, target: Inventory, item: Item, quantity: int = 1
) -> tuple[InventoryChange, InventoryChange]:
    """Move items from one inventory to another.

    Returns both new inventories together, because a move that only half
    happened is the inventory equivalent of a half-executed transfer. Write them
    in one transaction, the same way you write a posting.
    """
    if not item.tradable:
        raise ItemError("This item cannot be moved between members", item_id=item.item_id)
    return (
        remove_item(source, item.item_id, quantity),
        add_item(target, item, quantity),
    )


def apply_changes(
    inventory: Inventory, changes: Sequence[tuple[Item, int]]
) -> InventoryChange:
    """Apply several changes to one inventory in order."""
    current = inventory
    deltas: list[InventoryDelta] = []
    for item, quantity in changes:
        step = (
            add_item(current, item, quantity)
            if quantity >= 0
            else remove_item(current, item.item_id, -quantity)
        )
        current = step.inventory
        deltas.extend(step.deltas)
    return InventoryChange(inventory=current, deltas=tuple(deltas))


def _replace(inventory: Inventory, item_id: str, quantity: int) -> Inventory:
    slots = [slot for slot in inventory.slots if slot.item_id != item_id]
    if quantity > 0:
        slots.append(InventorySlot(item_id=item_id, quantity=quantity))
    return Inventory(slots)


def _assert_quantity(quantity: int) -> None:
    if not isinstance(quantity, int) or isinstance(quantity, bool) or quantity < 1:
        raise ValidationError("A quantity must be a positive integer", quantity=quantity)
    if quantity > MAX_ITEM_QUANTITY:
        raise ValidationError(
            "A quantity above the supported maximum",
            quantity=quantity,
            limit=MAX_ITEM_QUANTITY,
        )
