"""Property runs over many random booking sequences.

The concept is explicit that example-based tests are not enough for an economy:
it asks for runs over very many random booking sequences that prove the sum of
all balances does not move when currency is only ever transferred.

These are those runs. They find the class of bug nobody would have written an
example for -- the one where a rounding step, a clamp or an early return quietly
creates or destroys a coin.

The generator is a seeded xorshift rather than :mod:`random`, so a failure is
reproducible from the seed printed in the assertion, and identical to the
sequence the TypeScript edition runs.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TypeVar

from economyworld import (
    Account,
    DecayRule,
    EarnOutcome,
    EconomyEngine,
    EconomyError,
    Inventory,
    InventorySlot,
    Posting,
    SystemAccount,
    TradeSide,
    accept_trade,
    account_key,
    add_item,
    create_currency,
    create_earn_rule,
    create_earn_state,
    create_item,
    create_offer,
    is_balanced,
    make_account,
    member_account,
    propose_trade,
    purchase,
    remove_item,
    settle_trade,
    system_account,
)

SCOPE = "guild-1"
COIN = "COIN"
NOW = 1_700_000_000_000
UINT32 = 0xFFFFFFFF

T = TypeVar("T")


class Rng:
    """Small deterministic PRNG. Test-only; the library contains no randomness."""

    def __init__(self, seed: int) -> None:
        self.seed = seed
        self._state = 0x9E3779B9 if seed == 0 else seed & UINT32

    def next(self) -> int:
        x = self._state
        x = (x ^ (x << 13)) & UINT32
        x ^= x >> 17
        x = (x ^ (x << 5)) & UINT32
        self._state = x
        return x

    def int(self, minimum: int, maximum: int) -> int:
        return minimum + (self.next() % (maximum - minimum + 1))

    def pick(self, values: Sequence[T]) -> T:
        return values[self.next() % len(values)]


class World:
    """The caller's world: balances the engine never sees between calls."""

    def __init__(self, members: Sequence[str], starting_balance: int) -> None:
        self.members = tuple(members)
        self.balances: dict[str, int] = {
            account_key(member_account(SCOPE, member, COIN)): starting_balance
            for member in members
        }

    def account(self, member: str) -> Account:
        ref = member_account(SCOPE, member, COIN)
        return make_account(ref, self.balances.get(account_key(ref), 0))

    def system(self, kind: SystemAccount) -> Account:
        """A system account with its current balance.

        A caller that stores system accounts has to load and pass them, or the
        engine fills in a zero and the stored system balance goes wrong. This
        suite stores them, precisely so it can assert that the books close.
        """
        ref = system_account(SCOPE, COIN, kind)
        return make_account(ref, self.balances.get(account_key(ref), 0))

    def apply(self, posting: Posting) -> None:
        """Apply a posting the way a caller must: every line, all at once."""
        assert is_balanced(posting)
        for line in posting.lines:
            key = account_key(line.account)
            current = self.balances.get(key, 0)
            assert current == line.balance_before, (
                f"stale read on {key}: world has {current}, "
                f"posting expected {line.balance_before}"
            )
            self.balances[key] = line.balance_after

    def member_total(self) -> int:
        return sum(
            self.balances.get(account_key(member_account(SCOPE, member, COIN)), 0)
            for member in self.members
        )

    def grand_total(self) -> int:
        return sum(self.balances.values())


MEMBERS = ("ana", "ben", "cai", "dee", "eli")


def engine() -> EconomyEngine:
    return EconomyEngine(
        currencies=[create_currency(COIN, max_balance=100_000_000)],
        earn_rules=[
            create_earn_rule("message", 10, COIN, cooldown_seconds=60, period_cap_amount=100)
        ],
    )


def test_transfers_never_change_the_money_supply() -> None:
    for seed in range(1, 201):
        rng = Rng(seed)
        world = World(MEMBERS, 10_000)
        economy = engine()
        before = world.member_total()
        grand_before = world.grand_total()

        for step in range(40):
            source_member = rng.pick(MEMBERS)
            target_member = rng.pick(MEMBERS)
            if source_member == target_member:
                continue
            source = world.account(source_member)
            amount = rng.int(1, 3_000)
            if source.balance < amount:
                continue  # the caller would show "not enough"
            result = economy.transfer(
                source,
                world.account(target_member),
                amount,
                now=NOW + step * 1000,
                operation_id=f"s{seed}-{step}",
                reason="random transfer",
            )
            world.apply(result.posting)

        assert world.member_total() == before, f"seed {seed}"
        # Nothing entered or left the economy, so the books do not move at all.
        assert world.grand_total() == grand_before, f"seed {seed}"


