# Differential harness

`shared/testcases/` is a fixed list. This is not.

## Why it exists

The shared vectors are the contract between the two editions, and they work.
They also missed a divergence that lived in the library for the whole of 1.x,
because of what they are: a list of cases somebody sat down and wrote.

`applyPermille` returned different numbers in the two editions for **821 of
14,443** sampled amounts. Every vector in the repository passed, because every
vector used an amount below a million and the disagreement only begins above
2⁵³ / 1000. The inputs were inside the safe range. The answers were inside the
safe range. Only the *intermediate product* was not, so there was no oversized
value anywhere for a guard to notice.

A fixed list catches a regression in something somebody already imagined. This
catches the rest. Over the 2.0.0 work it found six, in order:

| Divergence | Appears when |
|---|---|
| `applyPermille` disagreed by a unit | the running product passes 2⁵³ |
| `levelPayment` never terminated in TypeScript | `(low + high) / 2` overflows while both ends are safe |
| A schedule's totals were returned by one edition and refused by the other | `totalPaid` leaves the shared range while every instalment stays inside it |
| The Gini coefficient disagreed | `Σ i·xᵢ` passes 2⁵³ with a thousand holders, long before any balance does |
| `divideRounded` returned the wrong quotient | `Math.floor(a / b)` puts the answer on the wrong side of an integer near 2⁵³ |
| `levelPayment` disagreed by a unit | the simulated balance leaves the safe range while the principal, the interest and the answer stay inside it |

Each of those is now a vector in `shared/testcases/` as well, which is what
should happen to every case this finds.

## Running it

```bash
cd typescript && npm run build && cd ..
bash shared/tools/differential/parity.sh          # seed 1, 5000 cases
bash shared/tools/differential/parity.sh 7 50000  # a specific seed and size
```

Nothing in the repository is written; everything lands in a scratch directory.
`PYTHON=...` picks the interpreter, `PARITY_WORK_DIR=...` the scratch directory.

## The parts

| File | Does |
|---|---|
| `generate.mjs` | Writes the questions. Computes nothing itself. |
| `run-typescript.mjs` | Answers them with the **built** TypeScript package. |
| `run_python.py` | Answers them with the Python edition. |
| `compare.py` | Decides whether the answers agree, and prints the smallest case that reproduces a disagreement. |
| `parity.sh` | All four, in order. |

Two things about that split are deliberate:

**The runners mirror each other line for line.** A difference between them is a
difference in the *harness*, not in the library, and that is the one kind of
false positive that would make nobody trust the red build.

**The comparison runs in Python.** Python parses a JSON integer exactly at any
size; `JSON.parse` in Node does not. A comparison that silently rounded both
sides before comparing them would report agreement about precisely the thing
this harness exists to disagree about.

## What it generates

Nine kinds of case, one per place where an amount meets a rate:

| Kind | Covers |
|---|---|
| `money` | Permille chains, basis points, exact splits, minor-unit formatting. |
| `interest` | Accrual on both bases, level payments, whole amortisation schedules under all three methods. |
| `fee` | Flat, proportional and tiered rules, inclusive and on top, every rounding mode. |
| `bank` | Deposit, accrue, withdraw, and the penalty on an early withdrawal. |
| `credit` | A whole loan: disbursement, repayments to settlement, early settlement with a rebate, write-off. |
| `instrument` | Buying and selling a position, the cost released, the gain realised, coupons and dividends. |
| `market` | Order matching with every tie-break, and exchange at a caller's rate under every rounding mode. |
| `billing` | Subscription catch-up across gaps, financed purchases, payroll splits. |
| `reporting` | Money supply, the Gini coefficient, distribution and leaderboards. |

Magnitudes are drawn from a distribution that spends most of its time where bugs
are rather than where numbers are:

- everyday amounts, and amounts across a real community's range
- amounts anywhere in the safe range
- **amounts within 4096 of 2⁵³ − 1**, which is the last band and the interesting
  one
- one either side of every cap, floor, threshold and tier boundary
- **rates large enough that `amount × rate` passes 2⁵³ while the amount, the
  rate and the answer all stay comfortably inside it.** That is the shape of
  every divergence in the table above, and a uniform draw would almost never
  produce it.
- terms long enough that a rounding error has room to compound: a schedule of
  hundreds of periods, a subscription that missed a hundred charges

The `credit` kind is the one that carries state forward, and therefore the only
one that can find a divergence which needs twenty repayments before it is a
whole unit of currency. The `market` kind deliberately submits orders that tie
on price and on time, because a book whose ties depend on iteration order is not
reproducible and would not be caught by any single-order case.

An error is an answer too. Both editions must agree about what they *refuse* as
well as about what they compute, so a raised error is compared by class name —
which is how a validation asymmetry between the editions shows up here rather
than in somebody's bot.

## Reading a failure

```text
::error::the editions disagree on 6 of 2000 cases

--- c61  (money) ----------------------------------------------
  .value.applied
      python     270215977642190250
      typescript 270215977642190240

  the case, for shared/testcases/:
  { "id": "c61", "kind": "money", "amount": 9007199254739675, ... }
```

The path names the exact field. Python's answer is on top because Python's
integers are exact, so its answer is the definition of correct wherever the two
differ by rounding.

The printed case is meant to be moved: add it to `shared/testcases/` so the
specific failure is pinned forever, then fix the cause. That is what happened to
all six divergences above, and it is where every fixed bug in this library ends
up.

## In CI

| Workflow | Runs |
|---|---|
| `ci.yml` → `parity` | Seed 1, 20,000 cases, on every push and pull request. Deterministic, so a red build is one command to reproduce. |
| `security.yml` → `parity-fuzz` | A **random** seed, 200,000 cases, nightly. This is the one that goes looking; the seed is printed so a failure is reproducible. |

## Adding a case kind

1. A generator function in `generate.mjs`, added to `KINDS`.
2. A branch in `answer()` in **both** runners, emitting the same keys in the
   same order.
3. Nothing in `compare.py` — it walks whatever shape it is given.

Keep the two runners readable side by side. That is worth more than either of
them being idiomatic on its own.
