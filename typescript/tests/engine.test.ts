import { describe, it, expect } from "vitest";
import {
  account,
  accountKey,
  BalanceOverflowError,
  cloneEarnState,
  ConfigurationError,
  createEarnRule,
  createEarnState,
  createCurrency,
  CurrencyMismatchError,
  deserializeEarnState,
  EarnOutcome,
  EconomyEngine,
  emptyAccount,
  InsufficientFundsError,
  InvalidAmountError,
  memberAccount,
  PostingKind,
  ReversalError,
  serializeEarnState,
  SystemAccount,
  systemAccount,
  ValidationError,
  type DecayRule,
} from "../src/index.js";

const SCOPE = "guild-1";
const COIN = "COIN";
const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ANA = memberAccount(SCOPE, "ana", COIN);
const BEN = memberAccount(SCOPE, "ben", COIN);

function engine(overrides: Partial<ConstructorParameters<typeof EconomyEngine>[0]> = {}) {
  return new EconomyEngine({
    currencies: [createCurrency({ code: COIN, maxBalance: 1_000_000 })],
    earnRules: [
      createEarnRule({
        key: "message",
        amount: 10,
        currency: COIN,
        cooldownSeconds: 60,
        periodCapAmount: 100,
      }),
    ],
    ...overrides,
  });
}

const options = (operationId: string, now = NOW) => ({
  now,
  operationId,
  reason: "test",
});

describe("credit", () => {
  it("issues currency and balances against the mint", () => {
    const result = engine().credit(emptyAccount(ANA), 500, options("op-1"));
    expect(result.posting.kind).toBe(PostingKind.Credit);
    expect(result.posting.lines).toHaveLength(2);
    expect(result.balances["guild-1/ana/COIN"]).toBe(500);
    // The mint goes negative by exactly what it issued -- that is the record of
    // how much currency exists.
    expect(result.balances["guild-1/system:mint/COIN"]).toBe(-500);
  });

  it("always produces a balanced posting", () => {
    const result = engine().credit(emptyAccount(ANA), 500, options("op-1"));
    expect(result.posting.lines.reduce((sum, line) => sum + line.delta, 0)).toBe(0);
  });

  it("refuses to exceed the currency ceiling", () => {
    expect(() =>
      engine().credit(account(ANA, 999_999), 2, options("op-1")),
    ).toThrow(BalanceOverflowError);
  });

  it("refuses a zero or fractional amount", () => {
    expect(() => engine().credit(emptyAccount(ANA), 0, options("op-1"))).toThrow(
      InvalidAmountError,
    );
    expect(() => engine().credit(emptyAccount(ANA), 1.5, options("op-1"))).toThrow(
      InvalidAmountError,
    );
    expect(() => engine().credit(emptyAccount(ANA), -5, options("op-1"))).toThrow(
      InvalidAmountError,
    );
  });

  it("refuses a non-finite timestamp", () => {
    expect(() =>
      engine().credit(emptyAccount(ANA), 5, { ...options("op-1"), now: Number.NaN }),
    ).toThrow(ValidationError);
  });

  it("can credit from an explicit source", () => {
    const source = account(systemAccount(SCOPE, COIN, SystemAccount.Shop), 1000);
    const result = engine().credit(emptyAccount(ANA), 200, {
      ...options("op-1"),
      source,
    });
    expect(result.balances["guild-1/system:shop/COIN"]).toBe(800);
  });
});

