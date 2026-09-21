"""How a Discord bot wires EconomyWorld in -- and where the transaction goes.

This file is deliberately *not* a working bot: it shows the seam, and above all
it shows the one obligation this package cannot take off your hands.

**Every posting must be written in a single database transaction.** The
``_Transaction`` class below stands in for that. Look at how ``_commit`` applies
every line at once and rolls the whole thing back on any failure -- that shape,
not the details, is what your repository has to do.

    python examples/discord_bot_integration.py
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any

from economyworld import (
    EarnOutcome,
    EarnState,
    EconomyEngine,
    InsufficientFundsError,
    Inventory,
    Item,
    Posting,
    account_key,
    create_currency,
    create_earn_rule,
    create_item,
    create_offer,
    deserialize_earn_state,
    is_balanced,
    make_account,
    member_account,
    purchase,
    serialize_earn_state,
    serialize_posting,
)

SCOPE_CURRENCY = "COIN"


# ---------------------------------------------------------------------------
# The bot's own storage. EconomyWorld never touches this.
# ---------------------------------------------------------------------------


@dataclass
class _Row:
    balance: int = 0
    earn_state: str = "{}"
    inventory: str = "[]"


class Store:
    """Stand-in for your database.

    A real schema would be roughly:

        CREATE TABLE accounts (
            scope    TEXT   NOT NULL,
            owner    TEXT   NOT NULL,
            currency TEXT   NOT NULL,
            balance  BIGINT NOT NULL,
            PRIMARY KEY (scope, owner, currency)
        );

        CREATE TABLE postings (
            operation_id TEXT PRIMARY KEY,   -- <<< the idempotency guarantee
            payload      JSONB NOT NULL,
            occurred_at  BIGINT NOT NULL
        );

    That ``PRIMARY KEY`` on ``operation_id`` is not decoration. It is the only
    thing standing between a retried request and a double booking, and it has to
    be inside the same transaction as the balance updates.
    """

    def __init__(self) -> None:
        self._rows: dict[str, _Row] = {}
        self._postings: dict[str, dict[str, Any]] = {}

    # -- reads ------------------------------------------------------------

    def balance(self, key: str) -> int:
        return self._rows.get(key, _Row()).balance

    def account(self, scope: str, owner: str) -> Any:
        ref = member_account(scope, owner, SCOPE_CURRENCY)
        return make_account(ref, self.balance(account_key(ref)))

    def earn_state(self, key: str) -> EarnState:
        return deserialize_earn_state(json.loads(self._rows.get(key, _Row()).earn_state))

    def inventory(self, key: str) -> Inventory:
        return Inventory.from_list(json.loads(self._rows.get(key, _Row()).inventory))

    def has_booked(self, operation_id: str) -> bool:
        return operation_id in self._postings

    # -- the transaction --------------------------------------------------

    def transaction(self) -> Transaction:
        return Transaction(self)

    def _row(self, key: str) -> _Row:
        return self._rows.setdefault(key, _Row())


@dataclass
class Transaction:
    """What "one database transaction" means, in miniature.

    Nothing is visible in the store until :meth:`commit`, and a failure part way
    through leaves the store exactly as it was. That is the whole point: a
    posting is indivisible, and half of one is how currency appears from nowhere.
    """

    store: Store
    _balances: dict[str, int] = field(default_factory=dict)
    _earn_states: dict[str, str] = field(default_factory=dict)
    _inventories: dict[str, str] = field(default_factory=dict)
    _postings: dict[str, dict[str, Any]] = field(default_factory=dict)

    def write_posting(self, posting: Posting) -> None:
        """Stage every line of a posting, plus the posting itself."""
        # Belt and braces: the library already guarantees this, but an assertion
        # at the storage boundary costs nothing and catches hand-built postings.
        assert is_balanced(posting), "refusing to write an unbalanced posting"

        if (
            self.store.has_booked(posting.operation_id)
            or posting.operation_id in self._postings
        ):
            # In a real database this is the UNIQUE violation, not an if.
            raise RuntimeError(f"operation {posting.operation_id} already booked")

        for line in posting.lines:
            self._balances[account_key(line.account)] = line.balance_after
        self._postings[posting.operation_id] = serialize_posting(posting)

    def write_earn_state(self, key: str, state: EarnState) -> None:
        self._earn_states[key] = json.dumps(serialize_earn_state(state))

    def write_inventory(self, key: str, inventory: Inventory) -> None:
        self._inventories[key] = json.dumps(inventory.to_list())

    def commit(self) -> None:
        """Apply everything at once."""
        for key, balance in self._balances.items():
            self.store._row(key).balance = balance
        for key, state in self._earn_states.items():
            self.store._row(key).earn_state = state
        for key, inventory in self._inventories.items():
            self.store._row(key).inventory = inventory
        self.store._postings.update(self._postings)

    def __enter__(self) -> Transaction:
        return self

    def __exit__(self, exc_type: Any, *_: Any) -> bool:
        if exc_type is None:
            self.commit()
        # On an exception nothing is committed -- the rollback is simply that
        # the staged changes are dropped.
        return False


# ---------------------------------------------------------------------------
# The bot
# ---------------------------------------------------------------------------


class EconomyBot:
    def __init__(self, store: Store) -> None:
        self.store = store
        self.engine = EconomyEngine(
            currencies=[create_currency(SCOPE_CURRENCY, name="Coin", max_balance=10_000_000)],
            earn_rules=[
                create_earn_rule(
                    "message", 5, SCOPE_CURRENCY, cooldown_seconds=60, period_cap_amount=200
                ),
                create_earn_rule("daily", 250, SCOPE_CURRENCY, cooldown_seconds=86400),
                create_earn_rule("voice_minute", 2, SCOPE_CURRENCY, period_cap_amount=300),
            ],
        )
        self.items: dict[str, Item] = {
            "potion": create_item("potion", name="Potion", max_stack=10),
            "badge": create_item("badge", name="Supporter Badge", tradable=False),
        }
        self.offers = {
            "potion": create_offer(
                offer_id="offer-potion",
                item_id="potion",
                unit_price=50,
                currency=SCOPE_CURRENCY,
                stock=100,
            ),
        }

    # -- the message handler ----------------------------------------------

    def on_message(self, guild_id: str, member_id: str, message_id: str) -> str:
        """What ``@bot.event async def on_message(message)`` would call.

        Note the operation id: it is derived from the *message*, so a retried
        handler produces the same id and the unique constraint catches it. An
        id from ``uuid4()`` would defeat the whole mechanism.
        """
        key = account_key(member_account(guild_id, member_id, SCOPE_CURRENCY))
        state = self.store.earn_state(key)

        result = self.engine.earn(
            self.store.account(guild_id, member_id),
            "message",
            state,
            now=int(time.time() * 1000),
            operation_id=f"msg:{message_id}",
            reason="chat activity",
        )

        if result.outcome is not EarnOutcome.EARNED:
            # Cooldown and daily ceiling are the common case. Nothing to write,
            # which is most of the database load saved.
            return f"{result.outcome.value} (nothing booked)"

        assert result.posting is not None
        with self.store.transaction() as tx:
            tx.write_posting(result.posting)
            tx.write_earn_state(key, result.state)

        return f"+{result.amount} -> {result.new_balance}"

    # -- /pay ---------------------------------------------------------------

    def on_pay_command(
        self, guild_id: str, sender: str, recipient: str, amount: int, interaction_id: str
    ) -> str:
        try:
            result = self.engine.transfer(
                self.store.account(guild_id, sender),
                self.store.account(guild_id, recipient),
                amount,
                now=int(time.time() * 1000),
                operation_id=f"pay:{interaction_id}",
                reason=f"/pay from {sender} to {recipient}",
            )
        except InsufficientFundsError as error:
            # The exception carries the numbers, so the bot can say something
            # useful rather than "an error occurred".
            return f"You are {error.shortfall} short."

        with self.store.transaction() as tx:
            tx.write_posting(result.posting)

        return (
            f"Sent {amount}. "
            f"{sender}: {result.balances[account_key(member_account(guild_id, sender, SCOPE_CURRENCY))]}, "
            f"{recipient}: {result.balances[account_key(member_account(guild_id, recipient, SCOPE_CURRENCY))]}"
        )

    # -- /buy ---------------------------------------------------------------

    def on_buy_command(
        self, guild_id: str, member_id: str, offer_key: str, quantity: int, interaction_id: str
    ) -> str:
        offer = self.offers[offer_key]
        item = self.items[offer.item_id]
        key = account_key(member_account(guild_id, member_id, SCOPE_CURRENCY))

        result = purchase(
            self.engine,
            offer=offer,
            item=item,
            buyer=self.store.account(guild_id, member_id),
            inventory=self.store.inventory(key),
            quantity=quantity,
            now=int(time.time() * 1000),
            operation_id=f"buy:{interaction_id}",
            reason=f"bought {quantity}x {item.name}",
        )

        # Three things changed. All three go in one transaction: money, items
        # and stock. A purchase where the money left but the item never arrived
        # is the complaint you spend the rest of the week answering.
        with self.store.transaction() as tx:
            tx.write_posting(result.booking.posting)
            tx.write_inventory(key, result.inventory.inventory)
            self.offers[offer_key] = result.offer

        return (
            f"Bought {result.quantity}x {item.name} for {result.total_price}. "
            f"Balance: {result.booking.balances[key]}"
        )

    # -- /balance -----------------------------------------------------------

    def on_balance_command(self, guild_id: str, member_id: str) -> str:
        key = account_key(member_account(guild_id, member_id, SCOPE_CURRENCY))
        inventory = self.store.inventory(key)
        items = ", ".join(
            f"{slot.quantity}x {self.items[slot.item_id].name}"
            for slot in inventory.slots
            if slot.item_id in self.items
        )
        return f"{self.store.balance(key)} coins" + (f" -- {items}" if items else "")


def main() -> None:
    store = Store()
    bot = EconomyBot(store)
    guild = "guild-1"

    print("ana chats a few times")
    for index in range(3):
        print(f"   msg {index}: {bot.on_message(guild, 'ana', f'm{index}')}")
    print("   (the second and third are inside the cooldown, so nothing is written)")

    # Give ana a working balance without waiting an hour for cooldowns.
    # Note that the account is *loaded*, not invented: crediting an
    # empty_account() would overwrite the 5 coins she just earned, because the
    # posting would say "balance before: 0".
    credit = bot.engine.credit(
        store.account(guild, "ana"),
        1000,
        now=int(time.time() * 1000),
        operation_id="seed:ana",
        reason="seed for the example",
    )
    with store.transaction() as tx:
        tx.write_posting(credit.posting)

    print(f"\n/balance ana -> {bot.on_balance_command(guild, 'ana')}")

    print("\n/pay ana -> ben 300")
    print(f"   {bot.on_pay_command(guild, 'ana', 'ben', 300, 'i1')}")

    print("\n/pay ana -> ben 99999 (she cannot afford it)")
    print(f"   {bot.on_pay_command(guild, 'ana', 'ben', 99_999, 'i2')}")

    print("\n/buy ana 2 potions")
    print(f"   {bot.on_buy_command(guild, 'ana', 'potion', 2, 'i3')}")

    print(f"\n/balance ana -> {bot.on_balance_command(guild, 'ana')}")

    print("\nThe same /pay interaction arriving twice")
    print(f"   first:  {bot.on_pay_command(guild, 'ana', 'ben', 10, 'i4')}")
    try:
        bot.on_pay_command(guild, "ana", "ben", 10, "i4")
    except RuntimeError as error:
        print(f"   retry:  refused -- {error}")


if __name__ == "__main__":
    main()
