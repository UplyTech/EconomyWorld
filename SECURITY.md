# Security Policy

## Reporting a vulnerability

Please report security issues privately to **<security@uplytech.de>** rather than
in a public issue.

| | |
|---|---|
| First response | within 48 hours |
| Fix or mitigation plan | within 5 working days |
| Disclosure | coordinated, after a fix is available |

Include the currency configuration, the balances before the call, and the exact
sequence that demonstrates the problem. Reproduction steps matter more than
severity claims.

## What counts as a vulnerability here

EconomyWorld holds no credentials, opens no sockets and stores no data. The
interesting failures are of one kind: **currency existing that should not, or
disappearing that should not.** Specifically:

- Any input for which a posting's lines do not sum to zero.
- A sequence that changes the sum of all balances when only transfers happened.
- A way to bypass an earning cooldown or period ceiling.
- A balance that can be pushed outside the safe integer range, or made to wrap.
- A purchase or trade that moves items without moving the matching currency, or
  the other way round.
- A trade that can be settled twice, settled after expiry, or settled from a
  state that should not allow it.
- Any difference between the Python and the TypeScript edition that a member
  could exploit by moving between two of an operator's communities.
- A denial of service from a plausible input.

Since 2.0.0, with the financial subsystems, the same kind again:

- A repayment split that does not add up to the payment, or that puts interest
  where capital belongs — the credit account then reports lending that does not
  exist.
- A loan whose write-off recognises the wrong amount, in either direction.
- A withdrawal that takes more than is on deposit, or a penalty that can exceed
  the interest earned and eat into a member's principal.
- A hold that reserves nothing, or that can be captured for more than it holds:
  both let one balance be spent twice.
- Two orders from the same owner matching each other, which is how a member
  manufactures a trade history or moves a balance without a transfer showing up.
- An order book whose tie-break depends on iteration order, so the same book
  produces different fills.
- A subscription that charges twice for one interval, or that charges for time
  spent paused.
- A fee that exceeds the payment it is taken from, or a split — a fee, a
  dividend, a payroll pot — whose shares do not add up to the whole.

## What is not a vulnerability

- **A caller writing a posting without a transaction.** The library cannot
  prevent this and says so in the README, in `ledger`, and in both examples.
  It is the caller's obligation.
- **A duplicate booking from a missing `UNIQUE` constraint** on `operation_id`.
  Same reason: the library stores nothing and cannot detect it.
  `InMemoryOperationLog` is documented as a test helper, not a guarantee.
- **Inflation from a badly configured economy.** A rule with no cooldown and no
  ceiling will be farmed; the library will do as it was told. The same goes for
  a deposit rate that outruns everything else in the economy, or a loan issued
  without a credit limit — `assert_within_credit_limit` exists, and the limit is
  the caller's to set.
- **A price a community regrets.** Every price in the market and instrument
  modules is a caller argument. The library will settle a trade at any price it
  is given, because inventing one would be worse.
- Anything involving the caller's own database or Discord permissions.

## Notes for operators

These are the mistakes that actually cause incidents, in order of how often:

1. **Write the whole posting in one transaction.** Every line, plus the posting
   row itself. This is the single largest source of balances that cannot be
   explained afterwards.

2. **Make `operation_id` a `UNIQUE` column, and derive it from the request.**
   A message id, an interaction id, a job id — something a retry reproduces. An
   id from `uuid4()` looks fine and defeats the entire mechanism.

3. **Set a cooldown and a period ceiling on every earning rule.** They are core
   parameters for a reason. An economy without limits is worthless within days,
   and re-basing a community's balances afterwards is not a pleasant week.

4. **Decide once whether you store system accounts.** If you do, load and pass
   them on every call. If you do not, ignore the system lines' before/after
   values. Mixing the two writes wrong system balances — harmless to members,
   but it destroys your ability to audit the money supply.

5. **Place a hold when you take an order or a bid, and release it when you do
   not.** Without holds a member can place an order, bid in an auction and buy
   from a shop with one balance, and two of the three fail at settlement — after
   everybody has been told they succeeded.

6. **Run `trial_balance` on a schedule and act on what it says.** It checks for
   duplicate operation ids as well as for balance, and a duplicate is the one
   failure a sum cannot see: two copies of a balanced posting still sum to zero,
   and still gave somebody twice the currency.

## A note on scope

This package deliberately contains no randomness, no wagering, no crates, no
real-money handling and no way to give the currency an external value. Those
exclusions are part of the security posture, not just the feature set: each one
is a legal exposure that a community bot should not acquire by accident.

The markets added in 2.0.0 do not change that. There is no price model anywhere:
the library matches, values and settles at prices the caller supplies, and a
generated price would be a random payout under another name. See the README and
CONTRIBUTING.

## Supported versions

| Version | Supported |
|---|---|
| 2.x | yes |
| 1.x | security fixes only, until 9 March 2027 |

Security fixes ship as a patch release and are back-ported to the previous major
version for six months after a new major is released.
