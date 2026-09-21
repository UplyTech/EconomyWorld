import { describe, it, expect } from "vitest";
import {
  accountKey,
  createCurrency,
  createPosting,
  deserializePosting,
  EconomyEngine,
  emptyAccount,
  InMemoryOperationLog,
  isBalanced,
  assertBalanced,
  isSystemAccount,
  memberAccount,
  netChange,
  parseAccountKey,
  PostingKind,
  resultingBalances,
  sameAccount,
  serializePosting,
  splitMinorUnits,
  SystemAccount,
  systemAccount,
  UnbalancedPostingError,
  ValidationError,
  ConfigurationError,
  InvalidAmountError,
  MAX_BALANCE,
  account,
  applyPermille,
  assertWholeAmount,
  assertPositiveAmount,
} from "../src/index.js";

const SCOPE = "guild-1";
const COIN = "COIN";
const NOW = 1_700_000_000_000;

describe("currencies", () => {
  it("defaults to whole units", () => {
    const currency = createCurrency({ code: COIN });
    expect(currency.minorUnits).toBe(0);
    expect(currency.name).toBe(COIN);
    expect(currency.symbol).toBe(COIN);
    expect(currency.maxBalance).toBe(MAX_BALANCE);
  });

  it("carries display metadata the caller supplies", () => {
    const currency = createCurrency({
      code: "GLD",
      name: "Gold",
      symbol: "G",
      minorUnits: 2,
      maxBalance: 1_000_000,
    });
    expect(currency.name).toBe("Gold");
    expect(currency.minorUnits).toBe(2);
  });

  it("rejects impossible currencies", () => {
    expect(() => createCurrency({ code: "" })).toThrow(ConfigurationError);
    expect(() => createCurrency({ code: "X", minorUnits: -1 })).toThrow(ConfigurationError);
    expect(() => createCurrency({ code: "X", minorUnits: 9 })).toThrow(ConfigurationError);
    expect(() => createCurrency({ code: "X", maxBalance: 0 })).toThrow(ConfigurationError);
    expect(() => createCurrency({ code: "X", maxBalance: MAX_BALANCE + 10 })).toThrow(
      ConfigurationError,
    );
  });

  it("splits minor units without losing the sign", () => {
    const currency = createCurrency({ code: "GLD", minorUnits: 2 });
    expect(splitMinorUnits(1234, currency)).toEqual({
      negative: false,
      whole: 12,
      fraction: 34,
    });
    expect(splitMinorUnits(-1234, currency)).toEqual({
      negative: true,
      whole: 12,
      fraction: 34,
    });
    expect(splitMinorUnits(5, currency)).toEqual({
      negative: false,
      whole: 0,
      fraction: 5,
    });
  });

  it("applies permille factors with floor division, in order", () => {
    expect(applyPermille(100, [])).toBe(100);
    expect(applyPermille(100, [1500])).toBe(150);
    expect(applyPermille(7, [1500, 1100])).toBe(11);
    expect(applyPermille(7, [1100, 1500])).toBe(10);
    expect(() => applyPermille(10, [-1])).toThrow(InvalidAmountError);
  });

  it("refuses amounts that are not whole minor units", () => {
    expect(() => assertWholeAmount(1.5)).toThrow(InvalidAmountError);
    expect(() => assertPositiveAmount(0)).toThrow(InvalidAmountError);
    expect(() => assertPositiveAmount(-1)).toThrow(InvalidAmountError);
    expect(() => assertWholeAmount(0)).not.toThrow();
  });
});

