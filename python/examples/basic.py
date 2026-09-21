"""Everything a caller needs, in one runnable file.

python examples/basic.py
"""

from __future__ import annotations

import json

from economyworld import (
    DecayRule,
    EconomyEngine,
    InMemoryOperationLog,
    Inventory,
    InventorySlot,
    TradeSide,
    accept_trade,
    create_currency,
    create_earn_rule,
    create_earn_state,
    create_item,
    create_offer,
    empty_account,
    is_balanced,
    make_account,
    max_purchasable,
    member_account,
    propose_trade,
    purchase,
    serialize_posting,
    settle_trade,
    split_minor_units,
)

SCOPE = "guild-1"
COIN = "COIN"
NOW = 1_700_000_000_000
DAY_MS = 86_400_000


def main() -> None:
    # ---------------------------------------------------------------- setup
    coin = create_currency("COIN", name="Coin", symbol="c", max_balance=1_000_000)
    engine = EconomyEngine(
        currencies=[coin],
        earn_rules=[
            create_earn_rule("message", 5, COIN, cooldown_seconds=60, period_cap_amount=200),
            create_earn_rule("daily", 250, COIN, cooldown_seconds=86400),
        ],
    )

    ana = member_account(SCOPE, "ana", COIN)
    ben = member_account(SCOPE, "ben", COIN)

    # -------------------------------------------- 1. currency into existence
    print("1. The server gives ana a welcome gift")
    credit = engine.credit(
        empty_account(ana), 500, now=NOW, operation_id="op-1", reason="welcome gift"
    )
    print(f"   ana: {credit.balances['guild-1/ana/COIN']}")
    print(f"   mint: {credit.balances['guild-1/system:mint/COIN']}  <- what has been issued")
    print(f"   posting balances: {is_balanced(credit.posting)}")

    # ------------------------------------------------------- 2. earning
    print("\n2. ana earns for chatting, then hits her cooldown")
    state = create_earn_state()
    first = engine.earn(
        make_account(ana, 500),
        "message",
        state,
        now=NOW,
        operation_id="op-2",
        reason="message",
    )
    print(f"   {first.outcome.value}: +{first.amount} -> {first.new_balance}")
    blocked = engine.earn(
        make_account(ana, first.new_balance),
        "message",
        first.state,
        now=NOW + 10_000,
        operation_id="op-3",
        reason="message",
    )
    print(
        f"   {blocked.outcome.value}: "
        f"{blocked.cooldown_remaining_ms // 1000}s to go, nothing booked"
    )

    # ------------------------------------------------------- 3. a transfer
    print("\n3. ana sends ben 200")
    transfer = engine.transfer(
        make_account(ana, 505),
        make_account(ben, 0),
        200,
        now=NOW,
        operation_id="op-4",
        reason="gift to ben",
    )
    print(
        f"   ana: {transfer.balances['guild-1/ana/COIN']}, ben: {transfer.balances['guild-1/ben/COIN']}"
    )
    print("   ^ these two updates MUST be written in one database transaction")

    # ----------------------------------------------------- 4. the shop
    print("\n4. ben buys two potions")
    potion = create_item("potion", name="Potion", max_stack=10)
    offer = create_offer(
        offer_id="offer-potion",
        item_id="potion",
        unit_price=50,
        currency=COIN,
        stock=10,
        per_member_limit=5,
    )
    print(f"   ben could afford {max_purchasable(offer, 200, 0, NOW)} at most")
    bought = purchase(
        engine,
        offer=offer,
        item=potion,
        buyer=make_account(ben, 200),
        inventory=Inventory(),
        quantity=2,
        now=NOW,
        operation_id="op-5",
        reason="shop purchase",
    )
    print(
        f"   paid {bought.total_price}, ben now has {bought.booking.balances['guild-1/ben/COIN']}"
    )
    print(f"   inventory: {bought.inventory.inventory.to_list()}")
    print(f"   stock left: {bought.offer.stock}")

    # ----------------------------------------------------- 5. a trade
    print("\n5. ana and ben trade: 100 coins for one potion")
    trade = propose_trade(
        trade_id="trade-1",
        scope=SCOPE,
        currency=COIN,
        left=TradeSide("ana", 100),
        right=TradeSide("ben", 0, (InventorySlot("potion", 1),)),
        now=NOW,
    )
    print(f"   proposed, expires in {(trade.expires_at - NOW) // 1000}s")
    trade = accept_trade(accept_trade(trade, "ana", NOW), "ben", NOW)
    print(f"   both accepted -> {trade.state.value}")

    settled = settle_trade(
        engine,
        trade=trade,
        left_account=make_account(ana, 305),
        right_account=make_account(ben, 100),
        left_inventory=Inventory(),
        right_inventory=Inventory([InventorySlot("potion", 2)]),
        items={"potion": potion},
        now=NOW + 1000,
        operation_id="op-6",
        reason="trade settlement",
    )
    assert settled.booking is not None
    print(
        f"   settled: ana {settled.booking.balances['guild-1/ana/COIN']}, ben {settled.booking.balances['guild-1/ben/COIN']}"
    )
    print(f"   ana's items: {settled.left_inventory.inventory.to_list()}")
    print(f"   ben's items: {settled.right_inventory.inventory.to_list()}")

    # ----------------------------------------------------- 6. a reversal
    print("\n6. Moderation undoes the gift from step 3")
    reversal = engine.reverse(
        transfer.posting,
        {"guild-1/ana/COIN": 205, "guild-1/ben/COIN": 200},
        now=NOW + 2000,
        operation_id="op-7",
        reason="gift reversed by moderation",
    )
    print(
        f"   ana: {reversal.balances['guild-1/ana/COIN']}, ben: {reversal.balances['guild-1/ben/COIN']}"
    )
    print(f"   reverses: {reversal.posting.reverses}")

    # -------------------------------------------------------- 7. decay
    print("\n7. A balance nobody touched for two months shrinks")
    decayed = engine.apply_decay(
        make_account(ana, 10_000),
        DecayRule(
            amount_per_period=0,
            permille_per_period=10,
            period_seconds=86400,
            floor=1000,
            grace_seconds=30 * 86400,
        ),
        now=NOW + 60 * DAY_MS,
        operation_id="op-8",
        reason="monthly demurrage",
        last_activity_at=NOW,
    )
    print(
        f"   {decayed.previous_balance} -> {decayed.new_balance} over {decayed.periods} periods"
    )

    # ------------------------------------------------ 8. idempotency
    print("\n8. The same request arriving twice")
    log = InMemoryOperationLog()
    print(f"   first time:  new? {log.record('op-1')}")
    print(
        f"   retry:       new? {log.record('op-1')}   <- your UNIQUE constraint does this for real"
    )

    # ----------------------------------------------- 9. minor units
    print("\n9. A currency with decimals")
    gold = create_currency("GLD", name="Gold", minor_units=2)
    parts = split_minor_units(-123_456, gold)
    print(
        f"   -123456 stored = {'-' if parts.negative else ''}{parts.whole}.{parts.fraction:02d} {gold.symbol}"
    )

    # ------------------------------------------- 10. what you store
    print("\n10. What goes into your database")
    print(
        "   "
        + json.dumps(serialize_posting(transfer.posting), indent=2).replace("\n", "\n   ")
    )


if __name__ == "__main__":
    main()