describe("debit", () => {
  it("takes currency out of circulation", () => {
    const result = engine().debit(account(ANA, 500), 200, options("op-1"));
    expect(result.posting.kind).toBe(PostingKind.Debit);
    expect(result.balances["guild-1/ana/COIN"]).toBe(300);
    expect(result.balances["guild-1/system:sink/COIN"]).toBe(200);
  });

  it("refuses to overdraw by default", () => {
    expect(() => engine().debit(account(ANA, 100), 200, options("op-1"))).toThrow(
      InsufficientFundsError,
    );
  });

  it("reports the shortfall on the error", () => {
    try {
      engine().debit(account(ANA, 100), 250, options("op-1"));
      expect.unreachable("should have thrown");
    } catch (error) {
      const funds = error as InsufficientFundsError;
      expect(funds.balance).toBe(100);
      expect(funds.required).toBe(250);
      expect(funds.shortfall).toBe(150);
    }
  });

  it("allows an overdraft when the caller opts in", () => {
    const result = engine().debit(account(ANA, 100), 200, {
      ...options("op-1"),
      allowNegative: true,
    });
    expect(result.balances["guild-1/ana/COIN"]).toBe(-100);
  });

  it("allows an overdraft when the engine is configured for it", () => {
    const result = engine({ allowNegative: true }).debit(
      account(ANA, 100),
      200,
      options("op-1"),
    );
    expect(result.balances["guild-1/ana/COIN"]).toBe(-100);
  });
});

describe("transfer", () => {
  it("moves currency between members", () => {
    const result = engine().transfer(account(ANA, 500), account(BEN, 20), 300, options("op-1"));
    expect(result.posting.kind).toBe(PostingKind.Transfer);
    expect(result.balances["guild-1/ana/COIN"]).toBe(200);
    expect(result.balances["guild-1/ben/COIN"]).toBe(320);
  });

  it("moves exactly nothing into or out of existence", () => {
    const before = 500 + 20;
    const result = engine().transfer(account(ANA, 500), account(BEN, 20), 300, options("op-1"));
    const after =
      (result.balances["guild-1/ana/COIN"] ?? 0) + (result.balances["guild-1/ben/COIN"] ?? 0);
    expect(after).toBe(before);
  });

  it("refuses an overdraft", () => {
    expect(() =>
      engine().transfer(account(ANA, 100), account(BEN, 0), 300, options("op-1")),
    ).toThrow(InsufficientFundsError);
  });

  it("refuses to overfill the recipient", () => {
    expect(() =>
      engine().transfer(account(ANA, 500), account(BEN, 999_999), 300, options("op-1")),
    ).toThrow(BalanceOverflowError);
  });

  it("refuses a self-transfer", () => {
    expect(() =>
      engine().transfer(account(ANA, 500), account(ANA, 500), 100, options("op-1")),
    ).toThrow(ValidationError);
  });

  it("refuses to cross scopes or currencies", () => {
    const otherScope = memberAccount("guild-2", "ben", COIN);
    expect(() =>
      engine().transfer(account(ANA, 500), account(otherScope, 0), 100, options("op-1")),
    ).toThrow(ValidationError);

    const otherCurrency = memberAccount(SCOPE, "ben", "GLD");
    expect(() =>
      engine().transfer(account(ANA, 500), account(otherCurrency, 0), 100, options("op-1")),
    ).toThrow(CurrencyMismatchError);
  });
});

