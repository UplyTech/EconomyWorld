"""The contract between the Python and the TypeScript edition.

Both editions run this same set of cases. A difference in either one turns into
a red build here rather than into two communities whose members end up with
different balances for the same activity.

The vectors live in ``../../shared/testcases`` and are generated from the
TypeScript edition by ``typescript/scripts/generate-shared-vectors.mjs``.
Regenerating them is a deliberate act: if a vector changes, the behaviour of the
library changed, and that belongs in the changelog with a version bump. Never
regenerate to make a failing test pass.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from economyworld import (
    AccrualBasis,
    AmortisationMethod,
    BookingResult,
    DecayRule,
    EconomyEngine,
    FeeMode,
    InstrumentKind,
    Inventory,
    InventorySlot,
    LoanState,
    OrderSide,
    Rounding,
    SystemAccount,
    TradeSide,
    accept_trade,
    account_key,
    accrue_deposit_interest,
    accrue_interest,
    add_item,
    amortisation_schedule,
    amount_due,
    apply_permille,
    average_cost,
    buy_units,
    charges_due,
    coupon_due,
    create_currency,
    create_deposit_terms,
    create_earn_rule,
    create_earn_state,
    create_fee_rule,
    create_instrument,
    create_item,
    create_loan_terms,
    create_offer,
    create_order,
    create_plan,
    create_tier,
    deposit,
    distribute_dividend,
    divide_rounded,
    empty_account,
    exchange,
    finance_purchase,
    gini_permille,
    level_payment,
    make_account,
    match_order,
    maturity_value,
    max_purchasable,
    member_account,
    next_charge_at,
    open_deposit,
    open_loan,
    open_position,
    project_balance,
    propose_trade,
    purchase,
    quote_fee,
    remove_item,
    repay,
    sell_units,
    settle_trade,
    split_fee,
    split_minor_units,
    split_payroll,
    start_subscription,
    system_account,
    top_holders,
    value_position,
    wealth_distribution,
)
from economyworld.instruments import Position

VECTOR_DIR = Path(__file__).resolve().parents[2] / "shared" / "testcases"
SUPPORTED_FORMAT_VERSION = 1


SCOPE = "guild-1"
COIN = "COIN"
ANA = member_account(SCOPE, "ana", COIN)
BEN = member_account(SCOPE, "ben", COIN)
POTION = create_item("potion", max_stack=10)
SWORD = create_item("sword", stackable=False)


def load(name: str) -> dict[str, Any]:
    return json.loads((VECTOR_DIR / f"{name}.json").read_text(encoding="utf-8"))


def engine() -> EconomyEngine:
    return EconomyEngine(
        currencies=[create_currency("COIN", max_balance=1_000_000)],
        earn_rules=[
            create_earn_rule("message", 10, COIN, cooldown_seconds=60, period_cap_amount=100),
            create_earn_rule("daily", 250, COIN, cooldown_seconds=86400),
        ],
    )


def test_vector_directory_is_present() -> None:
    assert VECTOR_DIR.is_dir(), f"shared test vectors missing at {VECTOR_DIR}"


# ---------------------------------------------------------------------------
# money
# ---------------------------------------------------------------------------

MONEY = load("money")


def test_money_uses_a_known_format_version() -> None:
    assert MONEY["formatVersion"] == SUPPORTED_FORMAT_VERSION


@pytest.mark.parametrize("case", MONEY["splits"])
def test_minor_unit_split(case: dict[str, Any]) -> None:
    result = split_minor_units(
        case["amount"], create_currency("X", minor_units=case["minorUnits"])
    )
    assert {
        "negative": result.negative,
        "whole": result.whole,
        "fraction": result.fraction,
    } == case["expected"]


@pytest.mark.parametrize("case", MONEY["permilleChains"])
def test_permille_chain(case: dict[str, Any]) -> None:
    assert apply_permille(case["amount"], case["permilles"]) == case["expected"]


# ---------------------------------------------------------------------------
# bookings
# ---------------------------------------------------------------------------

BOOKINGS = load("bookings")
T0 = BOOKINGS["baseTimestampMs"]


def _opts(operation_id: str, now: int = T0) -> dict[str, Any]:
    return {"now": now, "operation_id": operation_id, "reason": "shared vector"}


RUNNERS: dict[str, Callable[[], BookingResult]] = {
    "credit-issues-from-the-mint": lambda: engine().credit(
        empty_account(ANA), 500, **_opts("op-credit")
    ),
    "debit-removes-to-the-sink": lambda: engine().debit(
        make_account(ANA, 500), 200, **_opts("op-debit")
    ),
    "transfer-between-members": lambda: engine().transfer(
        make_account(ANA, 500), make_account(BEN, 20), 300, **_opts("op-transfer")
    ),
    "transfer-of-the-whole-balance": lambda: engine().transfer(
        make_account(ANA, 500), make_account(BEN, 0), 500, **_opts("op-all")
    ),
    "credit-to-an-explicit-source": lambda: engine().credit(
        make_account(ANA, 100),
        200,
        source=make_account(system_account(SCOPE, COIN, SystemAccount.SHOP), 1000),
        **_opts("op-refund"),
    ),
}


@pytest.mark.parametrize("case", BOOKINGS["cases"], ids=lambda c: c["id"])
def test_booking_case(case: dict[str, Any]) -> None:
    runner = RUNNERS.get(case["id"])
    assert runner is not None, f"no runner for {case['id']}"
    result = runner()
    expected = case["expected"]

    assert result.posting.kind.value == expected["kind"]
    assert result.posting.amount == expected["amount"]
    assert [
        {
            "account": account_key(line.account),
            "delta": line.delta,
            "balanceBefore": line.balance_before,
            "balanceAfter": line.balance_after,
        }
        for line in result.posting.lines
    ] == expected["lines"]
    assert dict(result.balances) == expected["balances"]

    # The property the whole design exists for.
    assert sum(line.delta for line in result.posting.lines) == 0


# ---------------------------------------------------------------------------
# earning
# ---------------------------------------------------------------------------

EARNING = load("earning")


@pytest.mark.parametrize("scenario", EARNING["scenarios"], ids=lambda s: s["id"])
def test_earning_scenario(scenario: dict[str, Any]) -> None:
    economy = engine()
    state = create_earn_state()
    balance = scenario["initialBalance"]

    for index, step in enumerate(scenario["steps"]):
        result = economy.earn(
            make_account(ANA, balance),
            scenario["ruleKey"],
            state,
            **_opts(
                f"{scenario['id']}-{index}", EARNING["baseTimestampMs"] + step["offsetMs"]
            ),
        )
        state = result.state
        balance = result.new_balance

        assert {
            "outcome": result.outcome.value,
            "amount": result.amount,
            "grossAmount": result.gross_amount,
            "previousBalance": result.previous_balance,
            "newBalance": result.new_balance,
            "cooldownRemainingMs": result.cooldown_remaining_ms,
            "periodRemaining": result.period_remaining,
            "booked": result.booked,
        } == step["expected"], f"step {index} of {scenario['id']}"

    assert balance == scenario["finalBalance"]


# ---------------------------------------------------------------------------
# decay
# ---------------------------------------------------------------------------

DECAY = load("decay")


@pytest.mark.parametrize("case", DECAY["cases"], ids=lambda c: c["id"])
def test_decay_case(case: dict[str, Any]) -> None:
    rule = DecayRule(
        amount_per_period=case["rule"]["amountPerPeriod"],
        permille_per_period=case["rule"]["permillePerPeriod"],
        period_seconds=case["rule"]["periodSeconds"],
        floor=case["rule"]["floor"],
        grace_seconds=case["rule"]["graceSeconds"],
    )
    result = engine().apply_decay(
        make_account(ANA, case["balance"]),
        rule,
        last_activity_at=case["lastActivityAt"],
        last_applied_at=None,
        **_opts(case["id"], DECAY["baseTimestampMs"] + case["offsetMs"]),
    )
    assert {
        "amount": result.amount,
        "periods": result.periods,
        "previousBalance": result.previous_balance,
        "newBalance": result.new_balance,
        "appliedUpTo": result.applied_up_to,
        "booked": result.booked,
    } == case["expected"]


# ---------------------------------------------------------------------------
# inventory
# ---------------------------------------------------------------------------

INVENTORY = load("inventory")


@pytest.mark.parametrize("sequence", INVENTORY["sequences"], ids=lambda s: s["id"])
def test_inventory_sequence(sequence: dict[str, Any]) -> None:
    inventory = Inventory(
        InventorySlot(item_id=slot["itemId"], quantity=slot["quantity"])
        for slot in sequence["start"]
    )
    for step in sequence["steps"]:
        item = POTION if step["itemId"] == "potion" else SWORD
        change = (
            add_item(inventory, item, step["quantity"])
            if step["op"] == "add"
            else remove_item(inventory, step["itemId"], step["quantity"])
        )
        inventory = change.inventory
        assert [
            {
                "itemId": delta.item_id,
                "delta": delta.delta,
                "quantityBefore": delta.quantity_before,
                "quantityAfter": delta.quantity_after,
            }
            for delta in change.deltas
        ] == step["expected"]["deltas"]
        assert change.inventory.to_list() == step["expected"]["slots"]

    assert inventory.to_list() == sequence["finalSlots"]


# ---------------------------------------------------------------------------
# shop
# ---------------------------------------------------------------------------

SHOP = load("shop")


@pytest.mark.parametrize("case", SHOP["cases"], ids=lambda c: c["id"])
def test_shop_case(case: dict[str, Any]) -> None:
    offer = create_offer(
        offer_id=f"offer-{case['id']}",
        item_id="potion",
        unit_price=case["unitPrice"],
        currency=COIN,
        stock=case["stock"],
    )
    result = purchase(
        engine(),
        offer=offer,
        item=POTION,
        buyer=make_account(ANA, case["balance"]),
        inventory=Inventory(),
        quantity=case["quantity"],
        **_opts(f"shop-{case['id']}", SHOP["baseTimestampMs"]),
    )

    assert {
        "totalPrice": result.total_price,
        "quantity": result.quantity,
        "balances": dict(result.booking.balances),
        "remainingStock": result.offer.stock,
        "slots": result.inventory.inventory.to_list(),
        "maxPurchasable": max_purchasable(offer, case["balance"], 0, SHOP["baseTimestampMs"]),
    } == case["expected"]


# ---------------------------------------------------------------------------
# trade
# ---------------------------------------------------------------------------

TRADE = load("trade")


def _side(raw: dict[str, Any]) -> TradeSide:
    return TradeSide(
        owner=raw["owner"],
        amount=raw["amount"],
        items=tuple(
            InventorySlot(item_id=slot["itemId"], quantity=slot["quantity"])
            for slot in raw["items"]
        ),
    )


def _slots(raw: list[dict[str, Any]]) -> Inventory:
    return Inventory(
        InventorySlot(item_id=slot["itemId"], quantity=slot["quantity"]) for slot in raw
    )


@pytest.mark.parametrize("case", TRADE["cases"], ids=lambda c: c["id"])
def test_trade_case(case: dict[str, Any]) -> None:
    base = TRADE["baseTimestampMs"]
    proposed = propose_trade(
        trade_id=f"trade-{case['id']}",
        scope=SCOPE,
        currency=COIN,
        left=_side(case["left"]),
        right=_side(case["right"]),
        now=base,
    )
    assert proposed.expires_at == case["expiresAt"]

    settled = settle_trade(
        engine(),
        trade=accept_trade(accept_trade(proposed, "ana", base), "ben", base),
        left_account=make_account(ANA, case["leftBalance"]),
        right_account=make_account(BEN, case["rightBalance"]),
        left_inventory=_slots(case["leftSlots"]),
        right_inventory=_slots(case["rightSlots"]),
        items={"potion": POTION, "sword": SWORD},
        **_opts(f"trade-{case['id']}-settle", base + 1000),
    )

    assert {
        "state": settled.trade.state.value,
        "settledAt": settled.trade.settled_at,
        "booked": settled.booking is not None,
        "amount": settled.booking.posting.amount if settled.booking else 0,
        "balances": dict(settled.booking.balances) if settled.booking else None,
        "leftSlots": settled.left_inventory.inventory.to_list(),
        "rightSlots": settled.right_inventory.inventory.to_list(),
    } == case["expected"]


# ---------------------------------------------------------------------------
# The financial subsystems
#
# Everything above is the original engine. What follows is banking, credit,
# investments, markets, fees and billing -- the parts where an amount is
# multiplied by a rate and then divided, which is exactly where two editions
# drift apart if they are ever allowed to.
# ---------------------------------------------------------------------------


ROUNDING = {mode.value: mode for mode in Rounding}
BASIS = {basis.value: basis for basis in AccrualBasis}
METHODS = {method.value: method for method in AmortisationMethod}
SIDES = {side.value: side for side in OrderSide}
MODES = {mode.value: mode for mode in FeeMode}

ROUNDING_VECTORS = load("rounding")


@pytest.mark.parametrize(
    "case",
    ROUNDING_VECTORS["cases"],
    ids=lambda c: f"{c['numerator']}/{c['denominator']}:{c['mode']}",
)
def test_rounding_case(case: dict[str, Any]) -> None:
    assert (
        divide_rounded(case["numerator"], case["denominator"], ROUNDING[case["mode"]])
        == (case["expected"])
    )


INTEREST = load("interest")


@pytest.mark.parametrize("case", INTEREST["accruals"])
def test_accrual_case(case: dict[str, Any]) -> None:
    expected = case["expected"]
    basis = BASIS[case["basis"]]
    rounding = ROUNDING[case["rounding"]]
    assert (
        accrue_interest(
            case["principal"], case["rateBasisPoints"], case["periods"], basis, rounding
        )
        == expected["interest"]
    )
    assert (
        project_balance(
            case["principal"], case["rateBasisPoints"], case["periods"], basis, rounding
        )
        == expected["balance"]
    )


@pytest.mark.parametrize(
    "case",
    INTEREST["schedules"],
    ids=lambda c: f"{c['principal']}@{c['rateBasisPoints']}x{c['periods']}:{c['method']}",
)
def test_schedule_case(case: dict[str, Any]) -> None:
    schedule = amortisation_schedule(
        case["principal"], case["rateBasisPoints"], case["periods"], METHODS[case["method"]]
    )
    expected = case["expected"]
    if expected["levelPayment"] is not None:
        assert (
            level_payment(case["principal"], case["rateBasisPoints"], case["periods"])
            == (expected["levelPayment"])
        )
    assert schedule.total_interest == expected["totalInterest"]
    assert schedule.total_paid == expected["totalPaid"]
    assert [
        {
            "number": row.number,
            "openingBalance": row.opening_balance,
            "interest": row.interest,
            "principal": row.principal,
            "payment": row.payment,
            "closingBalance": row.closing_balance,
        }
        for row in schedule.instalments
    ] == expected["instalments"]


BANKING = load("banking")


@pytest.mark.parametrize(
    "case", BANKING["deposits"], ids=lambda c: f"{c['amount']}@{c['rateBasisPoints']}"
)
def test_banking_case(case: dict[str, Any]) -> None:
    engine = EconomyEngine(currencies=[create_currency(COIN)])
    owner = member_account(SCOPE, "ana", COIN)
    account = open_deposit(
        "d", owner, create_deposit_terms(rate_basis_points=case["rateBasisPoints"]), T0
    )

    steps: list[dict[str, Any]] = []
    booking, account = deposit(
        engine,
        account,
        make_account(owner, 1_000_000),
        case["amount"],
        T0,
        "dep",
        "shared vector",
    )
    steps.append(
        {"kind": "deposit", "amount": booking.posting.amount, "balance": account.balance}
    )
    for index in range(case["periods"]):
        accrued, account = accrue_deposit_interest(
            engine, account, 1, T0, f"acc-{index}", "shared vector"
        )
        steps.append(
            {
                "kind": "interest",
                "amount": 0 if accrued is None else accrued.posting.amount,
                "balance": account.balance,
            }
        )

    expected = case["expected"]
    assert steps == expected["steps"]
    assert account.principal == expected["principal"]
    assert account.accrued_interest == expected["accruedInterest"]
    assert account.balance == expected["balance"]
    assert maturity_value(account, 2) == expected["maturityValue"]


CREDIT = load("credit")


@pytest.mark.parametrize(
    "case",
    CREDIT["loans"],
    ids=lambda c: f"{c['principal']}@{c['rateBasisPoints']}:{c['method']}",
)
def test_credit_case(case: dict[str, Any]) -> None:
    """A whole loan, from disbursement to the credit account reaching zero."""
    engine = EconomyEngine(currencies=[create_currency(COIN)])
    borrower_ref = member_account(SCOPE, "ana", COIN)
    credit_balance = -case["principal"]
    fee_balance = 0

    _, loan = open_loan(
        engine,
        "L",
        create_loan_terms(
            principal=case["principal"],
            rate_basis_points=case["rateBasisPoints"],
            periods=case["periods"],
            method=METHODS[case["method"]],
        ),
        make_account(borrower_ref, 0),
        T0,
        "open",
        "shared vector",
    )

    payments: list[dict[str, Any]] = []
    step = 0
    while loan.state in (LoanState.ACTIVE, LoanState.IN_ARREARS) and step < 60:
        step += 1
        due = amount_due(loan)
        result = repay(
            engine,
            loan,
            make_account(borrower_ref, 100_000_000),
            due,
            T0,
            f"r-{step}",
            "shared vector",
            credit_account=make_account(
                system_account(SCOPE, COIN, SystemAccount.CREDIT), credit_balance
            ),
            fee_account=make_account(
                system_account(SCOPE, COIN, SystemAccount.FEE), fee_balance
            ),
        )
        credit_balance += result.to_principal
        fee_balance += result.to_interest + result.to_fees
        loan = result.loan
        payments.append(
            {
                "amount": due,
                "toFees": result.to_fees,
                "toInterest": result.to_interest,
                "toPrincipal": result.to_principal,
                "instalmentsCleared": result.instalments_cleared,
            }
        )

    expected = case["expected"]
    assert loan.schedule.total_interest == expected["totalInterest"]
    assert loan.schedule.total_paid == expected["totalPaid"]
    assert payments == expected["payments"]
    assert loan.state.value == expected["finalState"]
    assert credit_balance == expected["creditAccount"]
    assert fee_balance == expected["feeAccount"]


FEES = load("fees")


def _rule_from(case: dict[str, Any]):
    rule = case["rule"]
    return create_fee_rule(
        case["key"],
        mode=MODES[rule["mode"]],
        flat=rule["flat"],
        basis_points=rule["basisPoints"],
        tiers=[create_tier(tier["threshold"], tier["basisPoints"]) for tier in rule["tiers"]],
        minimum=rule["minimum"],
        maximum=rule["maximum"],
        rounding=ROUNDING[rule["rounding"]],
    )


@pytest.mark.parametrize("case", FEES["rules"], ids=lambda c: c["key"])
def test_fee_rule_case(case: dict[str, Any]) -> None:
    rule = _rule_from(case)
    for quoted in case["quotes"]:
        quote = quote_fee(rule, quoted["amount"])
        assert {
            "fee": quote.fee,
            "payerPays": quote.payer_pays,
            "recipientReceives": quote.recipient_receives,
        } == quoted["expected"], quoted["amount"]


@pytest.mark.parametrize("case", FEES["splits"])
def test_fee_split_case(case: dict[str, Any]) -> None:
    assert split_fee(case["fee"], case["weights"]) == case["expected"]


INSTRUMENTS = load("instruments")


@pytest.mark.parametrize("case", INSTRUMENTS["trades"])
def test_instrument_trade_case(case: dict[str, Any]) -> None:
    engine = EconomyEngine(currencies=[create_currency(COIN)])
    holder = member_account(SCOPE, "ana", COIN)
    instrument = create_instrument("share", InstrumentKind.SHARE, COIN)
    position = open_position(holder, instrument)

    steps: list[dict[str, Any]] = []
    for index, (units, price) in enumerate(zip(case["units"], case["prices"], strict=True)):
        outcome = buy_units(
            engine,
            instrument,
            position,
            make_account(holder, 100_000_000),
            units,
            price,
            T0,
            f"buy-{index}",
            "shared vector",
        )
        position = outcome.position
        steps.append(
            {
                "kind": "buy",
                "units": units,
                "unitPrice": price,
                "consideration": outcome.consideration,
                "costBasis": position.cost_basis,
            }
        )

    units, price = case["sell"]
    sold = sell_units(
        engine,
        instrument,
        position,
        make_account(holder, 0),
        units,
        price,
        T0,
        "sell",
        "shared vector",
    )
    position = sold.position
    steps.append(
        {
            "kind": "sell",
            "units": units,
            "unitPrice": price,
            "consideration": sold.consideration,
            "realisedGain": sold.realised_gain,
            "costBasis": position.cost_basis,
        }
    )

    expected = case["expected"]
    assert steps == expected["steps"]
    assert position.units == expected["units"]
    assert position.cost_basis == expected["costBasis"]
    assert position.realised_gain == expected["realisedGain"]
    assert average_cost(position) == expected["averageCost"]
    assert value_position(position, 200).unrealised_gain == expected["valuation"]


@pytest.mark.parametrize("case", INSTRUMENTS["coupons"])
def test_coupon_case(case: dict[str, Any]) -> None:
    bond = create_instrument(
        "bond",
        InstrumentKind.BOND,
        COIN,
        face_value=case["faceValue"],
        coupon_basis_points=case["couponBasisPoints"],
    )
    assert coupon_due(bond, case["units"], case["periods"]) == case["expected"]


@pytest.mark.parametrize("case", INSTRUMENTS["dividends"])
def test_dividend_case(case: dict[str, Any]) -> None:
    positions = [
        Position(
            holder=member_account(SCOPE, f"m{index}", COIN),
            instrument_id="s",
            units=units,
            cost_basis=0,
        )
        for index, units in enumerate(case["units"])
    ]
    assert [amount for _, amount in distribute_dividend(positions, case["total"])] == (
        case["expected"]
    )


MARKET = load("market")


@pytest.mark.parametrize("case", MARKET["books"], ids=lambda c: c["id"])
def test_order_book_case(case: dict[str, Any]) -> None:
    def to_order(row: list[Any]):
        order_id, owner, side, price, quantity, offset = row
        return create_order(
            order_id,
            member_account(SCOPE, owner, COIN),
            "ore",
            SIDES[side],
            price,
            quantity,
            T0 + offset,
        )

    result = match_order(to_order(case["incoming"]), [to_order(row) for row in case["book"]])
    expected = case["expected"]
    assert [
        {
            "buyOrderId": fill.buy_order_id,
            "sellOrderId": fill.sell_order_id,
            "quantity": fill.quantity,
            "unitPrice": fill.unit_price,
            "consideration": fill.consideration,
        }
        for fill in result.fills
    ] == expected["fills"]
    assert result.filled_quantity == expected["filledQuantity"]
    assert result.total_consideration == expected["totalConsideration"]
    assert [
        {"orderId": order.order_id, "filled": order.filled, "state": order.state.value}
        for order in result.book
    ] == expected["book"]


@pytest.mark.parametrize("case", MARKET["exchanges"])
def test_exchange_case(case: dict[str, Any]) -> None:
    engine = EconomyEngine(currencies=[create_currency(COIN), create_currency("GEM")])
    _, _, received = exchange(
        engine,
        make_account(member_account(SCOPE, "ana", COIN), 1_000_000),
        make_account(member_account(SCOPE, "ana", "GEM"), 0),
        case["amount"],
        case["numerator"],
        case["denominator"],
        T0,
        "x",
        "shared vector",
        rounding=ROUNDING[case["rounding"]],
    )
    assert received == case["expected"]


BILLING = load("billing")


@pytest.mark.parametrize("case", BILLING["subscriptions"], ids=lambda c: str(c["intervalMs"]))
def test_subscription_case(case: dict[str, Any]) -> None:
    plan = create_plan(
        "p",
        member_account(SCOPE, "ana", COIN),
        member_account(SCOPE, "ben", COIN),
        case["amount"],
        case["intervalMs"],
    )
    subscription = start_subscription("s", plan, T0)
    assert [
        {"elapsedMs": elapsed, "due": charges_due(subscription, T0 + elapsed)}
        for elapsed in case["elapsedMs"]
    ] == case["expected"]
    assert next_charge_at(subscription) == case["nextChargeAt"]


@pytest.mark.parametrize("case", BILLING["payrolls"])
def test_payroll_split_case(case: dict[str, Any]) -> None:
    recipients = [member_account(SCOPE, f"m{index}", COIN) for index in range(case["count"])]
    lines = (
        split_payroll(case["total"], recipients, case["weights"])
        if case["weights"] is not None
        else split_payroll(case["total"], recipients)
    )
    assert [{"owner": line.recipient.owner, "amount": line.amount} for line in lines] == (
        case["expected"]
    )


@pytest.mark.parametrize("case", BILLING["financed"])
def test_financed_purchase_case(case: dict[str, Any]) -> None:
    engine = EconomyEngine(currencies=[create_currency(COIN)])
    _, plan = finance_purchase(
        engine,
        "f",
        member_account(SCOPE, "ana", COIN),
        make_account(member_account(SCOPE, "ben", COIN), 0),
        case["cashPrice"],
        case["rateBasisPoints"],
        case["instalments"],
        T0,
        "finance",
        "shared vector",
    )
    assert plan.total_payable == case["expected"]["totalPayable"]
    assert plan.cost_of_credit == case["expected"]["costOfCredit"]


REPORTING = load("reporting")


@pytest.mark.parametrize("case", REPORTING["gini"], ids=lambda c: str(len(c["balances"])))
def test_gini_case(case: dict[str, Any]) -> None:
    assert gini_permille(case["balances"]) == case["expected"]


@pytest.mark.parametrize("case", REPORTING["distributions"])
def test_distribution_case(case: dict[str, Any]) -> None:
    balances = {
        account_key(member_account(SCOPE, owner, COIN)): amount
        for owner, amount in case["balances"].items()
    }
    distribution = wealth_distribution(balances)
    assert {
        "holders": distribution.holders,
        "total": distribution.total,
        "median": distribution.median,
        "mean": distribution.mean,
        "giniPermille": distribution.gini_permille,
    } == case["expected"]
    assert [
        {"key": key, "amount": amount} for key, amount in top_holders(balances, 3)
    ] == case["topHolders"]
