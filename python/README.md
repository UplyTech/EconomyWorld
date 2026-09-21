# economyworld

> A complete economy for community bots and forums: balances, banking, credit, investments, markets, fees, billing and reporting. Pure calculation — no storage, no platform binding, integer amounts only.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../LICENSE)
[![Python](https://img.shields.io/badge/python-%3E%3D3.10-blue)](https://python.org)

This is the Python edition. A [TypeScript edition](../typescript) exists and
produces identical results — proven by [shared test vectors](../shared/testcases).

Play money only: no real currency, no payout, no payment provider, **no
randomness**. See the [root README](../README.md#deliberately-absent) for why
each of those is deliberately absent.

## Install

```bash
pip install economyworld
```

Zero mandatory dependencies. Python 3.10 or newer.

## The one rule you have to keep

```python
result = engine.transfer(ana, ben, 200, now=..., operation_id=..., reason=...)

with db.transaction():  # <-- your obligation, not the library's
    for line in result.posting.lines:
        db.set_balance(line.account, line.balance_after)
    db.insert_posting(result.posting)  # operation_id must be UNIQUE
```

The library stores nothing, so it **cannot** make that write atomic. Writing the
lines one at a time is how currency appears from nowhere.

## Quick start

```python
from economyworld import (
    EconomyEngine,
    create_currency,
    member_account,
    make_account,
    empty_account,
)

engine = EconomyEngine(currencies=[create_currency("COIN", name="Coin")])

ana = member_account("guild-1", "ana", "COIN")
result = engine.credit(
    empty_account(ana),
    500,
    now=1_700_000_000_000,
    operation_id="welcome:ana",
    reason="welcome gift",
)

result.balances["guild-1/ana/COIN"]  # 500
result.balances["guild-1/system:mint/COIN"]  # -500  <- what has been issued
```

## The engine

```python
EconomyEngine(
    currencies=[...],  # Currency objects, or bare codes
    earn_rules=[...],
    allow_negative=False,  # let member balances go below zero
    shop_account_owner="system:shop",
)
```

| Method | Returns |
|---|---|
| `credit(target, amount, now, operation_id, reason, source=None)` | `BookingResult` |
| `debit(source, amount, now, operation_id, reason, target=None, allow_negative=None)` | `BookingResult` |
| `transfer(source, target, amount, now, operation_id, reason)` | `BookingResult` |
| `earn(target, rule_key, state, now, operation_id, reason, source=None)` | `EarnResult` |
| `reverse(original, balances, now, operation_id, reason)` | `BookingResult` |
| `apply_decay(target, rule, now, operation_id, reason, last_activity_at, last_applied_at=None)` | `DecayResult` |
| `can_earn(state, rule_key, now)` | `bool` |
| `earn_cooldown_remaining_ms(state, rule_key, now)` | `int` |
| `earn_period_remaining(state, rule_key, now)` | `int \| None` |
| `currency(code)` / `earn_rule(key)` | lookups |

`now` is epoch **milliseconds** and is always passed in — the library never reads
the clock, so cooldowns and decay stay testable.

## Outcomes vs exceptions

Earning that pays nothing is a normal event:

```python
from economyworld import EarnOutcome

match engine.earn(account, "message", state, ...).outcome:
    case EarnOutcome.EARNED:
        ...
    case EarnOutcome.COOLDOWN:
        ...  # happens constantly
    case EarnOutcome.PERIOD_CAP:
        ...  # happens daily
    case EarnOutcome.RULE_DISABLED:
        ...
    case EarnOutcome.UNKNOWN_RULE:
        ...
    case EarnOutcome.MAX_BALANCE_REACHED:
        ...
    case EarnOutcome.NO_AMOUNT:
        ...
```

Exceptions are for cases where continuing would produce a **wrong balance**:

| Exception | Raised when |
|---|---|
| `InsufficientFundsError` | the account cannot cover the debit — carries `.balance`, `.required`, `.shortfall` |
| `BalanceOverflowError` | the credit would pass the currency ceiling |
| `CurrencyMismatchError` | two accounts in one booking hold different currencies |
| `InvalidAmountError` | zero, negative, or not a whole number of minor units |
| `UnbalancedPostingError` | a hand-built posting's lines do not sum to zero |
| `ItemError` / `InsufficientQuantityError` | the inventory cannot do what was asked |
| `OfferError` / `TradeStateError` / `ReversalError` | the shop or trade rules refuse |
| `ConfigurationError` / `ValidationError` | a programming mistake |

All derive from `EconomyError` and carry a stable `.code` plus read-only
`.details`, so you never have to compare message texts.

`InsufficientFundsError` is an exception rather than an outcome on purpose: a
caller who forgets to check must not accidentally put a member into debt.

## Money is always an integer

```python
gold = create_currency("GLD", name="Gold", minor_units=2)
# a balance of 123456 means 1234.56 GLD

parts = split_minor_units(-123_456, gold)
# MinorUnits(negative=True, whole=1234, fraction=56)
```

There is no float anywhere in this package. Formatting is a locale decision and
stays with you — `split_minor_units` gives you the parts, including the sign
handling everyone gets wrong.

## Earning, with limits that are core

```python
from economyworld import create_earn_rule, create_earn_state

rules = [
    create_earn_rule("message", 5, "COIN", cooldown_seconds=60, period_cap_amount=200),
    create_earn_rule("daily", 250, "COIN", cooldown_seconds=86400),
]

state = load_earn_state(member) or create_earn_state()
result = engine.earn(account, "message", state, now=..., operation_id=..., reason=...)

if result.booked:
    with db.transaction():
        write(result.posting)
        store_earn_state(member, result.state)
```

Amounts are **fixed, never random** — see the root README on why.

## Inventory, shop and trade

```python
potion = create_item("potion", name="Potion", max_stack=10)
badge = create_item("badge", tradable=False)  # cannot be handed over

offer = create_offer("offer-1", "potion", unit_price=50, currency="COIN", stock=100)
result = purchase(
    engine,
    offer=offer,
    item=potion,
    buyer=...,
    inventory=...,
    quantity=2,
    now=...,
    operation_id=...,
    reason=...,
)
# result.booking, result.inventory, result.offer -- all three in one transaction
```

```python
trade = propose_trade("t1", scope, "COIN",
                      left=TradeSide("ana", 100),
                      right=TradeSide("ben", 0, (InventorySlot("potion", 1),)),
                      now=...)
trade = accept_trade(accept_trade(trade, "ana", now), "ben", now)
settled = settle_trade(engine, trade=trade, ...)
```

Nothing moves until `settle_trade`. An abandoned trade leaves no damage behind.

## Banking

```python
from economyworld import (
    accrue_deposit_interest,
    create_deposit_terms,
    deposit,
    open_deposit,
    withdraw,
)

terms = create_deposit_terms(
    rate_basis_points=500, term_ms=30 * 86_400_000, early_withdrawal_penalty_bp=5_000
)
savings = open_deposit("d-1", member_account("guild-1", "ana", "COIN"), terms, now)

booking, savings = deposit(engine, savings, ana_account, 10_000, now, "op-1", "save")
booking, savings = accrue_deposit_interest(engine, savings, 1, now, "op-2", "interest")
```

Money on deposit really moves, to `system:bank`, so "how much is on deposit" is
one balance rather than a sum over every member's row. Interest is issued from
the mint unless you name another source: in a closed economy a payment nobody
funds is new currency, and the posting should say so.

The early-withdrawal penalty is capped at the interest earned. A term account
can never hand a member back less than they put in.

**Holds** reserve funds without moving them, so a member cannot place an order,
bid in an auction and buy from a shop with the same balance:

```python
hold = place_hold("h-1", ana_account, 3_000, now, "an auction bid")
available_balance(ana_account, [hold], now)  # 2_000 of 5_000
```

**Escrow** is the heavier alternative. A hold reserves a balance where it is;
escrow moves it:

```python
place_in_escrow(engine, buyer, 3_000, now, "op-1", "a big trade")
settle_from_escrow(engine, seller, 3_000, now, "op-2", "delivered", escrow_account=escrow)
```

| | |
|---|---|
| `place_hold` | Nothing is booked. Cheap, reversible, and invisible to anybody but you -- the counterparty takes your word that the funds exist. |
| `place_in_escrow` | A posting. The currency is in a third account both sides can see, and out of the payer's reach even if your process dies. |

A hold for an order that may never fill; escrow for a trade where the seller
wants to see the money first.

## Credit

```python
terms = create_loan_terms(principal=120_000, rate_basis_points=100, periods=12)
booking, loan = open_loan(engine, "L-1", terms, borrower, now, "op-1", "loan")

result = repay(engine, loan, borrower, amount_due(loan), now, "op-2", "instalment")
result.to_fees, result.to_interest, result.to_principal  # always adds up to the payment
```

Three amortisation methods (`EQUAL_INSTALMENT`, `EQUAL_PRINCIPAL`,
`INTEREST_ONLY`), part payments, late fees, arrears, early settlement with a
rebate on interest not yet reached, and `write_off`.

A repayment is a **three-line** posting: capital returns to `system:credit`,
interest becomes revenue in `system:fee`. That is why the credit account reaches
exactly zero when a loan is repaid, and why its balance always means "currency
currently lent out".

## Investments and markets

```python
share = create_instrument("guild-share", InstrumentKind.SHARE, "COIN")
outcome = buy_units(engine, share, position, buyer, units=10, unit_price=250, ...)
```

Every price is an argument. There is no price model, no volatility and no chance
anywhere in these modules — a generated price is a random payout wearing a
different hat. A bond's coupon is the one payout the library computes unaided,
because it is fixed in the bond's own terms.

The order book matches on price, then time, then id, and never matches two
orders from the same owner. `exchange` swaps one currency for another at a rate
you supply, as two postings — a posting balances within one currency and always
will. Auctions take a minimum increment and a reserve that is either open (a low
bid is refused as it is placed) or hidden (it is accepted and loses at the
close).

## Fees, billing and reporting

```python
rule = create_fee_rule("market", tiers=[create_tier(0, 0), create_tier(1_000, 250)])
quote = quote_fee(rule, 5_000)  # show this to the member
charge_fee(engine, payer, quote, ...)  # charges exactly what was quoted
```

Subscriptions catch up rather than double-bill: a scheduler that missed three
weeks takes one payment of three times the amount, and one that runs every
minute charges once. Pausing subtracts the paused time rather than postponing
the bill.

```python
trial_balance(postings).balances  # does the ledger close?
money_supply(postings, "guild-1", "COIN")  # issued, retired, circulating
gini_permille(balances)  # 0 = everybody equal, 1000 = one holder
```

`trial_balance` checks for duplicates as well as for balance, because a sum
cannot see a duplicate: two copies of a balanced posting still sum to zero, and
still gave somebody twice the currency.

## Persistence

```python
json.dumps(serialize_posting(result.posting))  # -> postings table
json.dumps(serialize_earn_state(result.state))  # -> member row
json.dumps(inventory.to_list())  # -> member row
```

All three use the same JSON field names as the TypeScript edition, so a bot
ported between them keeps its data.

## Examples

```bash
PYTHONPATH=src python examples/basic.py
PYTHONPATH=src python examples/discord_bot_integration.py
PYTHONPATH=src python examples/financial_system.py
```

The second one shows a real transaction boundary, an `operation_id` derived from
the Discord interaction, and what happens when the same request arrives twice.
The third runs a whole community economy for a year — wages, savings, a loan, a
share, a market, a subscription and a payroll — and finishes by checking that the
books close.

## Development

```bash
python -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest --cov=economyworld   # 929 tests, 100 % coverage
.venv/bin/python -m mypy                        # strict
.venv/bin/python -m ruff check .
```

The suite includes property runs over thousands of randomised sequences, and
the [differential harness](../shared/tools/differential/README.md) compares this
edition with the TypeScript one on cases nobody wrote down — see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## License

MIT — see [LICENSE](../LICENSE).
