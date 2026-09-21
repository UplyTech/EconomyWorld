#!/usr/bin/env node
/**
 * Generate random cases for the two editions to disagree about.
 *
 * `shared/testcases/` is a fixed list. A fixed list catches a regression in
 * something somebody already thought of — which is exactly why it did not catch
 * the divergence fixed in 2.0.0, where `applyPermille` returned different
 * numbers in the two editions for 821 of 14,443 sampled amounts. Every vector in
 * the repository worked, because every vector used an amount below a million and
 * the disagreement only begins above 2^53 / 1000.
 *
 * This generator produces cases nobody thought of. It is deliberately biased
 * toward the places where the two editions have any reason to differ at all:
 *
 *   - amounts near 2^53 - 1, where a JavaScript number stops being exact
 *   - rates and factors large enough that `amount * rate` overflows while the
 *     amount, the rate and the answer all stay inside the safe range
 *   - negative amounts, where "round down" means two different things
 *   - splits whose shares cannot come out even, which is where a unit of
 *     currency goes missing
 *   - schedules long enough that a rounding error would compound
 *
 * It computes nothing itself. It only writes the questions; the two runners
 * answer them, and compare.py decides whether the answers agree.
 *
 *   node generate.mjs --seed 1 --cases 2000 --out cases.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Bumped only together with both runners and compare.py. */
const FORMAT_VERSION = 1;

const MAX_BALANCE = 9007199254740991;

// ---------------------------------------------------------------------------
// A deterministic generator, so a red build is always reproducible.
// mulberry32 — the same algorithm RankMode's harness uses.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let random = mulberry32(1);

const pick = (values) => values[Math.floor(random() * values.length)];
const intBetween = (low, high) => low + Math.floor(random() * (high - low + 1));

/**
 * An amount, drawn from a distribution that spends most of its time where the
 * bugs are rather than where the numbers are.
 */
function amount() {
  const band = random();
  if (band < 0.25) return intBetween(0, 1000); // everyday
  if (band < 0.45) return intBetween(0, 1_000_000); // a real community
  if (band < 0.6) return intBetween(0, 4_000_000_000); // large
  if (band < 0.75) return intBetween(0, Math.floor(MAX_BALANCE / 1000)); // wide
  if (band < 0.9) return Math.floor(random() * MAX_BALANCE); // anywhere
  // The last band is the interesting one: right at the edge of exactness.
  return MAX_BALANCE - intBetween(0, 4096);
}

const ROUNDING = ["DOWN", "UP", "HALF_UP", "HALF_EVEN"];

/** A rate in basis points, biased toward the ones that overflow a product. */
function basisPoints() {
  return pick([
    0, 1, 7, 25, 100, 250, 500, 1000, 2500, 10_000,
    // From here up the product passes 2^53 for a large amount.
    50_000, 100_000, 999_999, intBetween(0, 1_000_000),
  ]);
}

// ---------------------------------------------------------------------------
// The case kinds
// ---------------------------------------------------------------------------

/** Rounding, rate application and exact splitting. Finds the 1.x divergence. */
function moneyCase(id) {
  const weights = [];
  for (let i = 0; i < intBetween(1, 8); i += 1) weights.push(intBetween(0, 1000));
  const chain = [];
  for (let i = 0; i < intBetween(1, 3); i += 1) chain.push(intBetween(0, 5000));
  return {
    id,
    kind: "money",
    amount: random() < 0.25 ? -amount() : amount(),
    permilleChain: chain,
    basisPoints: basisPoints(),
    rateNumerator: intBetween(0, 100_000),
    rateDenominator: intBetween(1, 100_000),
    rounding: pick(ROUNDING),
    weights,
    parts: intBetween(1, 12),
  };
}

/** Accrual and amortisation. Every schedule must close in both editions. */
function interestCase(id) {
  return {
    id,
    kind: "interest",
    principal: random() < 0.5 ? intBetween(0, 10_000_000) : amount(),
    rateBasisPoints: basisPoints(),
    periods: pick([0, 1, 2, 3, 12, 24, 60, 120, 360, intBetween(1, 500)]),
    basis: pick(["SIMPLE", "COMPOUND"]),
    method: pick(["EQUAL_INSTALMENT", "EQUAL_PRINCIPAL", "INTEREST_ONLY"]),
    rounding: pick(ROUNDING),
  };
}

/** Fee rules: flat, proportional, tiered, capped, both modes. */
function feeCase(id) {
  const tiers = [];
  if (random() < 0.5) {
    let threshold = 0;
    for (let i = 0; i < intBetween(1, 4); i += 1) {
      tiers.push({ threshold, basisPoints: basisPoints() });
      threshold += intBetween(1, 100_000);
    }
  }
  const minimum = random() < 0.4 ? intBetween(0, 1000) : 0;
  return {
    id,
    kind: "fee",
    amount: amount(),
    mode: pick(["ON_TOP", "INCLUSIVE"]),
    flat: random() < 0.5 ? intBetween(0, 10_000) : 0,
    basisPoints: basisPoints(),
    tiers,
    minimum,
    maximum: random() < 0.3 ? minimum + intBetween(0, 100_000) : null,
    rounding: pick(ROUNDING),
  };
}

/** A whole deposit life: pay in, accrue, withdraw early or late. */
function bankCase(id) {
  const termMs = pick([0, 1000, 86_400_000, 30 * 86_400_000]);
  return {
    id,
    kind: "bank",
    principal: intBetween(0, 100_000_000),
    rateBasisPoints: basisPoints(),
    basis: pick(["SIMPLE", "COMPOUND"]),
    rounding: pick(ROUNDING),
    termMs,
    penaltyBp: termMs === 0 ? 0 : pick([0, 1000, 5000, 10_000]),
    periods: intBetween(0, 40),
    withdrawAt: pick([0, 500, 86_400_001, 40 * 86_400_000]),
    withdraw: intBetween(0, 100_000_000),
  };
}

