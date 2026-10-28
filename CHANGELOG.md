# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Both language editions share one version number and one history. A release
happens for both at once, or not at all — two editions on different versions
would be exactly the drift the shared test vectors exist to prevent.

## [Unreleased]

### Changed

- **Licence: Apache License 2.0** (was MIT). `LICENSE` carries the full Apache text, `NOTICE` the attribution `Copyright (c) 2021-present UplyTech` (UplyTech has existed as a community since 2021); both ship in the npm package, the wheel and the sdist. Author fields name UplyTech only.
- PyPI distribution name `uplytech-economyworld` (was `economyworld`); the import name is unchanged. npm stays `@uplytech/economyworld`.
- Releases publish to npm and PyPI with Trusted Publishing (OIDC, no registry token) and npm provenance, after the signed GitHub release. Each registry is switched on with a repository variable once its Trusted Publisher exists. Every artefact also gets a GitHub build attestation.
- CI runs on GitHub-hosted runners, since the repository is public and the organisation runner serves private repositories only. Pull requests are validated again (read-only token, no secrets); CodeQL, dependency review and a published OpenSSF Scorecard are part of the checks.
- Repository links point to `github.com/UplyTech/EconomyWorld`.
- `NOTICE` names the licensor in full: UplyTech, Tim Hauke, Albert-Schweitzer-Ring 42, 25524 Itzehoe, Germany. Python metadata uses the PEP 639 fields (`license = "Apache-2.0"`, `license-files`); the wheel carries `LICENSE` and `NOTICE` under `licenses/`.
- Test toolchain: Vitest 5, ESLint 9 with a flat config, typescript-eslint 8. This clears the advisories in the old Vitest/Vite/esbuild dev tree (none of it reached a caller). The test matrix runs Node 22 and 24; Node 20 is end-of-life and Vitest 5 needs 22.12 or newer.
- Releases start only from a pushed `v*` tag on `main`; the manual trigger is gone. The registry jobs run in the environment `release` (only `v*` tags, the owner approves). Tool images in CI are pinned by digest. The Python dependency audit runs against the pinned dev environment and fails on any finding.

## [2.0.0] - 2026-09-09

A complete economy rather than a currency.

1.0.0 could hold a balance, move it, and sell things for it. It could not lend,
save, invest, bill, price a fee or tell an operator anything about the economy
it was running. This release adds all of that, and it is a major version because
two behaviours changed for callers who were relying on them.

### Changed — breaking

- **`applyPermille` / `apply_permille` refuse an answer they cannot represent
  identically in both editions.** They used to return one. For any amount below
  about 9 × 10¹² nothing changes; above it, a chain that used to come back with
  a slightly different number in each edition now raises `InvalidAmountError` in
  both. See the note below — this is the bug that led to the differential
  harness.
- **`shop_account_owner` / `shopAccountOwner` must name a system account.** An
  unrecognised owner used to be accepted: the Python edition quietly redirected
  the takings to `system:shop`, and the TypeScript edition quietly invented an
  account no report knows about. Both now refuse when the engine is built, which
  is where a configuration mistake belongs.

### Added — banking

- `Deposit` accounts with terms: a rate, an optional fixed term, a minimum
  balance and an early-withdrawal penalty. The penalty is capped at the interest
  earned, so a term account can never hand a member back less than they put in.
- `deposit`, `withdraw` and `accrue_deposit_interest` / `accrueDepositInterest`,
  each booking to a `system:bank` account so that "how much is on deposit" is
  one balance an operator can check rather than a sum across every member's row.
- Interest is issued from the mint unless the caller names another source. In a
  closed economy a payment that nobody funds is new currency, and the posting
  says so.
- `Hold`s: funds reserved without being moved, so a member cannot place an
  order, bid in an auction and buy from a shop with the same balance. Holds
  expire on their own, and `available_balance` / `availableBalance` is the
  number a bot should show.
