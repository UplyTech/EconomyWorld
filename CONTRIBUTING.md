# Contributing to EconomyWorld

Thank you for looking. This library holds other people's balances, so the rules
below are stricter than they would be for most packages.

## The rule that matters most

> **A posting's lines must always sum to zero, and every change must be
> expressible as one indivisible booking.**

If a change you are making cannot be expressed that way, it does not belong in
this library. That is not a style preference: double-entry is the only reason
"no currency appeared from nowhere" is something a caller can *check* rather
than assume.

The corollary: never add an API that returns a partial change. A purchase
returns the payment, the inventory change and the new stock **together**,
because a caller who gets them separately will eventually write one and not the
other.

## Change classification

| Change | Version bump |
|---|---|
| Bug fix with no behaviour change | patch |
| Security fix | patch, back-ported to the previous major |
| New booking kind, new option, new helper | minor |
| **Any change to what a booking computes** | **major** |
| Any change to how a balance is derived | major |
| Removing or renaming anything public | major, deprecated one minor beforehand |

A balance that changes because the library changed is a support ticket for every
operator using it. Treat it as such.

## Both editions, or neither

EconomyWorld ships a Python and a TypeScript edition that must behave
identically. A pull request that changes behaviour in one and not the other will
not be merged, even if both suites are green — the shared vectors would simply
not be covering the thing you changed yet.

1. Change the behaviour in **both** `python/src/economyworld/` and
   `typescript/src/`.
2. Add a case under `shared/testcases/` — see below.
3. Run both suites.
4. Run `node .github/scripts/check-surface.mjs`.

Step 4 catches the half of the promise the vectors do not. They prove the two
editions agree about what they **compute**; nothing else proves they agree about
what they **offer**, and a caller porting a bot from Python to Node finds a
missing function at the worst possible moment. Five such gaps were found by hand
while writing 2.0.0, which is five more than anybody should find by hand.

A new public name therefore goes in both editions, spelled the way each language
spells things. There is exactly one deliberate exception — Python's
`make_account` is TypeScript's `account` — and it is recorded in that script,
with its reason, so that a second one cannot appear by accident.

## Changing the shared test vectors

The vectors are the contract between the editions. They are generated from the
TypeScript edition:

```bash
cd typescript
npm run build
node scripts/generate-shared-vectors.mjs
```

**Regenerating is a deliberate act.** If a file changes, the behaviour of the
library changed, and that belongs in `CHANGELOG.md` with the matching version
bump.

> Never regenerate the vectors to make a failing test pass. A failing vector is
> the system working: it is telling you the two editions have drifted apart, or
> that you changed something you did not mean to. Find out which first.

## The property tests are not optional

Both editions run property tests over thousands of randomised sequences. They
exist because example-based tests are not enough for an economy: the bug that
creates a coin is usually in a rounding step, a clamp or an early return that
nobody would have written an example for.

If you add a booking kind, add it to the mixed-sequence run. If you change how
amounts are computed, the runs must still show:

- transfers never change the money supply
- every posting balances, whatever produced it
- trades, purchases and reversals conserve value exactly
- a deposit never creates or destroys currency, and the bank account holds
  exactly what is on deposit
- a loan repaid in full leaves the credit account at exactly zero, with the
  interest in the fee account and not a unit of it in credit
- a written-off loan is recognised as issuance, so circulation never goes
  negative
- every share of every split — a fee, a dividend, a payroll pot — adds up to the
  whole
- the books close across every subsystem at once

A change that needs one of those relaxed is a change that is wrong.

### And the differential harness

The property runs check one edition against itself. The harness in
[`shared/tools/differential/`](shared/tools/differential/README.md) checks the
two editions against **each other**, on cases nobody wrote down:

```bash
cd typescript && npm run build && cd ..
bash shared/tools/differential/parity.sh 1 20000
```

Run it after any change to arithmetic. It exists because the fixed vectors
missed a real divergence — every vector used an amount below a million, and the
disagreement only began above 2⁵³ / 1000 — and it has since found five more. If
it finds something, add the printed case to `shared/testcases/` before fixing
the cause.

