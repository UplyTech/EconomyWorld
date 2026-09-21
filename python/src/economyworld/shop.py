"""Offers, and buying from them.

The route from a balance to an item. An offer is data, not behaviour: the caller
stores it, edits it, and hands it in when somebody buys.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from types import MappingProxyType

from .accounts import Account, SystemAccount, account_key, empty_account, system_account
from .engine import EconomyEngine
from .errors import (
    ConfigurationError,
    CurrencyMismatchError,
    OfferError,
    ValidationError,
)
from .inventory import Inventory, InventoryChange, Item, add_item
from .ledger import PostingKind, PostingLine, create_posting
from .money import assert_positive_amount
from .types import BookingResult

__all__ = [
    "Offer",
    "PurchaseResult",
    "create_offer",
    "purchase",
    "is_available",
    "max_purchasable",
]


@dataclass(frozen=True)
class Offer:
    """Something on sale."""

    offer_id: str
    item_id: str
    #: Price for one unit, in minor units.
    unit_price: int
    currency: str
    #: Units left, or ``None`` for an unlimited offer.
    stock: int | None = None
    #: How many one member may ever buy, or ``None`` for no limit.
    per_member_limit: int | None = None
    enabled: bool = True
    #: Epoch milliseconds the offer opens, or ``None`` for always.
    available_from: int | None = None
    #: Epoch milliseconds the offer closes, or ``None`` for never.
    available_until: int | None = None


def create_offer(
    offer_id: str,
    item_id: str,
    unit_price: int,
    currency: str,
    stock: int | None = None,
    per_member_limit: int | None = None,
    enabled: bool = True,
    available_from: int | None = None,
    available_until: int | None = None,
) -> Offer:
    """Build a validated :class:`Offer`."""
    if not isinstance(offer_id, str) or not offer_id:
        raise ConfigurationError("An offer needs a non-empty offer_id")
    if not isinstance(item_id, str) or not item_id:
        raise ConfigurationError("An offer needs an item_id", offer_id=offer_id)
    if not isinstance(unit_price, int) or isinstance(unit_price, bool) or unit_price < 0:
        raise ConfigurationError(
            "unit_price must be a non-negative integer", unit_price=unit_price
        )
    if stock is not None and (
        not isinstance(stock, int) or isinstance(stock, bool) or stock < 0
    ):
        raise ConfigurationError("stock must be a non-negative integer or None", stock=stock)
    if per_member_limit is not None and (
        not isinstance(per_member_limit, int)
        or isinstance(per_member_limit, bool)
        or per_member_limit < 1
    ):
        raise ConfigurationError(
            "per_member_limit must be a positive integer or None",
            per_member_limit=per_member_limit,
        )
    if (
        available_from is not None
        and available_until is not None
        and available_until <= available_from
    ):
        raise ConfigurationError(
            "An offer cannot close before it opens",
            available_from=available_from,
            available_until=available_until,
        )

    return Offer(
        offer_id=offer_id,
        item_id=item_id,
        unit_price=unit_price,
        currency=currency,
        stock=stock,
        per_member_limit=per_member_limit,
        enabled=enabled,
        available_from=available_from,
        available_until=available_until,
    )


@dataclass(frozen=True)
class PurchaseResult:
    """What a purchase produced. Write all three parts in one transaction."""

    #: The payment.
    booking: BookingResult
    #: The items the buyer received.
    inventory: InventoryChange
    #: The offer with its stock reduced, ready to be stored.
    offer: Offer
    quantity: int
    total_price: int


def purchase(
    engine: EconomyEngine,
    offer: Offer,
    item: Item,
    buyer: Account,
    inventory: Inventory,
    now: int,
    operation_id: str,
    reason: str,
    quantity: int = 1,
    already_purchased: int = 0,
    shop_account: Account | None = None,
    metadata: Mapping[str, str] | None = None,
) -> PurchaseResult:
    """Buy from an offer.

    Three things change together: the buyer's balance, the buyer's inventory and
    the offer's stock. They come back as one result and belong in one database
    transaction -- the same rule as everywhere else in this package. A purchase
    where the money left but the item never arrived is the complaint you will be
    answering for the rest of the week.

    Everything that could make the purchase impossible is checked before
    anything is produced: availability, stock, per-member limit, funds,
    inventory space.
    """
    if not isinstance(quantity, int) or isinstance(quantity, bool) or quantity < 1:
        raise ValidationError(
            "A purchase quantity must be a positive integer", quantity=quantity
        )
    if offer.item_id != item.item_id:
        raise ValidationError(
            "The offer and the item do not match",
            offer_item=offer.item_id,
            item=item.item_id,
        )
    if offer.currency != buyer.ref.currency:
        raise CurrencyMismatchError(expected=offer.currency, received=buyer.ref.currency)

    _assert_available(offer, now)

    if offer.stock is not None and offer.stock < quantity:
        raise OfferError(
            "The offer does not have that many left",
            offer_id=offer.offer_id,
            stock=offer.stock,
            requested=quantity,
        )

    if (
        offer.per_member_limit is not None
        and already_purchased + quantity > offer.per_member_limit
    ):
        raise OfferError(
            "That would exceed the per-member limit for this offer",
            offer_id=offer.offer_id,
            limit=offer.per_member_limit,
            already_purchased=already_purchased,
            requested=quantity,
        )

    total_price = offer.unit_price * quantity

    # Produce the inventory change first: it can still fail on a stack limit,
    # and failing before the payment is built keeps the two from disagreeing.
    inventory_change = add_item(inventory, item, quantity)

    resolved_shop = shop_account or empty_account(
        system_account(
            buyer.ref.scope,
            buyer.ref.currency,
            _shop_kind(engine),
        )
    )

    combined_metadata = {
        **dict(metadata or {}),
        "offerId": offer.offer_id,
        "itemId": item.item_id,
        "quantity": str(quantity),
    }

    if total_price == 0:
        # A free offer still books, so the audit trail records that it was taken.
        booking = _zero_booking(
            buyer, resolved_shop, now, operation_id, reason, combined_metadata
        )
    else:
        assert_positive_amount(total_price)
        booking = engine.transfer(
            buyer,
            resolved_shop,
            total_price,
            now=now,
            operation_id=operation_id,
            reason=reason,
            metadata=combined_metadata,
        )

    return PurchaseResult(
        booking=booking,
        inventory=inventory_change,
        offer=replace(offer, stock=None if offer.stock is None else offer.stock - quantity),
        quantity=quantity,
        total_price=total_price,
    )


def is_available(offer: Offer, now: int) -> bool:
    """True when the offer can be bought at this moment."""
    if not offer.enabled:
        return False
    if offer.available_from is not None and now < offer.available_from:
        return False
    if offer.available_until is not None and now >= offer.available_until:
        return False
    return offer.stock is None or offer.stock > 0


def max_purchasable(
    offer: Offer, balance: int, already_purchased: int = 0, now: int = 0
) -> int:
    """The largest quantity a member could buy right now."""
    if not is_available(offer, now):
        return 0
    limits: list[int] = []
    if offer.unit_price > 0:
        limits.append(balance // offer.unit_price)
    if offer.stock is not None:
        limits.append(offer.stock)
    if offer.per_member_limit is not None:
        limits.append(max(0, offer.per_member_limit - already_purchased))
    if not limits:
        return 9007199254740991
    return max(0, min(limits))


def _shop_kind(engine: EconomyEngine) -> SystemAccount:
    # The engine refused an owner that is not a system account when it was
    # built, so this always finds one.
    return SystemAccount(engine.config.shop_account_owner)


def _assert_available(offer: Offer, now: int) -> None:
    if not offer.enabled:
        raise OfferError("This offer is not on sale", offer_id=offer.offer_id)
    if offer.available_from is not None and now < offer.available_from:
        raise OfferError(
            "This offer has not opened yet",
            offer_id=offer.offer_id,
            available_from=offer.available_from,
        )
    if offer.available_until is not None and now >= offer.available_until:
        raise OfferError(
            "This offer has closed",
            offer_id=offer.offer_id,
            available_until=offer.available_until,
        )
    if offer.stock is not None and offer.stock <= 0:
        raise OfferError("This offer is sold out", offer_id=offer.offer_id)


def _zero_booking(
    buyer: Account,
    shop: Account,
    now: int,
    operation_id: str,
    reason: str,
    metadata: Mapping[str, str],
) -> BookingResult:
    """A zero-amount posting, so a free offer still leaves an audit trail."""
    posting = create_posting(
        operation_id=operation_id,
        kind=PostingKind.PURCHASE,
        scope=buyer.ref.scope,
        currency=buyer.ref.currency,
        amount=0,
        reason=reason,
        occurred_at=now,
        lines=[
            PostingLine(
                account=buyer.ref,
                delta=0,
                balance_before=buyer.balance,
                balance_after=buyer.balance,
            ),
            PostingLine(
                account=shop.ref,
                delta=0,
                balance_before=shop.balance,
                balance_after=shop.balance,
            ),
        ],
        metadata=MappingProxyType({**dict(metadata), "free": "true"}),
    )
    return BookingResult(
        posting=posting,
        balances={
            account_key(buyer.ref): buyer.balance,
            account_key(shop.ref): shop.balance,
        },
    )
