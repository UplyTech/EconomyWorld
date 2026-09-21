import { describe, expect, it } from "vitest";
import {
  account,
  accountBalances,
  accountKey,
  assertBooksClose,
  createCurrency,
  createPosting,
  EconomyEngine,
  giniPermille,
  memberAccount,
  moneySupply,
  PostingKind,
  statementFor,
  SystemAccount,
  systemAccount,
  topHolders,
  trialBalance,
  turnoverByKind,
  UnbalancedPostingError,
  ValidationError,
  wealthDistribution,
  type Posting,
} from "../src/index.js";

/** The mirror of `python/tests/test_reporting.py`. */

const NOW = 1_700_000_000_000;

function ref(name: string, scope = "g1", currency = "COIN") {
  return memberAccount(scope, name, currency);
}

function history(): Posting[] {
  const economy = new EconomyEngine({ currencies: [createCurrency({ code: "COIN" })] });
  return [
    economy.credit(account(ref("ada"), 0), 10_000, {
      now: NOW,
      operationId: "m1",
      reason: "welcome",
    }).posting,
    economy.credit(account(ref("bob"), 0), 6_000, {
      now: NOW + 1,
      operationId: "m2",
      reason: "welcome",
    }).posting,
    economy.transfer(account(ref("ada"), 10_000), account(ref("bob"), 6_000), 1_500, {
      now: NOW + 2,
      operationId: "t1",
      reason: "gift",
    }).posting,
    economy.debit(account(ref("bob"), 7_500), 500, {
      now: NOW + 3,
      operationId: "b1",
      reason: "sink",
    }).posting,
  ];
}