- **Escrow**, the heavier sibling of a hold: `place_in_escrow`,
  `release_from_escrow` and `settle_from_escrow` really move the currency into
  `system:escrow`, where both sides can see it and the payer cannot reach it.
  A hold is cheap and invisible; escrow is a posting. Both now exist, and the
  trade-off is documented rather than implied — until this release
  `SystemAccount.ESCROW` was defined and described as holding a trade's funds
  while nothing in the library ever booked to it.
- Two posting kinds for it: `ESCROW` and `ESCROW_RELEASE`. A release is not a
  settlement, because "you got your money back" and "the seller was paid" are
  the two outcomes an operator is asked to tell apart six months later.

### Added — credit

- `Loan`s with three amortisation methods — equal instalment, equal principal
  and interest-only — a late-fee rate and a grace period.
- Repayments split fees first, then interest, then capital, and the split always
  adds up to the payment. Capital returns to `system:credit` and interest
  becomes revenue in `system:fee`, so the credit account reaches exactly zero
  when a loan is repaid and its balance always means "currency currently lent".
- `settle_early` / `settleEarly` with a rebate on interest that has not been
  reached yet, `charge_late_fee` / `chargeLateFee`, `is_in_arrears` /
  `isInArrears`, and `write_off` / `writeOff`.
- A write-off books **mint → credit**, not credit → sink. The borrower still has
  what they were lent; it stops being a claim and becomes permanent issuance.
  Sending it to the sink would leave a scope reporting a negative amount in
  circulation.

### Added — interest and schedules

- `accrue_interest` / `accrueInterest` on a compound or simple basis, and
  `amortisation_schedule` / `amortisationSchedule`, which iterates whole units
  rather than using a closed form — because a formula compounds fractions of a
  unit that were never credited to anybody.
- `level_payment` / `levelPayment` finds the instalment by binary search, so it
  is self-consistent with the integer rounding the schedule actually uses.
- Every schedule checks itself before it is returned: each row adds up, the last
  closing balance is zero, and the totals stay inside the range both editions
  can hold.

### Added — investments

- `Instrument`s (share, bond, fund, commodity, collectible) and `Position`s with
  a cost basis, an average cost and a realised gain. Selling everything always
  leaves a cost basis of exactly zero.
- Valuation, portfolios, bond coupons and dividend distribution.
- **Every price is a caller argument.** There is no price model, no volatility
  and no chance anywhere in this module. A bond's coupon is the one payout the
  library can compute unaided, because it is fixed in the bond's own terms.

### Added — markets

- A limit order book with price, then time, then id priority, and no self-trade:
  two orders from one owner never match, because that is how a member
  manufactures a trade history.
- The resting order names the price, so price improvement goes to the arriving
  order.
- `exchange` swaps one currency for another at a rate the caller supplies, as
  **two** postings — a posting balances within one currency and always will.
- Auctions with a minimum increment and a reserve that is either open (a low bid
  is refused as it is placed) or hidden (it is accepted and loses at the close).

### Added — fees and taxes

- `FeeRule`s: flat, proportional, tiered, with a minimum and a maximum, charged
  either on top of an amount or inclusively out of it. An inclusive fee can take
  all of a payment and never more.
- `quote_fee` / `quoteFee` computes what `charge_fee` / `chargeFee` will charge,
  by being the same function — a quote that could differ from the charge would
  be worse than no quote.

### Added — billing

- Subscriptions that catch up: a scheduler that missed three weeks takes one
  payment of three times the amount, and one that runs every minute charges
  once. Pausing subtracts the paused time rather than postponing the bill.
- `finance_purchase` / `financePurchase`: the seller is paid in full today and
  the buyer owes a schedule.
- `run_payroll` / `runPayroll` — one posting with a line each, so half a payroll
  is not a thing that can happen — and `split_payroll` / `splitPayroll` for a
  community that pays out a fixed pot.

### Added — reporting

- `trial_balance` / `trialBalance`, which checks three things at once: does every
  posting balance, do they balance together, and was anything booked twice. The
  duplicate check exists because a sum cannot see a duplicate — two copies of a
  balanced posting still sum to zero, and still gave somebody twice the money.