describe("earn", () => {
  it("pays out and records the cooldown", () => {
    const result = engine().earn(emptyAccount(ANA), "message", createEarnState(), options("op-1"));
    expect(result.outcome).toBe(EarnOutcome.Earned);
    expect(result.amount).toBe(10);
    expect(result.newBalance).toBe(10);
    expect(result.posting?.kind).toBe(PostingKind.Earn);
    expect(result.posting?.metadata["earnRule"]).toBe("message");
    expect(result.state.lastEarnedAt["message"]).toBe(NOW);
  });

  it("never mutates the state it was given", () => {
    const state = createEarnState();
    engine().earn(emptyAccount(ANA), "message", state, options("op-1"));
    expect(state.lastEarnedAt).toEqual({});
  });

  it("blocks inside the cooldown without booking anything", () => {
    const rank = engine();
    const first = rank.earn(emptyAccount(ANA), "message", createEarnState(), options("op-1"));
    const blocked = rank.earn(
      account(ANA, 10),
      "message",
      first.state,
      options("op-2", NOW + 30_000),
    );
    expect(blocked.outcome).toBe(EarnOutcome.Cooldown);
    expect(blocked.posting).toBeNull();
    expect(blocked.cooldownRemainingMs).toBe(30_000);
  });

  it("does not restart the cooldown when it blocks", () => {
    const rank = engine();
    const first = rank.earn(emptyAccount(ANA), "message", createEarnState(), options("op-1"));
    const blocked = rank.earn(account(ANA, 10), "message", first.state, options("op-2", NOW + 30_000));
    const later = rank.earn(account(ANA, 10), "message", blocked.state, options("op-3", NOW + 61_000));
    expect(later.outcome).toBe(EarnOutcome.Earned);
  });

  it("trims the last payout of the period and then blocks", () => {
    const rank = engine({
      earnRules: [
        createEarnRule({
          key: "message",
          amount: 30,
          currency: COIN,
          cooldownSeconds: 0,
          periodCapAmount: 100,
        }),
      ],
    });
    let state = createEarnState();
    let balance = 0;
    for (let index = 0; index < 3; index += 1) {
      const step = rank.earn(account(ANA, balance), "message", state, options(`op-${index}`, NOW + index));
      state = step.state;
      balance = step.newBalance;
    }
    expect(balance).toBe(90);

    const trimmed = rank.earn(account(ANA, balance), "message", state, options("op-trim", NOW + 10));
    expect(trimmed.outcome).toBe(EarnOutcome.Earned);
    expect(trimmed.amount).toBe(10);
    expect(trimmed.grossAmount).toBe(30);

    const blocked = rank.earn(
      account(ANA, trimmed.newBalance),
      "message",
      trimmed.state,
      options("op-block", NOW + 20),
    );
    expect(blocked.outcome).toBe(EarnOutcome.PeriodCap);
    expect(blocked.periodRemaining).toBe(0);
  });

  it("starts a fresh period when the old one is over", () => {
    const rank = engine({
      earnRules: [
        createEarnRule({
          key: "message",
          amount: 100,
          currency: COIN,
          cooldownSeconds: 0,
          periodCapAmount: 100,
          periodSeconds: 3600,
        }),
      ],
    });
    const first = rank.earn(emptyAccount(ANA), "message", createEarnState(), options("op-1"));
    const blocked = rank.earn(account(ANA, 100), "message", first.state, options("op-2", NOW + 30 * MINUTE));
    expect(blocked.outcome).toBe(EarnOutcome.PeriodCap);

    const fresh = rank.earn(account(ANA, 100), "message", blocked.state, options("op-3", NOW + HOUR));
    expect(fresh.outcome).toBe(EarnOutcome.Earned);
    expect(fresh.amount).toBe(100);
  });

  it("reports an unknown or disabled rule instead of throwing", () => {
    const rank = engine({
      earnRules: [
        createEarnRule({ key: "message", amount: 10, currency: COIN, enabled: false }),
      ],
    });
    expect(rank.earn(emptyAccount(ANA), "nope", createEarnState(), options("op-1")).outcome).toBe(
      EarnOutcome.UnknownRule,
    );
    expect(
      rank.earn(emptyAccount(ANA), "message", createEarnState(), options("op-2")).outcome,
    ).toBe(EarnOutcome.RuleDisabled);
  });

  it("reports a full account", () => {
    const result = engine().earn(
      account(ANA, 1_000_000),
      "message",
      createEarnState(),
      options("op-1"),
    );
    expect(result.outcome).toBe(EarnOutcome.MaxBalanceReached);
    expect(result.posting).toBeNull();
  });

  it("trims a payout to the remaining headroom", () => {
    const result = engine().earn(
      account(ANA, 999_995),
      "message",
      createEarnState(),
      options("op-1"),
    );
    expect(result.amount).toBe(5);
    expect(result.newBalance).toBe(1_000_000);
  });

  it("reports NO_AMOUNT for a rule that pays nothing", () => {
    const rank = engine({
      earnRules: [createEarnRule({ key: "message", amount: 0, currency: COIN })],
    });
    const result = rank.earn(emptyAccount(ANA), "message", createEarnState(), options("op-1"));
    expect(result.outcome).toBe(EarnOutcome.NoAmount);
  });

  it("refuses a rule whose currency the account does not hold", () => {
    const rank = new EconomyEngine({
      currencies: [{ code: COIN }, { code: "GLD" }],
      earnRules: [createEarnRule({ key: "message", amount: 10, currency: "GLD" })],
    });
    expect(() =>
      rank.earn(emptyAccount(ANA), "message", createEarnState(), options("op-1")),
    ).toThrow(CurrencyMismatchError);
  });

  it("answers whether earning is possible right now", () => {
    const rank = engine();
    const state = createEarnState();
    expect(rank.canEarn(state, "message", NOW)).toBe(true);
    expect(rank.canEarn(state, "nope", NOW)).toBe(false);

    const earned = rank.earn(emptyAccount(ANA), "message", state, options("op-1"));
    expect(rank.canEarn(earned.state, "message", NOW + 1000)).toBe(false);
    expect(rank.canEarn(earned.state, "message", NOW + 61_000)).toBe(true);
  });

  it("reports no cap for an uncapped rule", () => {
    const rank = engine({
      earnRules: [createEarnRule({ key: "message", amount: 10, currency: COIN })],
    });
    expect(rank.earnPeriodRemaining(createEarnState(), "message", NOW)).toBeNull();
    expect(rank.earnCooldownRemainingMs(createEarnState(), "message", NOW)).toBe(0);
  });

  it("round-trips its state through JSON", () => {
    const earned = engine().earn(emptyAccount(ANA), "message", createEarnState(), options("op-1"));
    const restored = deserializeEarnState(
      JSON.parse(JSON.stringify(serializeEarnState(earned.state))),
    );
    expect(restored).toEqual(earned.state);
    expect(cloneEarnState(restored)).toEqual(restored);
  });

  it("rejects stored state it cannot trust", () => {
    expect(() => deserializeEarnState(null)).toThrow(ValidationError);
    expect(() => deserializeEarnState({ lastEarnedAt: 5 })).toThrow(ValidationError);
    expect(() => deserializeEarnState({ lastEarnedAt: { a: "x" } })).toThrow(ValidationError);
    expect(deserializeEarnState({})).toEqual(createEarnState());
  });

  it("rejects impossible rules", () => {
    expect(() => createEarnRule({ key: "", amount: 1, currency: COIN })).toThrow(ConfigurationError);
    expect(() => createEarnRule({ key: "a", amount: 1, currency: "" })).toThrow(ConfigurationError);
    expect(() => createEarnRule({ key: "a", amount: -1, currency: COIN })).toThrow(ConfigurationError);
    expect(() => createEarnRule({ key: "a", amount: 1, currency: COIN, cooldownSeconds: -1 })).toThrow(ConfigurationError);
    expect(() => createEarnRule({ key: "a", amount: 1, currency: COIN, periodCapAmount: -1 })).toThrow(ConfigurationError);
    expect(() => createEarnRule({ key: "a", amount: 1, currency: COIN, periodSeconds: 0 })).toThrow(ConfigurationError);
  });

  it("rejects duplicate rule keys and unknown currencies", () => {
    expect(
      () =>
        new EconomyEngine({
          currencies: [{ code: COIN }],
          earnRules: [
            createEarnRule({ key: "a", amount: 1, currency: COIN }),
            createEarnRule({ key: "a", amount: 2, currency: COIN }),
          ],
        }),
    ).toThrow(ConfigurationError);

    expect(
      () =>
        new EconomyEngine({
          currencies: [{ code: COIN }],
          earnRules: [createEarnRule({ key: "a", amount: 1, currency: "NOPE" })],
        }),
    ).toThrow(ConfigurationError);
  });
});