/** A loan repaid in slices, so the split is exercised at every boundary. */
function creditCase(id) {
  const payments = [];
  for (let i = 0; i < intBetween(1, 10); i += 1) payments.push(intBetween(1, 200_000));
  return {
    id,
    kind: "credit",
    principal: intBetween(1, 10_000_000),
    rateBasisPoints: pick([0, 1, 100, 250, 1000, 5000]),
    periods: pick([1, 2, 6, 12, 24, 60]),
    method: pick(["EQUAL_INSTALMENT", "EQUAL_PRINCIPAL", "INTEREST_ONLY"]),
    rounding: pick(ROUNDING),
    lateFeeBp: pick([0, 100, 500, 2000]),
    gracePeriods: intBetween(0, 3),
    missed: intBetween(0, 4),
    payments,
    rebateBp: pick([0, 2500, 5000, 10_000]),
  };
}

/** Buying and selling units, where the cost basis must clear exactly. */
function instrumentCase(id) {
  const trades = [];
  for (let i = 0; i < intBetween(1, 8); i += 1) {
    trades.push({
      side: random() < 0.6 ? "BUY" : "SELL",
      units: intBetween(1, 10_000),
      unitPrice: intBetween(0, 1_000_000),
    });
  }
  const holders = [];
  for (let i = 0; i < intBetween(1, 6); i += 1) holders.push(intBetween(0, 10_000));
  return {
    id,
    kind: "instrument",
    trades,
    valuationPrice: intBetween(0, 1_000_000),
    faceValue: intBetween(1, 1_000_000),
    couponBp: basisPoints(),
    couponUnits: intBetween(0, 10_000),
    couponPeriods: intBetween(0, 12),
    dividend: intBetween(0, 10_000_000),
    holders,
  };
}

/** An order book, matched in a fixed sequence. Ties are the interesting part. */
function marketCase(id) {
  const orders = [];
  const count = intBetween(2, 12);
  for (let i = 0; i < count; i += 1) {
    orders.push({
      orderId: `o${i}`,
      owner: `m${intBetween(0, 4)}`,
      side: random() < 0.5 ? "BUY" : "SELL",
      // A narrow price band on purpose: it is equal prices that make the
      // tie-break matter, and a wide band would hardly ever produce one.
      unitPrice: intBetween(8, 14),
      quantity: intBetween(1, 100),
      // Many orders share a timestamp, which is the case the id tie-break is
      // there for.
      placedAt: 1_700_000_000_000 + intBetween(0, 3),
    });
  }
  const bids = [];
  for (let i = 0; i < intBetween(0, 6); i += 1) {
    bids.push({
      bidId: `b${i}`,
      bidder: `m${intBetween(0, 4)}`,
      amount: intBetween(1, 10_000),
      placedAt: 1_700_000_000_000 + intBetween(0, 3),
    });
  }
  return {
    id,
    kind: "market",
    orders,
    reserve: intBetween(0, 5000),
    reserveHidden: random() < 0.5,
    minIncrement: intBetween(1, 100),
    bids,
    exchangeAmount: intBetween(1, 10_000_000),
    rateNumerator: intBetween(1, 100_000),
    rateDenominator: intBetween(1, 100_000),
    rounding: pick(ROUNDING),
  };
}

/** Subscriptions caught up after an outage, and a payroll split. */
function billingCase(id) {
  const recipients = intBetween(1, 8);
  return {
    id,
    kind: "billing",
    amountPer: intBetween(1, 100_000),
    intervalMs: pick([1000, 60_000, 86_400_000]),
    occurrences: random() < 0.5 ? intBetween(1, 20) : null,
    elapsedMs: intBetween(0, 40 * 86_400_000),
    pauseAtMs: random() < 0.4 ? intBetween(0, 20 * 86_400_000) : null,
    resumeAtMs: intBetween(0, 40 * 86_400_000),
    payrollTotal: intBetween(0, 10_000_000),
    recipients,
    weights: Array.from({ length: recipients }, () => intBetween(0, 100)),
  };
}

/** Reading a set of postings back: supply, statement, distribution, Gini. */
function reportingCase(id) {
  const balances = [];
  for (let i = 0; i < intBetween(1, 20); i += 1) balances.push(intBetween(0, 10_000_000));
  return {
    id,
    kind: "reporting",
    mints: Array.from({ length: intBetween(1, 6) }, () => intBetween(1, 1_000_000)),
    transfers: Array.from({ length: intBetween(0, 6) }, () => intBetween(1, 100_000)),
    balances,
    limit: intBetween(0, 10),
  };
}

const KINDS = [
  moneyCase,
  interestCase,
  feeCase,
  bankCase,
  creditCase,
  instrumentCase,
  marketCase,
  billingCase,
  reportingCase,
];

// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
  };

  const seed = Number(flag("seed", "1"));
  const count = Number(flag("cases", "2000"));
  const out = flag("out", join(HERE, "cases.json"));

  if (!Number.isInteger(seed) || !Number.isInteger(count) || count < 1) {
    console.error("usage: generate.mjs --seed <int> --cases <int> --out <path>");
    process.exit(2);
  }

  random = mulberry32(seed);

  const cases = [];
  for (let i = 0; i < count; i += 1) {
    cases.push(KINDS[i % KINDS.length](`c${i}`));
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify({ formatVersion: FORMAT_VERSION, seed, cases }, null, 1)}\n`,
    "utf8",
  );
  console.log(`wrote ${cases.length} cases (seed ${seed}) to ${out}`);
}

main();