def test_every_posting_balances_whatever_produced_it() -> None:
    for seed in range(1, 201):
        rng = Rng(seed)
        world = World(MEMBERS, 5_000)
        economy = engine()
        earn_states: dict[str, object] = {}
        postings: list[Posting] = []
        grand_before = world.grand_total()

        for step in range(50):
            now = NOW + step * 120_000
            operation_id = f"m{seed}-{step}"
            member = rng.pick(MEMBERS)
            action = rng.int(0, 4)

            try:
                if action == 0:
                    result = economy.credit(
                        world.account(member),
                        rng.int(1, 500),
                        now=now,
                        operation_id=operation_id,
                        reason="random credit",
                        source=world.system(SystemAccount.MINT),
                    )
                    world.apply(result.posting)
                    postings.append(result.posting)
                elif action == 1:
                    result = economy.debit(
                        world.account(member),
                        rng.int(1, 500),
                        now=now,
                        operation_id=operation_id,
                        reason="random debit",
                        target=world.system(SystemAccount.SINK),
                    )
                    world.apply(result.posting)
                    postings.append(result.posting)
                elif action == 2:
                    other = rng.pick(MEMBERS)
                    if other == member:
                        continue
                    result = economy.transfer(
                        world.account(member),
                        world.account(other),
                        rng.int(1, 500),
                        now=now,
                        operation_id=operation_id,
                        reason="random transfer",
                    )
                    world.apply(result.posting)
                    postings.append(result.posting)
                elif action == 3:
                    state = earn_states.get(member) or create_earn_state()
                    earned = economy.earn(
                        world.account(member),
                        "message",
                        state,  # type: ignore[arg-type]
                        now=now,
                        operation_id=operation_id,
                        reason="random earn",
                        source=world.system(SystemAccount.MINT),
                    )
                    earn_states[member] = earned.state
                    if earned.outcome is EarnOutcome.EARNED and earned.posting:
                        world.apply(earned.posting)
                        postings.append(earned.posting)
                else:
                    decayed = economy.apply_decay(
                        world.account(member),
                        DecayRule(
                            amount_per_period=rng.int(1, 20),
                            permille_per_period=rng.int(0, 50),
                            period_seconds=3600,
                            floor=0,
                            grace_seconds=0,
                        ),
                        now=now,
                        operation_id=operation_id,
                        reason="random decay",
                        last_activity_at=NOW,
                        last_applied_at=NOW + (step - 1) * 120_000,
                        sink=world.system(SystemAccount.SINK),
                    )
                    if decayed.posting is not None:
                        world.apply(decayed.posting)
                        postings.append(decayed.posting)
            except EconomyError:
                # Insufficient funds and overflow are legitimate refusals; the
                # point of this run is that nothing that *did* book broke the
                # invariant. An AssertionError from World.apply is deliberately
                # NOT caught here -- that would hide the bug these runs exist
                # to find.
                continue

        for posting in postings:
            assert is_balanced(posting), f"seed {seed}, {posting.operation_id}"
        # Even with money entering and leaving, the books close: every coin the
        # mint issued is somewhere, and every coin destroyed sits in the sink,
        # so the sum across all accounts never moves.
        assert world.grand_total() == grand_before, f"seed {seed}"