- `money_supply` / `moneySupply`, `statement_for` / `statementFor`,
  `turnover_by_kind` / `turnoverByKind`, `wealth_distribution` /
  `wealthDistribution`, `gini_permille` / `giniPermille` and `top_holders` /
  `topHolders`.

### Added — rounding

- A `Rounding` mode on every operation that divides: `DOWN`, `UP`, `HALF_UP`,
  `HALF_EVEN`, all symmetric about zero, so the sign of an amount never changes
  how far it is rounded.

### Changed — performance

- `level_payment` / `levelPayment` searches a **proved** bracket instead of "one
  to the whole debt": the lower bound is `principal / periods`, because `n`
  payments must come to at least the principal, and the upper bound is that plus
  one period's interest on the whole principal, which always clears. About six
  bisection steps fewer, and it moves no answer — a twelve-period schedule went
  from 272 µs to 190 µs, and the worst schedule the library will build at all
  (12,000 periods) takes 51 ms.

### Added — the differential harness

`shared/tools/differential/` generates random cases in the bands where the two
editions have any reason to differ, answers them with both, and compares. It
exists because the fixed vectors missed a real divergence, and it has since
found four more:

| Found | Appears when |
|---|---|
| `applyPermille` disagreed by a unit on 821 of 14,443 sampled amounts | the running product passes 2⁵³ |
| `levelPayment` never terminated in TypeScript | `(low + high) / 2` overflows while both ends are safe |
| A schedule's totals were returned by one edition and refused by the other | `totalPaid` leaves the shared range while every instalment stays inside it |
| The Gini coefficient disagreed | `Σ i·xᵢ` passes 2⁵³ with a thousand holders, long before any balance does |
| `divideRounded` returned the wrong quotient | `Math.floor(a / b)` puts the answer on the wrong side of an integer near 2⁵³ |
| `levelPayment` disagreed by a unit | the simulated balance leaves the safe range while the principal, the interest and the answer stay inside it |

Each is now a shared vector as well. `shared/tools/differential/README.md`
explains the harness; `parity.sh` runs it in one command.

### Fixed

- `buy_units` / `buyUnits` allowed a buyer's balance to go negative when they
  bought from the market. Buying from the market is still buying, not borrowing.
- `exchange` allowed a member to sell currency they did not hold.
- `pay_coupon` / `payCoupon` and `exchange` allowed a *named* funding account to
  go negative. The mint issues; a guild treasury paying its own bondholders does
  not.
- Two dead currency checks removed, in `bank` and `credit`: an `AccountRef`
  carries its currency, so the full-ref comparison before them had already
  settled the question.
- `SystemAccount.ESCROW` documented a behaviour the library did not have. It
  does now — see the escrow entry above.
- `money_supply` reported `-0` for an empty scope in the TypeScript edition,
  which serialises as `"-0"` and differed from Python on a value that is not
  actually different.
- **`divideRounded` was not integer division.** `Math.floor(a / b)` is a float
  division and a floor: IEEE rounds the quotient to the nearest *double*, and
  near 2⁵³ the nearest double can sit on the wrong side of an integer. The floor
  then came back one too low and the remainder computed from it was nonsense,
  which every rounding mode but `DOWN` reads. It now corrects the estimate
  exactly, and falls back to BigInt past the point where that correction can
  still be proved. `9007199254737658 / 360` is the case, and it is now a vector.
- **`level_payment` could disagree by a unit near the ceiling.** `balance +
  interest` can leave the range a JavaScript number holds exactly while the
  principal, the interest and the answer all sit inside it — Python kept
  simulating exactly and returned a different payment. Both editions now refuse
  with `RateError` instead.

### Added — cross-edition guarantee

- Nine new vector files — rounding, interest, banking, credit, fees,
  instruments, market, billing, reporting — bringing the shared set to 250 cases
  across sixteen files. Both suites run all of them.
- Property runs over the financial subsystems in both editions: a deposit never
  creates or destroys currency, a repaid loan leaves the credit account at
  exactly zero, a written-off loan is issuance rather than destruction, a fill
  moves only what the fill says, every share of everything adds up to the whole,
  and the books close across every subsystem at once.