describe("reverse", () => {
  it("books the exact inverse", () => {
    const rank = engine();
    const original = rank.transfer(account(ANA, 500), account(BEN, 0), 300, options("op-1"));
    const reversal = rank.reverse(
      original.posting,
      { "guild-1/ana/COIN": 200, "guild-1/ben/COIN": 300 },
      options("op-2", NOW + 1000),
    );

    expect(reversal.posting.kind).toBe(PostingKind.Reversal);
    expect(reversal.posting.reverses).toBe("op-1");
    expect(reversal.balances["guild-1/ana/COIN"]).toBe(500);
    expect(reversal.balances["guild-1/ben/COIN"]).toBe(0);
  });

  it("uses the current balances, not the historical ones", () => {
    const rank = engine();
    const original = rank.transfer(account(ANA, 500), account(BEN, 0), 300, options("op-1"));
    // ben has since earned more
    const reversal = rank.reverse(
      original.posting,
      { "guild-1/ana/COIN": 200, "guild-1/ben/COIN": 999 },
      options("op-2", NOW + 1000),
    );
    expect(reversal.balances["guild-1/ben/COIN"]).toBe(699);
  });

  it("refuses when the recipient has already spent the money", () => {
    const rank = engine();
    const original = rank.transfer(account(ANA, 500), account(BEN, 0), 300, options("op-1"));
    expect(() =>
      rank.reverse(
        original.posting,
        { "guild-1/ana/COIN": 200, "guild-1/ben/COIN": 50 },
        options("op-2", NOW + 1000),
      ),
    ).toThrow(InsufficientFundsError);
  });

  it("can be forced into a negative balance when the caller insists", () => {
    const rank = engine();
    const original = rank.transfer(account(ANA, 500), account(BEN, 0), 300, options("op-1"));
    const reversal = rank.reverse(
      original.posting,
      { "guild-1/ana/COIN": 200, "guild-1/ben/COIN": 50 },
      { ...options("op-2", NOW + 1000), allowNegative: true },
    );
    expect(reversal.balances["guild-1/ben/COIN"]).toBe(-250);
  });

  it("refuses to reverse a reversal", () => {
    const rank = engine();
    const original = rank.transfer(account(ANA, 500), account(BEN, 0), 300, options("op-1"));
    const reversal = rank.reverse(
      original.posting,
      { "guild-1/ana/COIN": 200, "guild-1/ben/COIN": 300 },
      options("op-2", NOW + 1000),
    );
    expect(() =>
      rank.reverse(reversal.posting, { "guild-1/ana/COIN": 500, "guild-1/ben/COIN": 0 }, options("op-3")),
    ).toThrow(ReversalError);
  });

  it("needs its own operation id", () => {
    const rank = engine();
    const original = rank.transfer(account(ANA, 500), account(BEN, 0), 300, options("op-1"));
    expect(() =>
      rank.reverse(original.posting, { "guild-1/ana/COIN": 200, "guild-1/ben/COIN": 300 }, options("op-1")),
    ).toThrow(ReversalError);
  });

  it("needs the balance of every account involved", () => {
    const rank = engine();
    const original = rank.transfer(account(ANA, 500), account(BEN, 0), 300, options("op-1"));
    expect(() =>
      rank.reverse(original.posting, { "guild-1/ana/COIN": 200 }, options("op-2")),
    ).toThrow(ReversalError);
  });

  it("can undo a credit, pushing the mint back", () => {
    const rank = engine();
    const original = rank.credit(emptyAccount(ANA), 500, options("op-1"));
    const reversal = rank.reverse(
      original.posting,
      { "guild-1/ana/COIN": 500, "guild-1/system:mint/COIN": -500 },
      options("op-2", NOW + 1000),
    );
    expect(reversal.balances["guild-1/ana/COIN"]).toBe(0);
    expect(reversal.balances["guild-1/system:mint/COIN"]).toBe(0);
  });
});