def test_a_settled_trade_moves_value_without_creating_it() -> None:
    sword = create_item("sword", stackable=False)
    potion = create_item("potion", max_stack=100)
    items = {"sword": sword, "potion": potion}

    for seed in range(1, 201):
        rng = Rng(seed)
        economy = engine()

        left_balance = rng.int(0, 5_000)
        right_balance = rng.int(0, 5_000)
        left_amount = rng.int(0, left_balance)
        right_amount = rng.int(0, right_balance)
        left_potions = rng.int(0, 10)
        right_potions = rng.int(0, 10)
        left_offers = rng.int(0, left_potions)
        right_offers = rng.int(0, right_potions)

        if left_amount == 0 and right_amount == 0 and left_offers == 0 and right_offers == 0:
            continue  # not a trade

        proposed = propose_trade(
            trade_id=f"t{seed}",
            scope=SCOPE,
            currency=COIN,
            left=TradeSide(
                "ana",
                left_amount,
                (InventorySlot("potion", left_offers),) if left_offers else (),
            ),
            right=TradeSide(
                "ben",
                right_amount,
                (InventorySlot("potion", right_offers),) if right_offers else (),
            ),
            now=NOW,
        )

        settled = settle_trade(
            economy,
            trade=accept_trade(accept_trade(proposed, "ana", NOW), "ben", NOW),
            left_account=make_account(member_account(SCOPE, "ana", COIN), left_balance),
            right_account=make_account(member_account(SCOPE, "ben", COIN), right_balance),
            left_inventory=Inventory([InventorySlot("potion", left_potions)]),
            right_inventory=Inventory([InventorySlot("potion", right_potions)]),
            items=items,
            now=NOW + 1000,
            operation_id=f"t{seed}-settle",
            reason="random trade",
        )

        # Currency is conserved.
        if settled.booking is None:
            balances_after = left_balance + right_balance
        else:
            balances_after = (
                settled.booking.balances[f"{SCOPE}/ana/{COIN}"]
                + settled.booking.balances[f"{SCOPE}/ben/{COIN}"]
            )
        assert balances_after == left_balance + right_balance, f"seed {seed}"

        # Items are conserved.
        potions_after = settled.left_inventory.inventory.quantity_of(
            "potion"
        ) + settled.right_inventory.inventory.quantity_of("potion")
        assert potions_after == left_potions + right_potions, f"seed {seed}"

        if settled.booking is not None:
            assert is_balanced(settled.booking.posting)


def test_a_purchase_moves_exactly_the_price() -> None:
    potion = create_item("potion", max_stack=1000)

    for seed in range(1, 201):
        rng = Rng(seed)
        unit_price = rng.int(0, 500)
        quantity = rng.int(1, 20)
        balance = rng.int(unit_price * quantity, unit_price * quantity + 5_000)

        result = purchase(
            engine(),
            offer=create_offer(
                offer_id="o",
                item_id="potion",
                unit_price=unit_price,
                currency=COIN,
                stock=1000,
            ),
            item=potion,
            buyer=make_account(member_account(SCOPE, "ana", COIN), balance),
            inventory=Inventory(),
            quantity=quantity,
            now=NOW,
            operation_id=f"p{seed}",
            reason="random purchase",
        )

        assert result.total_price == unit_price * quantity, f"seed {seed}"
        assert (
            result.booking.balances[f"{SCOPE}/ana/{COIN}"] == balance - unit_price * quantity
        )
        assert result.inventory.inventory.quantity_of("potion") == quantity
        assert result.offer.stock == 1000 - quantity
        assert is_balanced(result.booking.posting)


def test_a_reversal_restores_the_exact_balances() -> None:
    for seed in range(1, 201):
        rng = Rng(seed)
        world = World(MEMBERS, rng.int(0, 10_000))
        economy = engine()
        member = rng.pick(MEMBERS)
        other = rng.pick([m for m in MEMBERS if m != member])
        snapshot = dict(world.balances)

        source = world.account(member)
        amount = rng.int(1, max(1, source.balance))
        if source.balance < amount:
            continue

        original = economy.transfer(
            source,
            world.account(other),
            amount,
            now=NOW,
            operation_id=f"r{seed}",
            reason="to be undone",
        )
        world.apply(original.posting)

        reversal = economy.reverse(
            original.posting,
            dict(world.balances),
            now=NOW + 1000,
            operation_id=f"r{seed}-undo",
            reason="undo",
        )
        world.apply(reversal.posting)

        assert world.balances == snapshot, f"seed {seed}"


def test_inventory_operations_conserve_quantity() -> None:
    potion = create_item("potion", max_stack=100_000)

    for seed in range(1, 201):
        rng = Rng(seed)
        held = Inventory()
        expected = 0

        for step in range(30):
            amount = rng.int(1, 50)
            if rng.int(0, 1) == 0:
                held = add_item(held, potion, amount).inventory
                expected += amount
            elif expected >= amount:
                held = remove_item(held, "potion", amount).inventory
                expected -= amount
            # The running count the test keeps and the inventory's own must
            # never disagree, whatever order the operations came in.
            assert held.quantity_of("potion") == expected, f"seed {seed}, step {step}"

        assert held.is_empty == (expected == 0), f"seed {seed}"