describe("account references", () => {
  it("builds member and system references", () => {
    const member = memberAccount(SCOPE, "ana", COIN);
    expect(member).toEqual({ scope: SCOPE, owner: "ana", currency: COIN });
    expect(isSystemAccount(member)).toBe(false);

    const mint = systemAccount(SCOPE, COIN, SystemAccount.Mint);
    expect(mint.owner).toBe("system:mint");
    expect(isSystemAccount(mint)).toBe(true);
  });

  it("round-trips through a key", () => {
    const ref = memberAccount(SCOPE, "ana", COIN);
    expect(accountKey(ref)).toBe("guild-1/ana/COIN");
    expect(parseAccountKey(accountKey(ref))).toEqual(ref);
  });

  it("compares references", () => {
    expect(sameAccount(memberAccount(SCOPE, "ana", COIN), memberAccount(SCOPE, "ana", COIN))).toBe(true);
    expect(sameAccount(memberAccount(SCOPE, "ana", COIN), memberAccount(SCOPE, "ben", COIN))).toBe(false);
  });

  it("keeps the key parseable by refusing separators in the parts", () => {
    expect(() => memberAccount("a/b", "ana", COIN)).toThrow(ValidationError);
    expect(() => memberAccount(SCOPE, "a/b", COIN)).toThrow(ValidationError);
    expect(() => memberAccount(SCOPE, "ana", "a/b")).toThrow(ValidationError);
    expect(() => parseAccountKey("too/few")).toThrow(ValidationError);
  });

  it("refuses a member id that impersonates a system account", () => {
    expect(() => memberAccount(SCOPE, "system:mint", COIN)).toThrow(ValidationError);
  });

  it("refuses empty parts", () => {
    expect(() => memberAccount("", "ana", COIN)).toThrow(ValidationError);
  });

  it("treats a member with no row as a zero balance", () => {
    const ref = memberAccount(SCOPE, "new-member", COIN);
    expect(emptyAccount(ref).balance).toBe(0);
    expect(account(ref, 500).balance).toBe(500);
    expect(() => account(ref, 1.5)).toThrow(ValidationError);
  });
});

