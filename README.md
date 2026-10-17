# EconomyWorld

> A complete economy — balances, banking, credit, investments, markets, fees, billing and reporting — calculated, never stored. Play money, integer amounts, no randomness.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/UplyTech/EconomyWorld/badge)](https://scorecard.dev/viewer/?uri=github.com/UplyTech/EconomyWorld)
[![Python](https://img.shields.io/badge/python-%3E%3D3.10-blue)](./python)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](./typescript)

---

> **Status: built ahead of a named consumer**
>
> The concept behind this package ([`package-economyworld.md`](../../../01-company/concepts/package-economyworld.md))
> sets six conditions before it should be written, and today none of them are
> met — no UplyTech product has an economy, and no maintainer is named. It was
> built anyway, on request. Two things follow, and they are worth knowing before
> you depend on it:
>
> - **The interface has never met a real caller.** It is complete and tested, but
>   the first product that adopts it will find things it wants differently. Treat
>   `2.0.0` as "stable enough to build against", not "shaped by experience".
> - **The legal review the concept asks for has not happened.** The scope was
>   drawn conservatively for that reason: no real money, no randomness, no
>   gambling mechanics. See [Deliberately absent](#deliberately-absent).

## What it does, in one sentence

EconomyWorld turns any economic event — a payment, a deposit, a loan
instalment, a fill on an order book, a subscription charge — into a complete,
balanced, indivisible booking, and hands it to you to write.

## The one rule you have to keep

**Every posting must be written in a single database transaction.**

```sql
BEGIN;
  UPDATE accounts SET balance = ... WHERE ...;   -- every line
  UPDATE accounts SET balance = ... WHERE ...;
  INSERT INTO postings (operation_id, ...) ...;  -- and the posting itself
COMMIT;
```

The library computes; it stores nothing, so it *cannot* make that write atomic.
Writing the lines one at a time is how currency appears from nowhere or
vanishes, and in a community both are noticed within a day.

That is the honest limit of being storage-agnostic, and it is stated here rather
than buried. Its other half: **`operation_id` must be a `UNIQUE` column**, or a
retried request will book twice.

## What it deliberately does not do

| Not in scope | Who does it instead |
|---|---|
| **Storing anything** | You. Balances, postings and inventories live in your database. |
| **Making writes atomic** | You. See above — this is the one thing the library cannot do for you. |
| **Talking to Discord** | Your bot. EconomyWorld has never heard of a guild. |
| **Displaying money** | Your bot. `splitMinorUnits` gives you the parts; formatting is a locale decision. |
| **Experience points and levels** | [RankMode](../RankMode). Points are recognition, balance is purchasing power. |
| **Deciding what anything is worth** | You. Every price, rate and valuation is an argument. The library holds, values and settles positions; it has no market model, and adding one would mean inventing prices. |
| **Competitive ranks, ratings and seasons** | [RankMode](../RankMode) as well. A balance says what somebody can afford, not how good they are. |

### Deliberately absent

These are not gaps to be filled later. Each is excluded on purpose:

| Absent | Why |
|---|---|
| **Real money** | The moment a balance has monetary value, financial supervision and anti-money-laundering law apply. That is a different project, not a feature. |
| **Any randomness at all** | Random payouts are the mechanism behind loot boxes, which several EU jurisdictions treat as gambling *even without real money*. RankMode randomises XP on purpose; EconomyWorld contains no random generator anywhere. |
| **Wagering, slot machines, crates** | Same reason. If a product wants them, it builds and legally reviews them itself. |
| **Floating-point amounts** | Rounding drift becomes visible over millions of bookings — and makes two language editions disagree. Every amount is an integer in the smallest unit. |
| **Buying or cashing out currency** | Both turn play money into something with a real-world value. |
| **A price model, volatility, or a market that moves on its own** | A generated price is a random payout wearing a different hat. Prices come from the caller; see [Investments and markets](#investments-and-markets-without-a-market-model). |

## Two editions, one behaviour

| Edition | Package | Status |
|---|---|---|
| **Python** | [`economyworld`](./python) | primary — the plausible callers are Python bots |
| **TypeScript** | [`@uplytech/economyworld`](./typescript) | for forums, websites and Node bots |

Both produce **identical results for identical inputs**, proven by
[`shared/testcases/`](./shared/testcases), which both test suites run, and by
the [differential harness](./shared/tools/differential/README.md), which
compares them on cases nobody wrote down.

Every name exists in both, spelled the way each language spells things:
`apply_basis_points` / `applyBasisPoints`, `total_outstanding` /
`totalOutstanding`. There is exactly **one** deliberate difference, and it is
this: Python's `make_account` is TypeScript's `account`. Python cannot call it
`account` without shadowing the variable every caller wants to name `account`.

## Install

```bash
pip install uplytech-economyworld   # Python
npm install @uplytech/economyworld  # TypeScript
```

> **Not on npm or PyPI yet.** The first release is pending the Trusted Publisher setup on both registries. Until then, build from a clone (see [CONTRIBUTING.md](./CONTRIBUTING.md)) or use the signed artefacts of a [GitHub release](https://github.com/UplyTech/EconomyWorld/releases) once one exists.

Neither edition has a single mandatory dependency.

## Five minutes

```python
from economyworld import EconomyEngine, create_currency, member_account, make_account

engine = EconomyEngine(currencies=[create_currency("COIN")])

result = engine.transfer(
    make_account(member_account("guild-1", "ana", "COIN"), 500),   # loaded by you
    make_account(member_account("guild-1", "ben", "COIN"), 0),     # loaded by you
    200,
    now=now_in_epoch_millis(),
    operation_id=f"pay:{interaction.id}",     # unique, derived from the request
    reason="/pay from ana to ben",
)

with db.transaction():                        # <- your obligation
    for line in result.posting.lines:
        db.set_balance(line.account, line.balance_after)
    db.insert_posting(result.posting)
```

```typescript
import { EconomyEngine, createCurrency, memberAccount, account } from "@uplytech/economyworld";

const engine = new EconomyEngine({ currencies: [createCurrency({ code: "COIN" })] });

const result = engine.transfer(
  account(memberAccount("guild-1", "ana", "COIN"), 500),
  account(memberAccount("guild-1", "ben", "COIN"), 0),
  200,
  { now: Date.now(), operationId: `pay:${interaction.id}`, reason: "/pay" },
);

await db.transaction(async (tx) => {          // <- your obligation
  for (const line of result.posting.lines) await tx.setBalance(line.account, line.balanceAfter);
  await tx.insertPosting(result.posting);
});
```

Runnable versions, including a Discord bot with a real transaction boundary,
live in [`python/examples/`](./python/examples) and
[`typescript/examples/`](./typescript/examples).

## Double-entry, and why the mint goes negative

Every posting's lines sum to zero. That single property is what makes "no
currency appeared from nowhere" something you can **check** rather than hope for.

New money still has to enter the economy somewhere, so each scope has system
accounts that are allowed to go arbitrarily negative:

```text
credit 500 to ana:
    guild-1/ana/COIN         +500     (balance 0 -> 500)
    guild-1/system:mint/COIN -500     (balance 0 -> -500)
                             ----
                                0     ✓
```

The mint's balance, negated, is exactly how much currency exists in the scope.
`system:sink` is where destroyed currency goes, `system:shop` where payments
land, `system:escrow` where trade funds can sit.

**Storing system accounts is your choice** — but pick one and stay with it. If
you do store them, load and pass them on every call; if you don't, ignore the
system lines' before/after values. Mixing the two writes wrong system balances.

## What is in the box

| Area | What you get |
|---|---|
| **Bookings** | `credit`, `debit`, `transfer` — each one complete and balanced |
| **Earning** | Fixed payouts with per-member cooldowns and period ceilings |
| **Reversal** | The exact inverse of an earlier posting, leaving both in the audit trail |
| **Decay** | Optional flat and/or percentage shrinkage of idle balances |
| **Inventory** | Items with stack limits and a tradable flag; immutable inventories |
| **Shop** | Offers with stock, per-member limits and availability windows |
| **Trade** | A real state machine: propose → accept → settle, with cancel and expiry |
| **Banking** | Deposits with terms, interest, early-withdrawal penalties, and holds that stop one balance being spent twice |
| **Escrow** | The heavier alternative to a hold: the currency really moves to `system:escrow`, where both sides can see it |
| **Credit** | Loans on three amortisation methods, part payments, arrears, late fees, early settlement with a rebate, write-off |
| **Interest** | Compound and simple accrual, and amortisation schedules that check themselves before they are handed back |
| **Investments** | Instruments and positions with a cost basis and a realised gain; bond coupons and dividend distribution |
| **Markets** | A limit order book with price/time/id priority and no self-trade, currency exchange, and auctions with an open or hidden reserve |
| **Fees and taxes** | Flat, proportional and tiered rules, charged on top or inclusively, quoted before they are charged |
| **Billing** | Subscriptions that catch up without double-billing, financed purchases, payroll |
| **Reporting** | Trial balance, money supply, member statements, turnover, wealth distribution and the Gini coefficient |

## Investments and markets, without a market model

A member can hold a share, buy a bond, place a limit order and win an auction.
What the library will never do is decide what any of it is worth.

Every price is an argument:

```python
buy_units(engine, instrument, position, buyer, units=10, unit_price=250, ...)
```

That is not a gap. A library that generated prices would be generating payouts,
and a generated payout is the loot-box mechanism with a different label — the
one thing this package excludes everywhere else. So there is no volatility, no
drift, no order flow and no chance anywhere in the market modules. A community
that wants a moving price computes it, is answerable for it, and passes it in.

A bond's coupon is the single exception, and only because it is not a
prediction: `5 % of a face value of 1,000` is fixed in the bond's own terms and
knowable in advance.

## Lending, and what a write-off really is

A loan is currency that exists and is owed back. The disbursement comes out of
`system:credit`, so that account's balance — negated — is what the scope has
lent out, and it is checkable against the open loans.

A repayment is **three** lines, not two:

```text
ana repays 10,662:
    guild-1/ana/COIN           -10,662
    guild-1/system:credit/COIN  +9,462   (capital, back where it came from)
    guild-1/system:fee/COIN     +1,200   (interest, which is revenue)
                               --------
                                      0  ✓
```

Sending the whole payment to `system:credit` would leave it positive by exactly
the interest once every loan was repaid, and a number that means "currency
currently lent out" would then mean nothing at all.

When a debt is given up on, the counter-line is the **mint**, not the sink. The
sink is where currency is destroyed, and nothing is destroyed: the borrower
still has what they were lent and is simply never going to give it back. What
was a claim becomes an issuance, the money supply rises by exactly what was
lost, and the books still close.

## Limits are core, not extras

An economy without limits is worthless within days. So the cooldown and the
period ceiling are parameters of an earning rule, not something to bolt on:

```python
create_earn_rule("message", amount=5, currency="COIN",
                 cooldown_seconds=60, period_cap_amount=200)
```

A blocked payout is an **outcome**, not an exception — it happens constantly:

```python
match engine.earn(account, "message", state, ...).outcome:
    case EarnOutcome.EARNED:     ...
    case EarnOutcome.COOLDOWN:   ...   # normal
    case EarnOutcome.PERIOD_CAP: ...   # normal
```

Exceptions are reserved for cases where continuing would produce a *wrong
balance*: insufficient funds, currency mismatch, overflow. `InsufficientFunds`
is an exception on purpose — a caller who forgets to check it must not
accidentally put a member into debt.

## Trades are a state machine

```text
              ┌──────────────┐
              │   PROPOSED   │──── cancel ───▶ CANCELLED  (final)
              └──────┬───────┘──── expire ───▶ EXPIRED    (final)
       both accept   │
              ┌──────┴───────┐
              │   ACCEPTED   │──── cancel ───▶ CANCELLED  (final)
              └──────┬───────┘
             settle  │
              ┌──────┴───────┐
              │  COMPLETED   │  (final)
              └──────────────┘
```

Nothing moves until `settleTrade`, and that returns one posting plus both
inventory changes together. An abandoned trade therefore leaves no damage
behind — which is exactly what the concept asks for. Currency is netted: if one
side offers 100 and the other 30, exactly 70 moves.

## Quality bar

Both editions are held to the same numbers:

| | Python | TypeScript |
|---|---|---|
| Tests | 929 | 696 |
| Statement coverage | 100 % | 99 % |
| Branch coverage | 100 % | 98 % |
| Mandatory dependencies | 0 | 0 |
| Type checking | `mypy --strict` clean | `tsc --noEmit` clean |
| Linting | `ruff` clean | `eslint` clean |
| Cross-edition agreement | 250 shared vectors, plus the differential harness | same |

Beyond example-based tests, both editions run **property tests over thousands of
randomised sequences** proving that transfers never change the money supply,
that every posting balances whatever produced it, that a deposit never creates
or destroys currency, that a repaid loan leaves the credit account at exactly
zero, that every share of every split adds up to the whole, and that the books
close across every subsystem at once.

And beyond *that*, the **differential harness** generates cases nobody wrote
down, answers them with both editions and compares. It exists because the fixed
vectors missed a real divergence, and it has since found five more — see
[`shared/tools/differential/`](./shared/tools/differential/README.md).

```bash
cd python     && .venv/bin/python -m pytest --cov=economyworld
cd typescript && npm test && npm run typecheck && npm run lint
cd .. && bash shared/tools/differential/parity.sh 1 20000
```

## Repository layout

```text
EconomyWorld/
├── README.md                 # you are here
├── CHANGELOG.md              # one history for both editions
├── CONTRIBUTING.md
├── SECURITY.md
├── LICENSE                   # MIT
├── shared/testcases/         # the contract between the editions
├── shared/tools/differential/ # the cases nobody wrote down
├── python/                   # the primary edition
└── typescript/               # the second edition
```

## Documentation

- [Python edition](./python/README.md)
- [TypeScript edition](./typescript/README.md)
- [Shared test vectors](./shared/testcases/README.md)
- [Differential harness](./shared/tools/differential/README.md)
- [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md) · [Changelog](./CHANGELOG.md)

## Security and OpenSSF

- **CI** runs on GitHub-hosted runners (`ci.yml`, `quality.yml`, `docs.yml`, `security.yml`, `nightly.yml`). The repository is public and the organisation runner serves private repositories only; for public repositories the hosted minutes are free. Pull requests are validated with a read-only token and without secrets; no workflow uses `pull_request_target`. Every action is pinned to a full commit SHA.
- **OpenSSF Scorecard** runs weekly and on every push to `main` (`scorecard.yml`) and publishes its result; the badge at the top shows the current score.
- **CodeQL** (`codeql.yml`) and **dependency review** on pull requests (`dependency-review.yml`) run on every change.
- **OpenSSF Best Practices badge** (bestpractices.dev): pending owner registration.
- **Supply chain**: Dependabot for npm, pip, Docker and GitHub Actions (weekly, minor and patch grouped), gitleaks and OSV scans on a schedule, [SECURITY.md](./SECURITY.md) with private reporting.
- **Not achievable here**: with a single maintainer the Scorecard checks for code review and contributors stay low.

### Releases and how to verify them

A release is created from a `v*` tag by `release.yml`: tests, build, signature, the GitHub release, then the registries. The registry jobs run in the protected environment `release` and use Trusted Publishing (OIDC), so no long-lived registry token exists. Each registry is switched on separately with the repository variables `PUBLISH_NPM` and `PUBLISH_PYPI` once its Trusted Publisher is configured ([.github/SETTINGS.md](./.github/SETTINGS.md)); without them a tag still produces the signed GitHub release.

- **npm**: `@uplytech/economyworld`, published with `npm publish --provenance`. Check with `npm audit signatures` or on the package page ("Built and signed on GitHub Actions").
- **PyPI**: `uplytech-economyworld`, published with `pypa/gh-action-pypi-publish` (PEP 740 attestations included).
- **GitHub release**: the same artefacts (npm tarball, wheel, sdist), `SHA256SUMS`, an in-toto SLSA provenance statement (`provenance.intoto.json`) and one UplyTech signature per file (`<file>.sig`, base64 of an ECDSA P-256 / SHA-256 signature).

```bash
# 1. UplyTech signature (public key: release-signing.pub in this repository)
base64 -d <file>.sig > <file>.sig.der
openssl dgst -sha256 -verify release-signing.pub -signature <file>.sig.der <file>
sha256sum -c SHA256SUMS --ignore-missing

# 2. GitHub build attestation
gh attestation verify <file> --repo UplyTech/EconomyWorld
```

The signing key is the organisation secret `RELEASE_SIGNING_KEY`; the release job fails when it is empty instead of publishing unsigned files.

## License

MIT — see [LICENSE](./LICENSE).