describe("decay", () => {
  const flat: DecayRule = {
    amountPerPeriod: 10,
    permillePerPeriod: 0,
    periodSeconds: 86400,
    floor: 0,
    graceSeconds: 7 * 86400,
  };

  it("does nothing inside the grace window", () => {
    const result = engine().applyDecay(account(ANA, 1000), flat, {
      ...options("op-1", NOW + 3 * DAY),
      lastActivityAt: NOW,
    });
    expect(result.posting).toBeNull();
    expect(result.newBalance).toBe(1000);
  });

  it("charges whole periods after the grace window", () => {
    const result = engine().applyDecay(account(ANA, 1000), flat, {
      ...options("op-1", NOW + 10 * DAY),
      lastActivityAt: NOW,
    });
    expect(result.periods).toBe(3);
    expect(result.amount).toBe(30);
    expect(result.newBalance).toBe(970);
    expect(result.posting?.kind).toBe(PostingKind.Decay);
  });

  it("costs the same run nightly as run once", () => {
    const rank = engine();
    const atOnce = rank.applyDecay(account(ANA, 1000), flat, {
      ...options("op-1", NOW + 12 * DAY),
      lastActivityAt: NOW,
    });

    let balance = 1000;
    let lastAppliedAt: number | null = null;
    for (let day = 8; day <= 12; day += 1) {
      const step = rank.applyDecay(account(ANA, balance), flat, {
        ...options(`op-${day}`, NOW + day * DAY),
        lastActivityAt: NOW,
        lastAppliedAt,
      });
      balance = step.newBalance;
      lastAppliedAt = step.appliedUpTo;
    }
    expect(balance).toBe(atOnce.newBalance);
  });

  it("applies a percentage share of the balance", () => {
    const percentage: DecayRule = {
      amountPerPeriod: 0,
      permillePerPeriod: 100, // 10 %
      periodSeconds: 86400,
      floor: 0,
      graceSeconds: 0,
    };
    const result = engine().applyDecay(account(ANA, 1000), percentage, {
      ...options("op-1", NOW + 2 * DAY),
      lastActivityAt: NOW,
    });
    // 1000 -> 900 -> 810
    expect(result.newBalance).toBe(810);
  });

  it("never decays below the floor", () => {
    const withFloor: DecayRule = { ...flat, floor: 500, graceSeconds: 0 };
    const result = engine().applyDecay(account(ANA, 550), withFloor, {
      ...options("op-1", NOW + 30 * DAY),
      lastActivityAt: NOW,
    });
    expect(result.newBalance).toBe(500);
  });

  it("does nothing to a balance already at the floor", () => {
    const withFloor: DecayRule = { ...flat, floor: 500, graceSeconds: 0 };
    const result = engine().applyDecay(account(ANA, 500), withFloor, {
      ...options("op-1", NOW + 30 * DAY),
      lastActivityAt: NOW,
    });
    expect(result.posting).toBeNull();
    expect(result.amount).toBe(0);
  });

  it("rejects a decay rule that removes nothing", () => {
    expect(() =>
      engine().applyDecay(
        account(ANA, 100),
        { amountPerPeriod: 0, permillePerPeriod: 0, periodSeconds: 1, floor: 0, graceSeconds: 0 },
        { ...options("op-1"), lastActivityAt: NOW },
      ),
    ).toThrow(ConfigurationError);
  });

  it("rejects impossible decay rules", () => {
    const bad: Partial<DecayRule>[] = [
      { amountPerPeriod: -1 },
      { permillePerPeriod: 1001 },
      { periodSeconds: 0 },
      { floor: 1.5 },
      { graceSeconds: -1 },
    ];
    for (const patch of bad) {
      expect(() =>
        engine().applyDecay(account(ANA, 100), { ...flat, ...patch } as DecayRule, {
          ...options("op-1", NOW + 100 * DAY),
          lastActivityAt: NOW,
        }),
      ).toThrow(ConfigurationError);
    }
  });
});

describe("system accounts", () => {
  it("may go negative without complaint", () => {
    const mint = account(systemAccount(SCOPE, COIN, SystemAccount.Mint), 0);
    const result = engine().transfer(mint, emptyAccount(ANA), 5_000, options("op-1"));
    expect(result.balances[accountKey(mint.ref)]).toBe(-5_000);
  });

  it("are not subject to the currency ceiling", () => {
    const shop = account(systemAccount(SCOPE, COIN, SystemAccount.Shop), 999_999);
    const result = engine().transfer(account(ANA, 5_000), shop, 5_000, options("op-1"));
    expect(result.balances["guild-1/system:shop/COIN"]).toBe(1_004_999);
  });
});
