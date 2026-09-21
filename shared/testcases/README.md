# Shared test vectors

These files are the contract between the Python and the TypeScript edition of
EconomyWorld. Both test suites read them and must reproduce every number
exactly.

Two editions that quietly compute different balances would be worse than having
no second edition at all, because nobody expects the difference — a member could
exploit it simply by moving between two of an operator's communities. These
files are how that is prevented.

## The files

| File | Pins down |
|---|---|
| `money.json` | Minor-unit splits, including negative amounts, and permille chains in orders that show floor division is not commutative. |
| `bookings.json` | Credit, debit and transfer: every line, every before/after balance, and the fact that they sum to zero. |
| `earning.json` | Payout sequences with cooldowns, period ceilings, period resets, an unknown rule and a nearly full account. |
| `decay.json` | Flat, percentage, and combined decay with a floor, across several elapsed spans. |
| `inventory.json` | Add and remove sequences, the deltas they report, and the resulting slots. |
| `shop.json` | Purchases at several prices and quantities, including a free offer, with stock and `maxPurchasable`. |
| `trade.json` | Settlement of currency-for-items, netted currency, and items-only trades. |
| `rounding.json` | Integer division under every rounding mode, on both signs. |
| `interest.json` | Accrual on both bases, level payments, and whole amortisation schedules under all three methods, row by row. |
| `banking.json` | A deposit's whole life: the deposit itself, each period's interest, and the maturity projection. |
| `credit.json` | Whole loans, repaid instalment by instalment, with the fee/interest/capital split of every payment and the credit account reaching zero. |
| `fees.json` | Every rule shape quoted across eleven amounts, and exact fee splits. |
| `instruments.json` | Buy and sell sequences with the cost released and the gain realised, bond coupons, dividend splits. |
| `market.json` | Order matching including every tie-break, and exchange under every rounding mode. |
| `billing.json` | Subscription catch-up across a range of gaps, payroll splits, financed purchases. |
| `reporting.json` | The Gini coefficient, wealth distribution and leaderboards. |

## How the editions consume them

| | |
|---|---|
| Python | `python/tests/test_shared_vectors.py` |
| TypeScript | `typescript/tests/shared-vectors.test.ts` |

Every vector is deterministic by construction — this package contains no
randomness at all, so there is nothing to seed. Timestamps are offsets from a
fixed base carried in each file.

## Field naming

Every field uses the JSON (camelCase) spelling — `unitPrice`, `periodCapAmount`,
`balanceBefore` — in both editions. The Python side maps them onto its own
snake_case API when it loads a vector. One spelling in the files keeps the diffs
readable.

## Regenerating

```bash
cd typescript
npm run build
node scripts/generate-shared-vectors.mjs
```

**This is a deliberate act, not a routine step.** If a file here changes, the
behaviour of the library changed:

- a diff in `bookings.json` means a booking computes differently → **major**
- a diff in `earning.json` means members earn a different amount → **major**
- a diff in `decay.json` means stored balances shrink differently → **major**
- a diff in `interest.json` or `credit.json` means somebody's instalment changed → **major**
- a diff in `fees.json` means a member is charged a different fee → **major**
- a diff in `market.json` means a different order wins a tie → **major**

Review the diff as carefully as you review code, and record it in
`CHANGELOG.md`.

> Never regenerate these files to make a failing test pass. A failing vector is
> the system working: it is telling you the editions have drifted apart, or that
> you changed something you did not intend to. Find out which first.

## What these files cannot catch

A fixed list catches a regression in something somebody already imagined. It
missed the `applyPermille` divergence that lived through the whole of 1.x,
because every vector here used an amount below a million and the disagreement
only begins above 2⁵³ / 1000.

That is what [`shared/tools/differential/`](../tools/differential/README.md) is
for: it generates the cases nobody wrote down, in the bands where the two
editions have any reason to differ, and compares them. Anything it finds should
end up here as a vector.

## Format version

Each file carries a `formatVersion`. The suites assert it, so a vector file from
a future layout fails loudly instead of being half-read.