describe("trial balance", () => {
  it("closes a healthy ledger", () => {
    const result = trialBalance(history());
    expect(result.postings).toBe(4);
    expect(result.total).toBe(0);
    expect(result.unbalanced).toEqual([]);
    expect(result.duplicates).toEqual([]);
    expect(result.balances).toBe(true);
    expect(() => assertBooksClose(history())).not.toThrow();
  });

  it("closes trivially with no postings", () => {
    expect(trialBalance([]).balances).toBe(true);
    expect(() => assertBooksClose([])).not.toThrow();
  });

  it("catches a posting booked twice by its id", () => {
    // A sum cannot see a duplicate: two balanced copies still sum to zero. And
    // they still gave somebody twice the currency. This is the reason the
    // package insists the operation id be UNIQUE in the caller's database.
    const postings = history();
    const doubled = [...postings, postings[0]!];
    const result = trialBalance(doubled);
    expect(result.total).toBe(0); // the sum notices nothing
    expect(result.duplicates).toEqual(["m1"]);
    expect(result.balances).toBe(false);
    expect(() => assertBooksClose(doubled)).toThrow(ValidationError);
  });

  it("names a posting that does not balance", () => {
    const postings = history();
    const broken: Posting = { ...postings[0]!, lines: postings[0]!.lines.slice(0, 1) };
    expect(() => assertBooksClose([broken])).toThrow(UnbalancedPostingError);
    expect(trialBalance([broken]).unbalanced).toEqual(["m1"]);
  });

  it("replays balances from the postings", () => {
    // Reconciliation: stored balances against what the history implies.
    const balances = accountBalances(history());
    expect(balances[accountKey(ref("ada"))]).toBe(8_500);
    expect(balances[accountKey(ref("bob"))]).toBe(7_000);
    expect(balances[accountKey(systemAccount("g1", "COIN", SystemAccount.Mint))]).toBe(-16_000);
    expect(Object.values(balances).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("sees two postings that hide each other in the total", () => {
    // Two postings each wrong by the same amount in opposite directions add up
    // to zero. The sum says the books close; they do not.
    const posting = (operationId: string, delta: number): Posting => ({
      operationId,
      kind: PostingKind.Transfer,
      scope: "g1",
      currency: "COIN",
      amount: Math.abs(delta),
      reason: "x",
      occurredAt: NOW,
      lines: [{ account: ref("ada"), delta, balanceBefore: 0, balanceAfter: delta }],
      reverses: null,
      metadata: {},
    });
    const pair = [posting("a", 100), posting("b", -100)];
    const result = trialBalance(pair);
    expect(result.total).toBe(0);
    expect(result.unbalanced).toEqual(["a", "b"]);
    expect(result.balances).toBe(false);
    expect(() => assertBooksClose(pair)).toThrow(UnbalancedPostingError);
  });
});

describe("money supply", () => {
  it("reports what was issued, retired and left circulating", () => {
    const supply = moneySupply(history(), "g1", "COIN");
    expect(supply.issued).toBe(16_000);
    expect(supply.retired).toBe(500);
    expect(supply.circulating).toBe(15_500);
  });

  it("has everybody holding what is circulating", () => {
    // The invariant that makes the number trustworthy.
    const supply = moneySupply(history(), "g1", "COIN");
    expect(supply.circulating).toBe(supply.heldByMembers + supply.heldBySystem);
  });

  it("finds no money in a scope with no history", () => {
    const supply = moneySupply(history(), "other-guild", "COIN");
    expect([supply.issued, supply.retired, supply.circulating]).toEqual([0, 0, 0]);
  });

  it("counts another currency separately", () => {
    expect(moneySupply(history(), "g1", "GEM").issued).toBe(0);
  });

  it("counts a fee as held by the system", () => {
    const economy = new EconomyEngine({ currencies: [createCurrency({ code: "COIN" })] });
    const booking = economy.transfer(
      account(ref("ada"), 1_000),
      account(systemAccount("g1", "COIN", SystemAccount.Fee), 0),
      100,
      { now: NOW, operationId: "f1", reason: "fee", kind: PostingKind.Fee },
    );
    const supply = moneySupply([booking.posting], "g1", "COIN");
    expect(supply.heldBySystem).toBe(100);
    expect(supply.heldByMembers).toBe(-100); // nothing was minted in this slice
  });

  it("refuses an empty scope", () => {
    expect(() => moneySupply(history(), "", "COIN")).toThrow(ValidationError);
  });
});

describe("statements", () => {
  it("reads in order with a running balance", () => {
    const statement = statementFor(history(), ref("ada"));
    expect(statement.lines.map((line) => line.delta)).toEqual([10_000, -1_500]);
    expect(statement.lines.map((line) => line.balanceAfter)).toEqual([10_000, 8_500]);
    expect(statement.closingBalance).toBe(8_500);
    expect(statement.totalIn).toBe(10_000);
    expect(statement.totalOut).toBe(1_500);
  });

  it("carries an opening balance forward", () => {
    const statement = statementFor(history(), ref("ada"), 500);
    expect(statement.openingBalance).toBe(500);
    expect(statement.closingBalance).toBe(9_000);
  });

  it("leaves out postings that do not touch the account", () => {
    expect(statementFor(history(), ref("bob")).lines).toHaveLength(3);
    expect(statementFor(history(), ref("nobody")).lines).toEqual([]);
  });

  it("nets a posting that touches the account twice into one line", () => {
    // A member should not have to understand an internal rounding line.
    const posting = createPosting({
      operationId: "x1",
      kind: PostingKind.Transfer,
      scope: "g1",
      currency: "COIN",
      amount: 1_000,
      reason: "split",
      occurredAt: NOW,
      lines: [
        { account: ref("ada"), delta: -1_000, balanceBefore: 5_000, balanceAfter: 4_000 },
        { account: ref("ada"), delta: 40, balanceBefore: 4_000, balanceAfter: 4_040 },
        { account: ref("bob"), delta: 960, balanceBefore: 0, balanceAfter: 960 },
      ],
    });
    const statement = statementFor([posting], ref("ada"));
    expect(statement.lines).toHaveLength(1);
    expect(statement.lines[0]!.delta).toBe(-960);
  });

  it("closes on the replayed balance", () => {
    const postings = history();
    for (const name of ["ada", "bob"]) {
      const replayed = accountBalances(postings)[accountKey(ref(name))];
      expect(statementFor(postings, ref(name)).closingBalance).toBe(replayed);
    }
  });
});

describe("turnover", () => {
  it("totals movement by kind", () => {
    const totals = turnoverByKind(history());
    expect(totals[PostingKind.Credit]).toBe(16_000);
    expect(totals[PostingKind.Transfer]).toBe(1_500);
    expect(totals[PostingKind.Debit]).toBe(500);
  });

  it("totals nothing for no postings", () => {
    expect(turnoverByKind([])).toEqual({});
  });
});

describe("distribution", () => {
  function keyed(balances: Record<string, number>): Record<string, number> {
    return Object.fromEntries(
      Object.entries(balances).map(([name, amount]) => [accountKey(ref(name)), amount]),
    );
  }

  it("describes the shape of a small economy", () => {
    const distribution = wealthDistribution(keyed({ ada: 100, bob: 200, cat: 300 }));
    expect(distribution.holders).toBe(3);
    expect(distribution.total).toBe(600);
    expect(distribution.median).toBe(200);
    expect(distribution.mean).toBe(200);
  });

  it("takes the middle pair as the median of an even count", () => {
    expect(wealthDistribution(keyed({ a: 10, b: 20, c: 30, d: 40 })).median).toBe(25);
  });

  it("leaves system accounts out", () => {
    // The mint holding minus ten million says nothing about equality.
    const balances = {
      ...keyed({ ada: 100, bob: 100 }),
      [accountKey(systemAccount("g1", "COIN", SystemAccount.Mint))]: -200,
    };
    const distribution = wealthDistribution(balances);
    expect(distribution.holders).toBe(2);
    expect(distribution.total).toBe(200);
    expect(distribution.giniPermille).toBe(0);
  });

  it("reports zeroes for an empty economy rather than dividing by none", () => {
    expect(wealthDistribution({})).toEqual({
      holders: 0,
      total: 0,
      median: 0,
      mean: 0,
      giniPermille: 0,
    });
  });

  it("scores perfect equality at zero", () => {
    expect(giniPermille([100, 100, 100, 100])).toBe(0);
    expect(giniPermille([7])).toBe(0);
  });

  it("approaches a thousand for one holder with everything", () => {
    const many = [...Array.from({ length: 999 }, () => 0), 1_000_000];
    expect(giniPermille(many)).toBe(999);
  });

  it("calls an economy with nothing in it equal", () => {
    // Technically true, and better than dividing by the total.
    expect(giniPermille([0, 0, 0])).toBe(0);
    expect(giniPermille([])).toBe(0);
  });

  it("rises as wealth concentrates", () => {
    expect(giniPermille([100, 100, 100, 100])).toBeLessThan(giniPermille([50, 100, 100, 150]));
    expect(giniPermille([50, 100, 100, 150])).toBeLessThan(giniPermille([1, 1, 1, 397]));
  });

  it("does not depend on the order of the balances", () => {
    expect(giniPermille([5, 1, 90, 4])).toBe(giniPermille([90, 5, 4, 1]));
  });

  it("does not overflow on a huge economy", () => {
    // The intermediate sum passes 2^53 long before any balance does, which is
    // why this edition computes the expression in BigInt.
    const balances = Array.from({ length: 1_000 }, (_, index) => 9_000_000_000_000 + index);
    const result = giniPermille(balances);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1_000);
  });

  it("stays on its scale", () => {
    for (const balances of [[1], [0, 1], [1, 2, 3], [1_000_000, 1], [3, 3, 3, 1]]) {
      expect(giniPermille(balances)).toBeGreaterThanOrEqual(0);
      expect(giniPermille(balances)).toBeLessThanOrEqual(1_000);
    }
  });
});

describe("top holders", () => {
  function keyed(balances: Record<string, number>): Record<string, number> {
    return Object.fromEntries(
      Object.entries(balances).map(([name, amount]) => [accountKey(ref(name)), amount]),
    );
  }

  it("lists the largest first", () => {
    const holders = topHolders(keyed({ ada: 100, bob: 300, cat: 200 }));
    expect(holders.map(([, amount]) => amount)).toEqual([300, 200, 100]);
  });

  it("breaks a tie by the account key", () => {
    // A leaderboard whose joint-third moves every draw looks broken.
    const first = topHolders(keyed({ zoe: 100, ada: 100 }));
    expect(first).toEqual(topHolders(keyed({ ada: 100, zoe: 100 })));
    expect(first[0]![0] < first[1]![0]).toBe(true);
  });

  it("honours the limit", () => {
    expect(topHolders(keyed({ a: 1, b: 2, c: 3, d: 4 }), 2)).toHaveLength(2);
    expect(topHolders(keyed({ a: 1 }), 0)).toEqual([]);
  });

  it("never shows a system account", () => {
    const balances = {
      ...keyed({ ada: 100 }),
      [accountKey(systemAccount("g1", "COIN", SystemAccount.Fee))]: 999_999,
    };
    expect(topHolders(balances).map(([key]) => key)).toEqual([accountKey(ref("ada"))]);
  });

  it("refuses a negative limit", () => {
    expect(() => topHolders({}, -1)).toThrow(ValidationError);
  });
});