describe("postings", () => {
  const ana = memberAccount(SCOPE, "ana", COIN);
  const ben = memberAccount(SCOPE, "ben", COIN);

  const validPosting = () =>
    createPosting({
      operationId: "op-1",
      kind: PostingKind.Transfer,
      scope: SCOPE,
      currency: COIN,
      amount: 100,
      reason: "gift",
      occurredAt: NOW,
      lines: [
        { account: ana, delta: -100, balanceBefore: 500, balanceAfter: 400 },
        { account: ben, delta: 100, balanceBefore: 0, balanceAfter: 100 },
      ],
    });

  it("accepts a balanced posting", () => {
    const posting = validPosting();
    expect(isBalanced(posting)).toBe(true);
    expect(() => assertBalanced(posting)).not.toThrow();
    expect(posting.reverses).toBeNull();
  });

  it("refuses a posting whose lines do not sum to zero", () => {
    expect(() =>
      createPosting({
        operationId: "op-2",
        kind: PostingKind.Transfer,
        scope: SCOPE,
        currency: COIN,
        amount: 100,
        reason: "broken",
        occurredAt: NOW,
        lines: [
          { account: ana, delta: -100, balanceBefore: 500, balanceAfter: 400 },
          { account: ben, delta: 50, balanceBefore: 0, balanceAfter: 50 },
        ],
      }),
    ).toThrow(UnbalancedPostingError);
  });

  it("refuses a line whose arithmetic does not add up", () => {
    expect(() =>
      createPosting({
        operationId: "op-3",
        kind: PostingKind.Transfer,
        scope: SCOPE,
        currency: COIN,
        amount: 100,
        reason: "broken",
        occurredAt: NOW,
        lines: [
          { account: ana, delta: -100, balanceBefore: 500, balanceAfter: 999 },
          { account: ben, delta: 100, balanceBefore: 0, balanceAfter: 100 },
        ],
      }),
    ).toThrow(ValidationError);
  });

  it("refuses a single-line posting", () => {
    expect(() =>
      createPosting({
        operationId: "op-4",
        kind: PostingKind.Credit,
        scope: SCOPE,
        currency: COIN,
        amount: 0,
        reason: "nothing",
        occurredAt: NOW,
        lines: [{ account: ana, delta: 0, balanceBefore: 0, balanceAfter: 0 }],
      }),
    ).toThrow(ValidationError);
  });

  it("refuses lines from another scope or currency", () => {
    const other = memberAccount("guild-2", "ben", COIN);
    expect(() =>
      createPosting({
        operationId: "op-5",
        kind: PostingKind.Transfer,
        scope: SCOPE,
        currency: COIN,
        amount: 100,
        reason: "cross-scope",
        occurredAt: NOW,
        lines: [
          { account: ana, delta: -100, balanceBefore: 500, balanceAfter: 400 },
          { account: other, delta: 100, balanceBefore: 0, balanceAfter: 100 },
        ],
      }),
    ).toThrow(ValidationError);

    const gold = memberAccount(SCOPE, "ben", "GLD");
    expect(() =>
      createPosting({
        operationId: "op-6",
        kind: PostingKind.Transfer,
        scope: SCOPE,
        currency: COIN,
        amount: 100,
        reason: "cross-currency",
        occurredAt: NOW,
        lines: [
          { account: ana, delta: -100, balanceBefore: 500, balanceAfter: 400 },
          { account: gold, delta: 100, balanceBefore: 0, balanceAfter: 100 },
        ],
      }),
    ).toThrow(ValidationError);
  });

  it("refuses missing metadata that an audit trail needs", () => {
    const base = {
      kind: PostingKind.Transfer,
      scope: SCOPE,
      currency: COIN,
      amount: 100,
      occurredAt: NOW,
      lines: [
        { account: ana, delta: -100, balanceBefore: 500, balanceAfter: 400 },
        { account: ben, delta: 100, balanceBefore: 0, balanceAfter: 100 },
      ],
    };
    expect(() => createPosting({ ...base, operationId: "", reason: "x" })).toThrow(ValidationError);
    expect(() => createPosting({ ...base, operationId: "op", reason: "" })).toThrow(ValidationError);
    expect(() =>
      createPosting({ ...base, operationId: "op", reason: "x", occurredAt: Number.NaN }),
    ).toThrow(ValidationError);
  });

  it("reports what it did to one account", () => {
    const posting = validPosting();
    expect(netChange(posting, ana)).toBe(-100);
    expect(netChange(posting, ben)).toBe(100);
    expect(netChange(posting, memberAccount(SCOPE, "cai", COIN))).toBe(0);
  });

  it("reports the resulting balances", () => {
    expect(resultingBalances(validPosting())).toEqual({
      "guild-1/ana/COIN": 400,
      "guild-1/ben/COIN": 100,
    });
  });

  it("round-trips through JSON, re-checking every rule", () => {
    const posting = validPosting();
    const restored = deserializePosting(JSON.parse(JSON.stringify(serializePosting(posting))));
    expect(restored.operationId).toBe(posting.operationId);
    expect(restored.amount).toBe(posting.amount);
    expect(restored.lines).toEqual(posting.lines);
  });

  it("refuses stored data it cannot trust", () => {
    expect(() => deserializePosting(null)).toThrow(ValidationError);
    expect(() => deserializePosting({ operationId: "x" })).toThrow(ValidationError);
  });

  it("freezes its metadata", () => {
    expect(Object.isFrozen(validPosting().metadata)).toBe(true);
  });
});

describe("InMemoryOperationLog", () => {
  it("recognises a repeat", () => {
    const log = new InMemoryOperationLog();
    expect(log.isNew("op-1")).toBe(true);
    expect(log.record("op-1")).toBe(true);
    expect(log.isNew("op-1")).toBe(false);
    expect(log.record("op-1")).toBe(false);
    expect(log.size).toBe(1);
  });

  it("can be emptied", () => {
    const log = new InMemoryOperationLog();
    log.record("op-1");
    log.clear();
    expect(log.isNew("op-1")).toBe(true);
  });
});

describe("engine configuration", () => {
  it("needs at least one currency", () => {
    expect(() => new EconomyEngine({ currencies: [] })).toThrow(ConfigurationError);
  });

  it("accepts a bare currency code", () => {
    const engine = new EconomyEngine({ currencies: [{ code: COIN }] });
    expect(engine.currency(COIN).minorUnits).toBe(0);
  });

  it("rejects duplicate currencies", () => {
    expect(
      () => new EconomyEngine({ currencies: [{ code: COIN }, { code: COIN }] }),
    ).toThrow(ConfigurationError);
  });

  it("reports an unknown currency clearly", () => {
    const engine = new EconomyEngine({ currencies: [{ code: COIN }] });
    expect(() => engine.currency("NOPE")).toThrow(/Unknown currency: NOPE/);
  });
});
