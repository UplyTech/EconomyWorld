#!/usr/bin/env python3
"""Answer every generated case with the Python edition.

    PYTHONPATH=python/src python run_python.py --cases cases.json \
        --out results-python.json

This file and ``run-typescript.mjs`` are deliberately written to mirror each
other line for line. A difference between them is a difference in the harness,
not in the library, and it is the one kind of false positive that would make
nobody trust the red build.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from economyworld import (
    AccrualBasis,
    AmortisationMethod,
    EconomyEngine,
    FeeMode,
    InstrumentKind,
    OrderSide,
    Rounding,
    account_balances,
    accrue_deposit_interest,
    accrue_interest,
    amortisation_schedule,
    amount_due,
    apply_basis_points,
    apply_permille,
    apply_rate,
    average_cost,
    best_ask,
    best_bid,
    book_depth,
    buy_units,
    charge_late_fee,
    charge_subscription,
    charges_due,
    close_auction,
    coupon_due,
    create_currency,
    create_deposit_terms,
    create_fee_rule,
    create_instrument,
    create_loan_terms,
    create_order,
    create_plan,
    deposit,
    distribute,
    distribute_dividend,
    distribute_evenly,
    divide_rounded,
    early_withdrawal_penalty,
    exchange,
    is_mature,
    level_payment,
    make_account,
    match_order,
    maturity_value,
    member_account,
    money_supply,
    next_charge_at,
    open_auction,
    open_deposit,
    open_loan,
    open_position,
    pause_subscription,
    place_bid,
    project_balance,
    quote_fee,
    repay,
    resume_subscription,
    sell_units,
    settlement_quote,
    split_fee,
    split_minor_units,
    split_payroll,
    spread,
    start_subscription,
    statement_for,
    top_holders,
    trial_balance,
    turnover_by_kind,
    value_position,
    wealth_distribution,
    withdraw,
    write_off,
)
from economyworld.instruments import Position

SCOPE = "g1"
CURRENCY = "COIN"
NOW = 1_700_000_000_000

engine = EconomyEngine(currencies=[create_currency(CURRENCY)])


def ref(owner: str):
    return member_account(SCOPE, owner, CURRENCY)


def acct(owner: str, balance: int):
    return make_account(ref(owner), balance)


def go(fn, *args, **kwargs):
    """An error is an answer too: both editions must refuse the same inputs."""
    try:
        return fn(*args, **kwargs)
    except Exception as error:  # noqa: BLE001 - the class name is the answer
        return f"E:{type(error).__name__}"


# ---------------------------------------------------------------------------
# Normalised shapes. Both runners emit exactly these keys, in this order.
# ---------------------------------------------------------------------------
def schedule_of(schedule: Any) -> dict[str, Any]:
    return {
        "principal": schedule.principal,
        "totalInterest": schedule.total_interest,
        "totalPaid": schedule.total_paid,
        "payments": [row.payment for row in schedule.instalments],
        "interest": [row.interest for row in schedule.instalments],
        "closing": [row.closing_balance for row in schedule.instalments],
    }


def position_of(position: Any) -> dict[str, Any]:
    return {
        "units": position.units,
        "costBasis": position.cost_basis,
        "realisedGain": position.realised_gain,
    }


def order_of(order: Any) -> dict[str, Any]:
    return {
        "orderId": order.order_id,
        "side": order.side.value,
        "unitPrice": order.unit_price,
        "quantity": order.quantity,
        "filled": order.filled,
        "state": order.state.value,
    }


def fill_of(fill: Any) -> dict[str, Any]:
    return {
        "buyOrderId": fill.buy_order_id,
        "sellOrderId": fill.sell_order_id,
        "quantity": fill.quantity,
        "unitPrice": fill.unit_price,
        "consideration": fill.consideration,
    }


def answer(item: dict[str, Any]) -> dict[str, Any]:  # noqa: C901 - a dispatch table
    kind = item["kind"]

    if kind == "money":
        mode = Rounding(item["rounding"])
        return {
            "permille": go(apply_permille, abs(item["amount"]), item["permilleChain"]),
            "basisPoints": go(apply_basis_points, item["amount"], item["basisPoints"], mode),
            "rate": go(
                apply_rate,
                item["amount"],
                item["rateNumerator"],
                item["rateDenominator"],
                mode,
            ),
            "divide": go(divide_rounded, item["amount"], item["rateDenominator"], mode),
            "distribute": go(distribute, item["amount"], item["weights"]),
            "evenly": go(distribute_evenly, item["amount"], item["parts"]),
            "split": go(
                lambda: _minor_units(
                    split_minor_units(item["amount"], create_currency("X", minor_units=2))
                )
            ),
        }

    if kind == "interest":
        basis = AccrualBasis(item["basis"])
        method = AmortisationMethod(item["method"])
        rounding = Rounding(item["rounding"])
        return {
            "accrue": go(
                accrue_interest,
                item["principal"],
                item["rateBasisPoints"],
                item["periods"],
                basis,
                rounding,
            ),
            "projected": go(
                project_balance,
                item["principal"],
                item["rateBasisPoints"],
                item["periods"],
                basis,
                rounding,
            ),
            "level": go(
                level_payment,
                item["principal"],
                item["rateBasisPoints"],
                item["periods"],
                rounding,
            ),
            "schedule": go(
                lambda: schedule_of(
                    amortisation_schedule(
                        item["principal"],
                        item["rateBasisPoints"],
                        item["periods"],
                        method,
                        rounding,
                    )
                )
            ),
        }

    if kind == "fee":
        from economyworld.tax import create_tier

        rule = go(
            create_fee_rule,
            "f",
            mode=FeeMode(item["mode"]),
            flat=item["flat"],
            basis_points=item["basisPoints"],
            tiers=[create_tier(t["threshold"], t["basisPoints"]) for t in item["tiers"]],
            minimum=item["minimum"],
            maximum=item["maximum"],
            rounding=Rounding(item["rounding"]),
        )
        if isinstance(rule, str):
            return {"rule": rule}
        quote = go(quote_fee, rule, item["amount"])
        return {
            "rule": "ok",
            "fee": quote if isinstance(quote, str) else quote.fee,
            "payerPays": quote if isinstance(quote, str) else quote.payer_pays,
            "recipientReceives": (
                quote if isinstance(quote, str) else quote.recipient_receives
            ),
            "splitFee": go(
                split_fee, 0 if isinstance(quote, str) else quote.fee, [1, 2, 3]
            ),
        }

    if kind == "bank":
        terms = go(
            create_deposit_terms,
            rate_basis_points=item["rateBasisPoints"],
            basis=AccrualBasis(item["basis"]),
            rounding=Rounding(item["rounding"]),
            term_ms=item["termMs"],
            early_withdrawal_penalty_bp=item["penaltyBp"],
        )
        if isinstance(terms, str):
            return {"terms": terms}

        state = {"account": open_deposit("d1", ref("ana"), terms, NOW)}
        member = acct("ana", 1_000_000_000)

        def pay_in() -> int:
            booking, updated = deposit(
                engine, state["account"], member, item["principal"] or 1, NOW, "in", "in"
            )
            state["account"] = updated
            return booking.posting.amount

        def accrue() -> int:
            booking, updated = accrue_deposit_interest(
                engine, state["account"], item["periods"], NOW, "acc", "acc"
            )
            state["account"] = updated
            return 0 if booking is None else booking.posting.amount

        paid_in = go(pay_in)
        accrued = go(accrue)
        at = NOW + item["withdrawAt"]

        def take_out() -> list[int]:
            booking, updated = withdraw(
                engine, state["account"], member, item["withdraw"], at, "out", "out"
            )
            return [booking.posting.amount, updated.principal, updated.accrued_interest]

        return {
            "terms": "ok",
            "paidIn": paid_in,
            "accrued": accrued,
            "balance": state["account"].balance,
            "mature": go(is_mature, state["account"], at),
            "penalty": go(early_withdrawal_penalty, state["account"], at),
            "maturity": go(maturity_value, state["account"], 12),
            "withdrawn": go(take_out),
        }

    if kind == "credit":
        terms = go(
            create_loan_terms,
            principal=item["principal"],
            rate_basis_points=item["rateBasisPoints"],
            periods=item["periods"],
            method=AmortisationMethod(item["method"]),
            rounding=Rounding(item["rounding"]),
            late_fee_basis_points=item["lateFeeBp"],
            grace_periods=item["gracePeriods"],
        )
        if isinstance(terms, str):
            return {"terms": terms}

        opened = go(open_loan, engine, "L", terms, acct("ben", 0), NOW, "open", "open")
        if isinstance(opened, str):
            return {"terms": "ok", "opened": opened}
        booking, loan = opened
        if item["missed"] > 0:
            charged = go(charge_late_fee, loan, item["missed"])
            if isinstance(charged, str):
                return {"terms": "ok", "opened": "ok", "fee": charged}
            loan = charged

        borrower = acct("ben", 1_000_000_000)
        steps: list[Any] = []
        for payment in item["payments"]:
            outcome = go(
                repay, engine, loan, borrower, payment, NOW, f"p{len(steps)}", "pay"
            )
            if isinstance(outcome, str):
                steps.append(outcome)
                break
            loan = outcome.loan
            steps.append(
                [
                    outcome.to_fees,
                    outcome.to_interest,
                    outcome.to_principal,
                    outcome.instalments_cleared,
                    outcome.settled,
                ]
            )

        def do_write_off() -> int:
            posting, _ = write_off(engine, loan, NOW, "wo", "wo")
            return 0 if posting is None else posting.posting.amount

        return {
            "terms": "ok",
            "opened": "ok",
            "disbursed": booking.posting.amount,
            "totalPayable": loan.schedule.total_paid,
            "steps": steps,
            "outstandingPrincipal": loan.principal_outstanding,
            "outstandingInterest": loan.interest_outstanding,
            "fees": loan.fees_outstanding,
            "state": loan.state.value,
            "quote": go(settlement_quote, loan, item["rebateBp"]),
            "writeOff": go(do_write_off),
        }

    if kind == "instrument":
        share = create_instrument("ACME", InstrumentKind.SHARE, CURRENCY)
        position = open_position(ref("ana"), share)
        holder = acct("ana", 1_000_000_000_000)
        steps: list[Any] = []
        for trade in item["trades"]:
            fn = buy_units if trade["side"] == "BUY" else sell_units
            outcome = go(
                fn,
                engine,
                share,
                position,
                holder,
                trade["units"],
                trade["unitPrice"],
                NOW,
                f"t{len(steps)}",
                "t",
            )
            if isinstance(outcome, str):
                steps.append(outcome)
                continue
            position = outcome.position
            steps.append([outcome.consideration, outcome.realised_gain])

        bond = go(
            create_instrument,
            "GOV",
            InstrumentKind.BOND,
            CURRENCY,
            face_value=item["faceValue"],
            coupon_basis_points=item["couponBp"],
        )
        positions = [
            Position(
                holder=ref(f"h{index}"),
                instrument_id="ACME",
                units=units,
                cost_basis=0,
                realised_gain=0,
            )
            for index, units in enumerate(item["holders"])
        ]

        return {
            "steps": steps,
            "position": position_of(position),
            "averageCost": average_cost(position),
            "valuation": go(
                lambda: [
                    value_position(position, item["valuationPrice"]).market_value,
                    value_position(position, item["valuationPrice"]).unrealised_gain,
                ]
            ),
            "coupon": (
                bond
                if isinstance(bond, str)
                else go(coupon_due, bond, item["couponUnits"], item["couponPeriods"])
            ),
            "dividend": go(
                lambda: [
                    share_ for _, share_ in distribute_dividend(positions, item["dividend"])
                ]
            ),
        }

    if kind == "market":
        book: list[Any] = []
        results: list[Any] = []
        for spec in item["orders"]:
            order = go(
                create_order,
                spec["orderId"],
                ref(spec["owner"]),
                "ACME",
                OrderSide(spec["side"]),
                spec["unitPrice"],
                spec["quantity"],
                spec["placedAt"],
            )
            if isinstance(order, str):
                results.append(order)
                continue
            match = go(match_order, order, book)
            if isinstance(match, str):
                results.append(match)
                continue
            book = list(match.book)
            results.append([fill_of(fill) for fill in match.fills])

        auction = go(
            open_auction,
            "a1",
            ref("seller"),
            "sword",
            CURRENCY,
            item["reserve"],
            NOW,
            NOW + 10_000,
            min_increment=item["minIncrement"],
            reserve_hidden=item["reserveHidden"],
        )
        bid_results: list[str] = []
        if not isinstance(auction, str):
            from economyworld.market import Bid

            for bid in item["bids"]:
                nxt = go(
                    place_bid,
                    auction,
                    Bid(
                        bidder=ref(bid["bidder"]),
                        amount=bid["amount"],
                        placed_at=bid["placedAt"],
                        bid_id=bid["bidId"],
                    ),
                    bid["placedAt"],
                )
                if isinstance(nxt, str):
                    bid_results.append(nxt)
                else:
                    auction = nxt
                    bid_results.append("ok")

        def close() -> list[Any]:
            outcome = close_auction(auction, NOW + 20_000)
            return [
                outcome.auction.state.value,
                None if outcome.winner is None else outcome.winner.bid_id,
                outcome.price,
            ]

        closed = auction if isinstance(auction, str) else go(close)

        def do_exchange() -> int:
            other = member_account(SCOPE, "ana", "SILVER")
            engine2 = EconomyEngine(
                currencies=[create_currency(CURRENCY), create_currency("SILVER")]
            )
            _, _, received = exchange(
                engine2,
                acct("ana", 1_000_000_000),
                make_account(other, 0),
                item["exchangeAmount"],
                item["rateNumerator"],
                item["rateDenominator"],
                NOW,
                "x",
                "x",
                rounding=Rounding(item["rounding"]),
            )
            return received

        best_b = best_bid(book, "ACME")
        best_a = best_ask(book, "ACME")
        return {
            "fills": results,
            "book": [order_of(order) for order in book],
            "bestBid": None if best_b is None else best_b.unit_price,
            "bestAsk": None if best_a is None else best_a.unit_price,
            "spread": spread(book, "ACME"),
            "depth": [
                book_depth(book, "ACME", OrderSide.BUY),
                book_depth(book, "ACME", OrderSide.SELL),
            ],
            "bids": bid_results,
            "closed": closed,
            "exchanged": go(do_exchange),
        }

    if kind == "billing":
        plan = go(
            create_plan,
            "p1",
            ref("ana"),
            ref("guild"),
            item["amountPer"],
            item["intervalMs"],
            occurrences=item["occurrences"],
        )
        if isinstance(plan, str):
            return {"plan": plan}

        subscription = start_subscription("s1", plan, NOW)
        if item["pauseAtMs"] is not None:
            paused = go(pause_subscription, subscription, NOW + item["pauseAtMs"])
            if not isinstance(paused, str):
                subscription = paused
                resumed = go(
                    resume_subscription,
                    subscription,
                    NOW + max(item["pauseAtMs"], item["resumeAtMs"]),
                )
                if not isinstance(resumed, str):
                    subscription = resumed

        at = NOW + item["elapsedMs"]
        due = go(charges_due, subscription, at)

        def do_charge() -> list[Any]:
            outcome = charge_subscription(
                engine, subscription, acct("ana", 10_000_000_000), at, "c1", "c"
            )
            return [
                outcome.charges,
                outcome.amount,
                outcome.subscription.state.value,
                None if outcome.booking is None else outcome.booking.posting.amount,
            ]

        def next_at() -> int | None:
            nxt = next_charge_at(subscription)
            return None if nxt is None else nxt - NOW

        return {
            "plan": "ok",
            "due": due,
            "charged": go(do_charge),
            "nextAt": go(next_at),
            "payroll": go(
                lambda: [
                    line.amount
                    for line in split_payroll(
                        item["payrollTotal"],
                        [ref(f"r{i}") for i in range(item["recipients"])],
                        item["weights"],
                    )
                ]
            ),
        }

    if kind == "reporting":
        postings = []
        for index, value in enumerate(item["mints"]):
            postings.append(
                engine.credit(acct("ana", 0), value, NOW, f"m{index}", "mint").posting
            )
        for index, value in enumerate(item["transfers"]):
            out = go(
                engine.transfer,
                acct("ana", 10_000_000_000),
                acct("ben", 0),
                value,
                NOW,
                f"t{index}",
                "move",
            )
            if not isinstance(out, str):
                postings.append(out.posting)

        tb = trial_balance(postings)
        supply = money_supply(postings, SCOPE, CURRENCY)
        statement = statement_for(postings, ref("ana"))
        balances = {
            f"{SCOPE}/m{index}/{CURRENCY}": value
            for index, value in enumerate(item["balances"])
        }
        distribution = wealth_distribution(balances)

        return {
            "trial": [tb.postings, tb.total, tb.balances, len(tb.duplicates)],
            "supply": [
                supply.issued,
                supply.retired,
                supply.circulating,
                supply.held_by_members,
            ],
            "statement": [
                len(statement.lines),
                statement.closing_balance,
                statement.total_in,
                statement.total_out,
            ],
            "distribution": [
                distribution.holders,
                distribution.total,
                distribution.median,
                distribution.mean,
                distribution.gini_permille,
            ],
            "top": [[key, value] for key, value in top_holders(balances, item["limit"])],
            "turnover": {kind_.value: value for kind_, value in turnover_by_kind(postings).items()},
        }

    raise ValueError(f"unknown case kind: {kind}")


def _minor_units(parts: Any) -> list[Any]:
    return [parts.negative, parts.whole, parts.fraction]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", default=str(Path(__file__).parent / "cases.json"))
    parser.add_argument("--out", default=str(Path(__file__).parent / "results-python.json"))
    args = parser.parse_args()

    payload = json.loads(Path(args.cases).read_text("utf-8"))
    results = []
    for item in payload["cases"]:
        try:
            results.append({"id": item["id"], "kind": item["kind"], "value": answer(item)})
        except Exception as error:  # noqa: BLE001 - the class name is the answer
            results.append(
                {"id": item["id"], "kind": item["kind"], "error": type(error).__name__}
            )

    Path(args.out).write_text(
        json.dumps(
            {
                "formatVersion": payload["formatVersion"],
                "seed": payload["seed"],
                "edition": "python",
                "results": results,
            }
        )
        + "\n",
        "utf-8",
    )
    print(f"python answered {len(results)} cases -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
