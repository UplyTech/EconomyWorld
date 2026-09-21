"""Trading between two members.

# Why a trade is a state machine

A trade is the reason an inventory becomes interesting, and it is also the
easiest place in an economy to lose something. Two members each put up a side;
both have to agree; either may walk away; and if nobody finishes it, it has to
go away by itself.

Modelling that as "just swap the things" leaves no way to cancel, no way to
expire, and no way to answer "what happened to my sword?". So a trade here is an
explicit state with explicit transitions, and every invalid transition is an
error rather than a silent no-op::

                     +--------------+
                     |   PROPOSED   |
                     +------+-------+
             accept (both)  |  cancel        expire
                     +------+-------+   +--------------+
                     |   ACCEPTED   |   |   EXPIRED    |
                     +------+-------+   +--------------+
                     settle |        +--------------+
                     +------+-------+|  CANCELLED   |
                     |  COMPLETED   |+--------------+
                     +--------------+

``CANCELLED``, ``EXPIRED`` and ``COMPLETED`` are final. Nothing moves until
:func:`settle_trade`, and that produces one posting and both inventory changes
together -- so an abandoned trade leaves no damage behind, which is exactly what
the concept asks for.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from enum import Enum

from .accounts import Account, account_key
from .constants import DEFAULT_TRADE_TTL_SECONDS
from .engine import EconomyEngine
from .errors import (
    ConfigurationError,
    InsufficientFundsError,
    ItemError,
    TradeStateError,
    ValidationError,
)
from .inventory import (
    Inventory,
    InventoryChange,
    InventoryDelta,
    InventorySlot,
    Item,
    add_item,
    remove_item,
)
from .ledger import PostingKind, PostingLine, create_posting, resulting_balances
from .types import BookingResult

__all__ = [
    "TradeState",
    "TradeSide",
    "Trade",
    "TradeSettlement",
    "propose_trade",
    "accept_trade",
    "revoke_acceptance",
    "cancel_trade",
    "expire_trade",
    "settle_trade",
    "is_open",
    "is_final",
]


class TradeState(str, Enum):
    """Where a trade stands."""

    #: Offered, waiting for the other side.
    PROPOSED = "PROPOSED"
    #: Both sides agreed. Ready to settle.
    ACCEPTED = "ACCEPTED"
    #: Someone walked away. Final.
    CANCELLED = "CANCELLED"
    #: Nobody finished it in time. Final.
    EXPIRED = "EXPIRED"
    #: Settled. Final.
    COMPLETED = "COMPLETED"


@dataclass(frozen=True)
class TradeSide:
    """What one party puts up."""

    owner: str
    #: Currency offered, in minor units. May be zero.
    amount: int = 0
    #: Items offered. May be empty.
    items: tuple[InventorySlot, ...] = ()


@dataclass(frozen=True)
class Trade:
    """A trade between two members."""

    trade_id: str
    scope: str
    currency: str
    left: TradeSide
    right: TradeSide
    state: TradeState
    created_at: int
    expires_at: int
    #: Owners who have accepted, in the order they did.
    accepted_by: tuple[str, ...] = ()
    #: Set when the trade ended, whichever way.
    settled_at: int | None = None


@dataclass(frozen=True)
class TradeSettlement:
    """What settling produced. All of it belongs in one transaction."""

    trade: Trade
    #: The net currency movement. ``None`` when neither side offered any.
    booking: BookingResult | None
    left_inventory: InventoryChange
    right_inventory: InventoryChange


def propose_trade(
    trade_id: str,
    scope: str,
    currency: str,
    left: TradeSide,
    right: TradeSide,
    now: int,
    ttl_seconds: int = DEFAULT_TRADE_TTL_SECONDS,
) -> Trade:
    """Open a trade. Nothing moves yet."""
    if not isinstance(trade_id, str) or not trade_id:
        raise ConfigurationError("A trade needs a non-empty trade_id")
    _assert_side(left, "left")
    _assert_side(right, "right")
    if left.owner == right.owner:
        raise ValidationError("A member cannot trade with themselves", owner=left.owner)
    if _is_empty_side(left) and _is_empty_side(right):
        raise ValidationError(
            "A trade where neither side offers anything is not a trade",
            trade_id=trade_id,
        )
    if not isinstance(now, int) or isinstance(now, bool):
        raise ValidationError("now must be an epoch-millisecond timestamp", now=now)
    if not isinstance(ttl_seconds, int) or isinstance(ttl_seconds, bool) or ttl_seconds <= 0:
        raise ConfigurationError(
            "ttl_seconds must be a positive integer", ttl_seconds=ttl_seconds
        )

    return Trade(
        trade_id=trade_id,
        scope=scope,
        currency=currency,
        left=replace(left, items=tuple(left.items)),
        right=replace(right, items=tuple(right.items)),
        state=TradeState.PROPOSED,
        created_at=now,
        expires_at=now + ttl_seconds * 1000,
        accepted_by=(),
        settled_at=None,
    )


def accept_trade(trade: Trade, owner: str, now: int) -> Trade:
    """Record one party's agreement.

    The trade moves to ``ACCEPTED`` only once both have. Accepting twice is
    harmless and changes nothing.
    """
    _assert_open(trade, now, "accept")
    _assert_party(trade, owner)

    if owner in trade.accepted_by:
        return trade
    accepted_by = (*trade.accepted_by, owner)
    both = trade.left.owner in accepted_by and trade.right.owner in accepted_by
    return replace(
        trade,
        accepted_by=accepted_by,
        state=TradeState.ACCEPTED if both else TradeState.PROPOSED,
    )


def revoke_acceptance(trade: Trade, owner: str, now: int) -> Trade:
    """Withdraw an agreement without ending the trade.

    Useful when one side edits their offer: the other side's acceptance should
    not carry over to a different deal than the one they agreed to.
    """
    _assert_open(trade, now, "revoke acceptance for")
    _assert_party(trade, owner)
    return replace(
        trade,
        accepted_by=tuple(party for party in trade.accepted_by if party != owner),
        state=TradeState.PROPOSED,
    )


def cancel_trade(trade: Trade, owner: str, now: int) -> Trade:
    """Either party walks away. Final."""
    if is_final(trade):
        raise TradeStateError(
            f"A {trade.state.value.lower()} trade cannot be cancelled",
            trade_id=trade.trade_id,
            state=trade.state.value,
        )
    _assert_party(trade, owner)
    return replace(trade, state=TradeState.CANCELLED, settled_at=now, accepted_by=())


def expire_trade(trade: Trade, now: int) -> Trade:
    """Close a trade nobody finished.

    Call it from whatever sweeps your open trades. An expired trade has moved
    nothing, so there is nothing to undo.
    """
    if is_final(trade):
        return trade
    if now < trade.expires_at:
        raise TradeStateError(
            "This trade has not expired yet",
            trade_id=trade.trade_id,
            expires_at=trade.expires_at,
            now=now,
        )
    return replace(trade, state=TradeState.EXPIRED, settled_at=now)


def is_open(trade: Trade, now: int) -> bool:
    """True when the trade can still change."""
    return not is_final(trade) and now < trade.expires_at


def is_final(trade: Trade) -> bool:
    """True when the trade has reached a final state."""
    return trade.state in (
        TradeState.CANCELLED,
        TradeState.EXPIRED,
        TradeState.COMPLETED,
    )


def settle_trade(
    engine: EconomyEngine,
    trade: Trade,
    left_account: Account,
    right_account: Account,
    left_inventory: Inventory,
    right_inventory: Inventory,
    items: Mapping[str, Item],
    now: int,
    operation_id: str,
    reason: str,
    metadata: Mapping[str, str] | None = None,
) -> TradeSettlement:
    """Carry out an accepted trade.

    Both sides move at once. The currency is netted into a single posting: if
    one side offers 100 and the other 30, exactly 70 moves, rather than two
    bookings that would briefly leave one side short.

    Everything that could fail is checked before anything is produced. If this
    function returns, all four parts fit together -- and if it raises, nothing
    was half-built.
    """
    if trade.state is not TradeState.ACCEPTED:
        raise TradeStateError(
            "Only an accepted trade can be settled",
            trade_id=trade.trade_id,
            state=trade.state.value,
        )
    if now >= trade.expires_at:
        raise TradeStateError(
            "This trade expired before it was settled",
            trade_id=trade.trade_id,
            expires_at=trade.expires_at,
        )

    _assert_account_matches(left_account, trade, trade.left.owner)
    _assert_account_matches(right_account, trade, trade.right.owner)

    # 1. Both sides must be able to pay what they offered.
    _assert_can_pay(left_account, trade.left.amount, engine)
    _assert_can_pay(right_account, trade.right.amount, engine)

    # 2. Both sides must hold, and be allowed to hand over, their items.
    _assert_can_hand_over(left_inventory, trade.left, items)
    _assert_can_hand_over(right_inventory, trade.right, items)

    # 3. Move the items. Each side loses its own and gains the other's.
    left_change = _apply_side(left_inventory, trade.left.items, trade.right.items, items)
    right_change = _apply_side(right_inventory, trade.right.items, trade.left.items, items)

    # 4. Net the currency into one movement.
    net = trade.left.amount - trade.right.amount
    booking: BookingResult | None = None
    if net != 0:
        payer = left_account if net > 0 else right_account
        payee = right_account if net > 0 else left_account
        amount = abs(net)
        posting = create_posting(
            operation_id=operation_id,
            kind=PostingKind.TRADE,
            scope=trade.scope,
            currency=trade.currency,
            amount=amount,
            reason=reason,
            occurred_at=now,
            lines=[
                PostingLine(
                    account=payer.ref,
                    delta=-amount,
                    balance_before=payer.balance,
                    balance_after=payer.balance - amount,
                ),
                PostingLine(
                    account=payee.ref,
                    delta=amount,
                    balance_before=payee.balance,
                    balance_after=payee.balance + amount,
                ),
            ],
            metadata={**dict(metadata or {}), "tradeId": trade.trade_id},
        )
        booking = BookingResult(posting=posting, balances=resulting_balances(posting))

    return TradeSettlement(
        trade=replace(trade, state=TradeState.COMPLETED, settled_at=now),
        booking=booking,
        left_inventory=left_change,
        right_inventory=right_change,
    )


def _apply_side(
    inventory: Inventory,
    gives: Sequence[InventorySlot],
    receives: Sequence[InventorySlot],
    items: Mapping[str, Item],
) -> InventoryChange:
    current = inventory
    deltas: list[InventoryDelta] = []
    for slot in gives:
        step = remove_item(current, slot.item_id, slot.quantity)
        current = step.inventory
        deltas.extend(step.deltas)
    for slot in receives:
        item = items.get(slot.item_id)
        if item is None:  # pragma: no cover - narrowing, not a reachable path
            # Both sides were checked against ``items`` before either was
            # applied, so by here every id is present. The lookup stays because
            # it is what turns ``Item | None`` into ``Item``, and a check that
            # cannot fire is cheaper than a cast that hides a future mistake.
            raise ItemError(
                "The trade references an item that was not supplied",
                item_id=slot.item_id,
            )
        step = add_item(current, item, slot.quantity)
        current = step.inventory
        deltas.extend(step.deltas)
    return InventoryChange(inventory=current, deltas=tuple(deltas))


def _assert_can_pay(account: Account, amount: int, engine: EconomyEngine) -> None:
    if amount == 0:
        return
    if not engine.config.allow_negative and account.balance < amount:
        raise InsufficientFundsError(
            account=account_key(account.ref),
            balance=account.balance,
            required=amount,
            currency=account.ref.currency,
        )


def _assert_can_hand_over(
    inventory: Inventory, side: TradeSide, items: Mapping[str, Item]
) -> None:
    for slot in side.items:
        item = items.get(slot.item_id)
        if item is None:
            raise ItemError(
                "The trade references an item that was not supplied",
                item_id=slot.item_id,
            )
        if not item.tradable:
            raise ItemError("This item cannot be traded", item_id=slot.item_id)
        if inventory.quantity_of(slot.item_id) < slot.quantity:
            raise ItemError(
                "A party does not hold what they offered",
                owner=side.owner,
                item_id=slot.item_id,
                held=inventory.quantity_of(slot.item_id),
                offered=slot.quantity,
            )


def _assert_account_matches(account: Account, trade: Trade, owner: str) -> None:
    if account.ref.owner != owner:
        raise ValidationError(
            "The supplied account does not belong to this party",
            expected=owner,
            received=account.ref.owner,
        )
    if account.ref.scope != trade.scope:
        raise ValidationError(
            "The supplied account is in a different scope",
            expected=trade.scope,
            received=account.ref.scope,
        )
    if account.ref.currency != trade.currency:
        raise ValidationError(
            "The supplied account holds a different currency",
            expected=trade.currency,
            received=account.ref.currency,
        )


def _assert_open(trade: Trade, now: int, action: str) -> None:
    if is_final(trade):
        raise TradeStateError(
            f"Cannot {action} a trade that is already {trade.state.value.lower()}",
            trade_id=trade.trade_id,
            state=trade.state.value,
        )
    if now >= trade.expires_at:
        raise TradeStateError(
            f"Cannot {action} an expired trade",
            trade_id=trade.trade_id,
            expires_at=trade.expires_at,
            now=now,
        )


def _assert_party(trade: Trade, owner: str) -> None:
    if owner not in (trade.left.owner, trade.right.owner):
        raise ValidationError(
            "This member is not part of the trade", trade_id=trade.trade_id, owner=owner
        )


def _assert_side(side: TradeSide, name: str) -> None:
    if not isinstance(side.owner, str) or not side.owner:
        raise ValidationError(f"The {name} side needs an owner")
    if not isinstance(side.amount, int) or isinstance(side.amount, bool) or side.amount < 0:
        raise ValidationError(
            f"The {name} side amount must be a non-negative integer", amount=side.amount
        )
    seen: set[str] = set()
    for slot in side.items:
        if (
            not isinstance(slot.quantity, int)
            or isinstance(slot.quantity, bool)
            or slot.quantity < 1
        ):
            raise ValidationError(
                f"The {name} side offers an invalid quantity",
                item_id=slot.item_id,
                quantity=slot.quantity,
            )
        if slot.item_id in seen:
            raise ValidationError(
                f"The {name} side lists the same item twice", item_id=slot.item_id
            )
        seen.add(slot.item_id)


def _is_empty_side(side: TradeSide) -> bool:
    return side.amount == 0 and not side.items