- The Python edition is at 100 % statement and branch coverage; the TypeScript
  edition at 99 %.
- `.github/scripts/check-surface.mjs`: a check that the two editions expose the
  same economy. The vectors prove they agree about what they *compute*; nothing
  proved they agree about what they *offer*. It also writes down the shape of a
  complete economy — eighteen areas, 132 names — so a refactor cannot quietly
  drop a subsystem. It found five gaps on its first run: `schedulePeriods`,
  `isFree`, `isSubscriptionActive`, the `MinorUnits` type and `VERSION`, all of
  which existed in Python and not in TypeScript.

## [1.0.0] - 2026-09-05

First release.

### Note on the release itself

This package was built ahead of a named consumer. The concept
(`package-economyworld.md`) sets six conditions before it should be written, and
at the time of this release none were met: no UplyTech product has an economy,
no maintainer is named, and the legal review it asks for has not happened.

That is recorded here rather than glossed over, because it changes how the
version number should be read. The interface is complete, tested and stable to
build against — but it has never met a real caller, and the first product to
adopt it will find things it wants differently.

The scope was drawn conservatively for the same reason: no real money, no
randomness, no gambling mechanics. See the README.

### Added — bookings

- `credit`, `debit` and `transfer`, each producing a complete double-entry
  posting whose lines sum to zero.
- Four system accounts per scope — mint, sink, shop, escrow — that may go
  arbitrarily negative, so newly issued and destroyed currency is accounted for
  rather than appearing and disappearing.
- `reverse()` books the exact inverse of an earlier posting against *current*
  balances, leaving both entries in the audit trail.
- `applyDecay()` / `apply_decay()` with a flat amount and/or a permille share
  per period, charged per whole elapsed period so that running it nightly costs
  the same as running it monthly.

### Added — earning

- Fixed-amount earning rules with per-member cooldowns and period ceilings.
  Both are core parameters: an economy without limits is worthless within days.
- Outcomes rather than exceptions for the normal cases: `COOLDOWN`,
  `PERIOD_CAP`, `RULE_DISABLED`, `UNKNOWN_RULE`, `MAX_BALANCE_REACHED`,
  `NO_AMOUNT`.
- A blocked attempt does **not** restart the cooldown.

### Added — inventory, shop and trade

- Items with a stack limit and a tradable flag; immutable `Inventory` value
  objects where every operation returns a new one.
- Offers with stock, per-member limits and availability windows; a purchase
  returns the payment, the inventory change and the updated stock together.
- A trade state machine — `PROPOSED → ACCEPTED → COMPLETED`, with `CANCELLED`
  and `EXPIRED` as final states. Nothing moves until settlement, so an
  abandoned trade leaves no damage behind. Currency is netted into one posting.

### Added — cross-edition guarantee

- `shared/testcases/` with vectors for money arithmetic, bookings, earning,
  decay, inventory, shop and trade. Both test suites run them.
- Property runs over 1,200 randomised sequences in each edition, proving that
  transfers never change the money supply, that every posting balances whatever
  produced it, and that trades, purchases and reversals conserve value exactly.

### Decisions worth recording

- **Integer minor units everywhere.** No floating point in any amount. Rounding
  drift becomes visible over millions of bookings and makes two editions
  disagree.
- **No randomness at all.** Random payouts are the loot-box mechanism, which
  several EU jurisdictions treat as gambling even without real money. RankMode
  randomises XP deliberately; this package contains no random generator.
- **No storage, and the transaction obligation is stated plainly.** The library
  cannot make the write atomic. The README, the `ledger` module and both
  examples say so in the same words rather than leaving it implied.
- **`InsufficientFunds` is an exception, not an outcome.** A caller who forgets
  to check must not accidentally put a member into debt.
- **Ties to RankMode are cut deliberately.** Points are recognition; balances
  are purchasing power. Mixing them produces two libraries that each do half a
  job.

[2.0.0]: https://github.com/uplytech/economyworld/releases/tag/v2.0.0
[1.0.0]: https://github.com/uplytech/economyworld/releases/tag/v1.0.0