## Running everything

```bash
# Python
cd python
python -m venv .venv
.venv/bin/pip install -e ".[dev]"              # Windows: .venv\Scripts\pip
.venv/bin/python -m pytest --cov=economyworld  # coverage gate: 95 %
.venv/bin/python -m mypy                       # strict
.venv/bin/python -m ruff check .

# TypeScript
cd typescript
npm install
npm test
npm run test:coverage                          # coverage gate: 95 %
npm run typecheck
npm run lint
npm run build
```

Both editions' examples should also still run — and
`financial_system.py` / `financial-system.ts` must print **byte-identical**
output, which is the shortest end-to-end proof that the editions agree:

```bash
cd python     && PYTHONPATH=src .venv/bin/python examples/financial_system.py > /tmp/py.txt
cd typescript && npx vite-node examples/financial-system.ts > /tmp/ts.txt
diff /tmp/py.txt /tmp/ts.txt        # must be empty
```

## What belongs in this library

Before adding a feature, check it against the boundaries:

- **No storage.** Not a cache, not an optional repository interface. The caller
  owns balances, postings and inventories.
- **No transaction handling.** The library cannot make a write atomic, and
  pretending otherwise would be worse than saying so.
- **No platform knowledge.** No Discord, no HTTP, no guild, no interaction.
- **No display.** `splitMinorUnits` returns numbers, not a formatted string.
  Formatting is a locale decision and belongs to the caller.
- **No floating point.** Anywhere. Every amount is an integer in the smallest
  unit, every factor is a permille integer.
- **No randomness.** Anywhere. See the next section.
- **No experience points or levels, and no competitive rank either.** Both are
  [RankMode](../RankMode) — participation on one side, competition on the other —
  and they are kept apart from a balance deliberately.
- **No logging.** The library sees identifiers in a call and forgets them.

### The gambling boundary

This one is not a design preference, so it is not open to a pull request:

**EconomyWorld contains no random generator, and will not gain one.**

Random payouts are the mechanism behind loot boxes, which several EU
jurisdictions treat as gambling *even without real money involved*. Wagering
between members and slot-machine mechanics are the same category. A product that
wants any of these builds them itself and gets them legally reviewed itself.

The same applies to anything that would give the currency a real-world value:
buying balance for money, cashing out, or exchanging into a real currency.

**Where the markets sit relative to that line.** Since 2.0.0 the library has an
order book, an auction house and a currency exchange, and none of them crosses
it, for one reason: *every price is an argument*. The library matches, settles
and books at prices the caller names. It has no price generator, no volatility,
no drift and no chance — a generated price would be a random payout wearing a
different hat, which is the thing this section exists to exclude. `exchange`
swaps one play currency for another at a rate the caller supplies; it has never
heard of a real one.

A pull request that adds a price *model* — anything that makes a number up, however
plausibly — is on the wrong side of the line even though it looks like a market
feature.

If you believe a feature is on the right side of that line, open an issue and
argue it there before writing code.

## Code style

- **Integers only** in anything that affects a balance.
- **New public behaviour needs a shared vector.** A feature tested in only one
  edition is a feature that will drift.
- **Comments explain decisions, not mechanics.** `# floor division` is noise;
  `# Floor, so a member is never pushed into the next level` is the reason
  somebody will need in two years.
- Python: `ruff` and `mypy --strict` clean. TypeScript: `eslint` and
  `tsc --noEmit` clean.

## Reporting a bug

The most useful bug report contains the numbers:

- the currency configuration
- the balances of every account involved, before the call
- the exact call, including `now` and `operation_id`
- the posting you got back, or the exception
- what you expected instead

With those, the failure becomes a case in `shared/testcases/`, which is where
every fixed bug in this library ends up.

If a member ended up with a balance you cannot explain, include the postings
around it. Nine times out of ten the answer is a write that was not in a
transaction — and the tenth is a bug worth finding.

## Security

Please do not open a public issue for a security problem. See
[SECURITY.md](./SECURITY.md).
