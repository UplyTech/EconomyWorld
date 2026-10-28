# @uplytech/economyworld

> A complete economy for community bots and forums: balances, banking, credit, investments, markets, fees, billing and reporting. Pure calculation — no storage, no platform binding, integer amounts only.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen)](https://nodejs.org)

This is the TypeScript edition. A [Python edition](../python) exists and produces
identical results — proven by [shared test vectors](../shared/testcases).

Play money only: no real currency, no payout, no payment provider, **no
randomness**. See the [root README](../README.md#deliberately-absent) for why
each of those is deliberately absent.

## Install

```bash
npm install @uplytech/economyworld
```

Zero runtime dependencies. Node 22.12 or newer. Ships CJS, ESM and types.

## The one rule you have to keep

```typescript
const result = engine.transfer(ana, ben, 200, { now, operationId, reason });

await db.transaction(async (tx) => {        // <-- your obligation, not the library's
  for (const line of result.posting.lines) {
    await tx.setBalance(line.account, line.balanceAfter);
  }
  await tx.insertPosting(result.posting);   // operationId must be UNIQUE
});
```

The library stores nothing, so it **cannot** make that write atomic. Writing the
lines one at a time is how currency appears from nowhere.

## Quick start

```typescript
import {
  EconomyEngine, createCurrency, memberAccount, account, emptyAccount,
} from "@uplytech/economyworld";

const engine = new EconomyEngine({
  currencies: [createCurrency({ code: "COIN", name: "Coin" })],
});

const ana = memberAccount("guild-1", "ana", "COIN");
const result = engine.credit(emptyAccount(ana), 500, {
  now: 1_700_000_000_000,
  operationId: "welcome:ana",
  reason: "welcome gift",
});

result.balances["guild-1/ana/COIN"];         // 500
result.balances["guild-1/system:mint/COIN"]; // -500  <- what has been issued
```

## The engine

```typescript
new EconomyEngine({
  currencies: [...],       // Currency objects, or { code } shorthands
  earnRules: [...],
  allowNegative: false,    // let member balances go below zero
  shopAccountOwner: "system:shop",
});
```

| Method | Returns |
|---|---|
| `credit(target, amount, { now, operationId, reason, source? })` | `BookingResult` |
| `debit(source, amount, { …, target?, allowNegative? })` | `BookingResult` |
| `transfer(source, target, amount, { … })` | `BookingResult` |
| `earn(target, ruleKey, state, { …, source? })` | `EarnResult` |
| `reverse(original, balances, { … })` | `BookingResult` |
| `applyDecay(target, rule, { …, lastActivityAt, lastAppliedAt? })` | `DecayResult` |
| `canEarn(state, ruleKey, now)` | `boolean` |
| `earnCooldownRemainingMs(state, ruleKey, now)` | `number` |
| `earnPeriodRemaining(state, ruleKey, now)` | `number \| null` |
| `currency(code)` / `earnRule(key)` | lookups |

`now` is epoch **milliseconds** and is always passed in — the library never reads
the clock, so cooldowns and decay stay testable.

## Outcomes vs exceptions

Earning that pays nothing is a normal event:

```typescript
import { EarnOutcome } from "@uplytech/economyworld";

switch (result.outcome) {
  case EarnOutcome.Earned:            break;
  case EarnOutcome.Cooldown:          break;  // happens constantly
  case EarnOutcome.PeriodCap:         break;  // happens daily
  case EarnOutcome.RuleDisabled:      break;
  case EarnOutcome.UnknownRule:       break;
  case EarnOutcome.MaxBalanceReached: break;
  case EarnOutcome.NoAmount:          break;
}
```

Errors are for cases where continuing would produce a **wrong balance**:

| Error | Thrown when |
|---|---|
| `InsufficientFundsError` | the account cannot cover the debit — carries `.balance`, `.required`, `.shortfall` |
| `BalanceOverflowError` | the credit would pass the currency ceiling |
| `CurrencyMismatchError` | two accounts in one booking hold different currencies |
| `InvalidAmountError` | zero, negative, or not a whole number of minor units |
| `UnbalancedPostingError` | a hand-built posting's lines do not sum to zero |
| `ItemError` / `InsufficientQuantityError` | the inventory cannot do what was asked |
| `OfferError` / `TradeStateError` / `ReversalError` | the shop or trade rules refuse |
| `ConfigurationError` / `ValidationError` | a programming mistake |

All extend `EconomyError` and carry a stable `.code` plus frozen `.details`, so
you never have to compare message texts.

`InsufficientFundsError` is thrown rather than returned on purpose: a caller who
forgets to check must not accidentally put a member into debt.

## Money is always an integer

```typescript
const gold = createCurrency({ code: "GLD", name: "Gold", minorUnits: 2 });
// a balance of 123456 means 1234.56 GLD

splitMinorUnits(-123_456, gold);
// { negative: true, whole: 1234, fraction: 56 }
```

There is no float anywhere in this package. Formatting is a locale decision and
stays with you — `splitMinorUnits` gives you the parts, including the sign
handling everyone gets wrong.

## Earning, with limits that are core

```typescript
const engine = new EconomyEngine({
  currencies: [createCurrency({ code: "COIN" })],
  earnRules: [
    createEarnRule({
      key: "message",
      amount: 5,
      currency: "COIN",
      cooldownSeconds: 60,
      periodCapAmount: 200,
    }),
  ],
});

const state = (await loadEarnState(member)) ?? createEarnState();
const result = engine.earn(acc, "message", state, { now, operationId, reason });

if (result.posting !== null) {
  await db.transaction(async (tx) => {
    await write(tx, result.posting!);
    await storeEarnState(tx, member, result.state);
  });
}
```

Amounts are **fixed, never random** — see the root README on why.

## Inventory, shop and trade

```typescript
const potion = createItem({ itemId: "potion", name: "Potion", maxStack: 10 });
const badge = createItem({ itemId: "badge", tradable: false }); // cannot be handed over

const offer = createOffer({
  offerId: "offer-1", itemId: "potion", unitPrice: 50, currency: "COIN", stock: 100,
});
const result = purchase(engine, {
  offer, item: potion, buyer, inventory, quantity: 2, now, operationId, reason,
});
// result.booking, result.inventory, result.offer -- all three in one transaction
```

```typescript
let trade = proposeTrade({
  tradeId: "t1", scope, currency: "COIN",
  left: { owner: "ana", amount: 100, items: [] },
  right: { owner: "ben", amount: 0, items: [{ itemId: "potion", quantity: 1 }] },
  now,
});
trade = acceptTrade(acceptTrade(trade, "ana", now), "ben", now);
const settled = settleTrade(engine, { trade, ... });
```

Nothing moves until `settleTrade`. An abandoned trade leaves no damage behind.

## Banking

```typescript
const terms = createDepositTerms({
  rateBasisPoints: 500,
  termMs: 30 * 86_400_000,
  earlyWithdrawalPenaltyBp: 5_000,
});
let savings = openDeposit("d-1", memberAccount("guild-1", "ana", "COIN"), terms, now);

({ deposit: savings } = deposit(engine, savings, anaAccount, 10_000, { now, operationId, reason }));
({ deposit: savings } = accrueDepositInterest(engine, savings, 1, { now, operationId, reason }));
```

Money on deposit really moves, to `system:bank`, so "how much is on deposit" is
one balance rather than a sum over every member's row. Interest is issued from
the mint unless you name another source: in a closed economy a payment nobody
funds is new currency, and the posting should say so.

The early-withdrawal penalty is capped at the interest earned. A term account can
never hand a member back less than they put in.

**Holds** reserve funds without moving them, so a member cannot place an order,
bid in an auction and buy from a shop with the same balance:

```typescript
const hold = placeHold("h-1", anaAccount, 3_000, { now, reason: "an auction bid" });
availableBalance(anaAccount, [hold], now); // 2_000 of 5_000
```

**Escrow** is the heavier alternative. A hold reserves a balance where it is;
escrow moves it:

```typescript
placeInEscrow(engine, buyer, 3_000, { now, operationId, reason: "a big trade" });
settleFromEscrow(engine, seller, 3_000, { now, operationId, reason: "delivered", escrowAccount });
```

| | |
|---|---|
| `placeHold` | Nothing is booked. Cheap, reversible, and invisible to anybody but you — the counterparty takes your word that the funds exist. |
| `placeInEscrow` | A posting. The currency is in a third account both sides can see, and out of the payer's reach even if your process dies. |

A hold for an order that may never fill; escrow for a trade where the seller
wants to see the money first.

## Credit

```typescript
const terms = createLoanTerms({ principal: 120_000, rateBasisPoints: 100, periods: 12 });
const { loan } = openLoan(engine, "L-1", terms, borrower, { now, operationId, reason });

const result = repay(engine, loan, borrower, amountDue(loan), { now, operationId, reason });
result.toFees + result.toInterest + result.toPrincipal; // always the payment
```

Three amortisation methods (`EqualInstalment`, `EqualPrincipal`,
`InterestOnly`), part payments, late fees, arrears, early settlement with a
rebate on interest not yet reached, and `writeOff`.

A repayment is a **three-line** posting: capital returns to `system:credit`,
interest becomes revenue in `system:fee`. That is why the credit account reaches
exactly zero when a loan is repaid, and why its balance always means "currency
currently lent out".

## Investments and markets

```typescript
const share = createInstrument("guild-share", InstrumentKind.Share, "COIN");
const outcome = buyUnits(engine, share, position, buyer, 10, 250, { now, operationId, reason });
```

Every price is an argument. There is no price model, no volatility and no chance
anywhere in these modules — a generated price is a random payout wearing a
different hat. A bond's coupon is the one payout the library computes unaided,
because it is fixed in the bond's own terms.

The order book matches on price, then time, then id, and never matches two orders
from the same owner. `exchange` swaps one currency for another at a rate you
supply, as two postings — a posting balances within one currency and always will.
Auctions take a minimum increment and a reserve that is either open (a low bid is
refused as it is placed) or hidden (it is accepted and loses at the close).

## Fees, billing and reporting

```typescript
const rule = createFeeRule("market", {
  tiers: [createTier(0, 0), createTier(1_000, 250)],
});
const quote = quoteFee(rule, 5_000);            // show this to the member
chargeFee(engine, payer, quote, { now, operationId, reason });  // charges exactly that
```

Subscriptions catch up rather than double-bill: a scheduler that missed three
weeks takes one payment of three times the amount, and one that runs every minute
charges once. Pausing subtracts the paused time rather than postponing the bill.

```typescript
trialBalance(postings).balances;            // does the ledger close?
moneySupply(postings, "guild-1", "COIN");   // issued, retired, circulating
giniPermille(balances);                     // 0 = everybody equal, 1000 = one holder
```

`trialBalance` checks for duplicates as well as for balance, because a sum cannot
see a duplicate: two copies of a balanced posting still sum to zero, and still
gave somebody twice the currency.

## Persistence

```typescript
JSON.stringify(serializePosting(result.posting));   // -> postings table
JSON.stringify(serializeEarnState(result.state));   // -> member row
JSON.stringify(inventory.toJSON());                 // -> member row
```

All three use the same JSON field names as the Python edition, so a bot ported
between them keeps its data.

## Examples

```bash
npm run examples             # every example, in order
npx vite-node examples/basic.ts
npx vite-node examples/financial-system.ts
```

`financial-system.ts` runs a whole community economy for a year — wages, savings,
a loan, a share, a market, a subscription and a payroll — and finishes by checking
that the books close. Its Python twin prints the same numbers.

## Development

```bash
npm install
npm test                # 696 tests
npm run test:coverage   # 99 % coverage, gate at 95 %
npm run typecheck
npm run lint
npm run build

# regenerate the cross-edition vectors (deliberate act -- see CONTRIBUTING.md)
node scripts/generate-shared-vectors.mjs
```

The suite includes property runs over thousands of randomised sequences, and
the [differential harness](../shared/tools/differential/README.md) compares this
edition with the Python one on cases nobody wrote down:

```bash
npm run build
bash ../shared/tools/differential/parity.sh 1 20000
```

See [CONTRIBUTING.md](../CONTRIBUTING.md).

## License

Apache License 2.0. See [LICENSE](../LICENSE) and [NOTICE](../NOTICE).

Copyright (c) 2021-present UplyTech. UplyTech has existed as a community since 2021.
