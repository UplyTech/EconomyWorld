import { describe, it, expect } from "vitest";
import {
  BalanceOverflowError,
  ConfigurationError,
  CurrencyMismatchError,
  DuplicateOperationError,
  EconomyError,
  InsufficientFundsError,
  InsufficientQuantityError,
  InvalidAmountError,
  ItemError,
  OfferError,
  ReversalError,
  TradeStateError,
  UnbalancedPostingError,
  UnknownReferenceError,
  ValidationError,
} from "../src/index.js";

describe("error hierarchy", () => {
  const simple: readonly [new (m: string) => EconomyError, string][] = [
    [ConfigurationError, "CONFIGURATION_ERROR"],
    [ValidationError, "VALIDATION_ERROR"],
    [InvalidAmountError, "INVALID_AMOUNT"],
    [ItemError, "ITEM_ERROR"],
    [OfferError, "OFFER_ERROR"],
    [TradeStateError, "TRADE_STATE_ERROR"],
    [ReversalError, "REVERSAL_ERROR"],
  ];

  it("lets a caller catch everything with one class", () => {
    for (const [Ctor] of simple) {
      const error = new Ctor("boom");
      expect(error).toBeInstanceOf(EconomyError);
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("carries a stable code so nobody compares message texts", () => {
    for (const [Ctor, code] of simple) {
      expect(new Ctor("boom").code).toBe(code);
    }
  });

  it("names itself after its class", () => {
    expect(new ValidationError("boom").name).toBe("ValidationError");
  });

  it("freezes its details", () => {
    const error = new ValidationError("boom", { amount: -1 });
    expect(error.details["amount"]).toBe(-1);
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it("defaults details to an empty object", () => {
    expect(new EconomyError("x", { code: "X" }).details).toEqual({});
  });

  it("keeps a cause when one is given", () => {
    const cause = new Error("root");
    const error = new EconomyError("wrapped", { code: "X", cause });
    expect((error as { cause?: unknown }).cause).toBe(cause);
  });
});

describe("the money errors carry the numbers", () => {
  it("InsufficientFundsError reports the shortfall", () => {
    const error = new InsufficientFundsError({
      account: "guild-1/ana/COIN",
      balance: 40,
      required: 100,
      currency: "COIN",
    });
    expect(error.code).toBe("INSUFFICIENT_FUNDS");
    expect(error.balance).toBe(40);
    expect(error.required).toBe(100);
    expect(error.shortfall).toBe(60);
    expect(error.message).toContain("guild-1/ana/COIN");
  });

  it("BalanceOverflowError names the ceiling", () => {
    const error = new BalanceOverflowError({
      account: "guild-1/ana/COIN",
      balance: 999,
      amount: 5,
      maxBalance: 1000,
    });
    expect(error.code).toBe("BALANCE_OVERFLOW");
    expect(error.details["maxBalance"]).toBe(1000);
  });

  it("CurrencyMismatchError names both currencies", () => {
    const error = new CurrencyMismatchError({ expected: "COIN", received: "GLD" });
    expect(error.code).toBe("CURRENCY_MISMATCH");
    expect(error.message).toContain("COIN");
    expect(error.message).toContain("GLD");
  });

  it("UnknownReferenceError names the kind and the id", () => {
    const error = new UnknownReferenceError("currency", "NOPE");
    expect(error.code).toBe("UNKNOWN_REFERENCE");
    expect(error.message).toBe("Unknown currency: NOPE");
  });

  it("DuplicateOperationError names the operation", () => {
    const error = new DuplicateOperationError("op-1");
    expect(error.code).toBe("DUPLICATE_OPERATION");
    expect(error.details["operationId"]).toBe("op-1");
  });

  it("UnbalancedPostingError reports how far off it was", () => {
    const error = new UnbalancedPostingError("op-1", -50);
    expect(error.code).toBe("UNBALANCED_POSTING");
    expect(error.details["sum"]).toBe(-50);
    expect(error.message).toContain("-50");
  });

  it("InsufficientQuantityError reports held and required", () => {
    const error = new InsufficientQuantityError({
      itemId: "potion",
      held: 1,
      required: 3,
    });
    expect(error.code).toBe("INSUFFICIENT_QUANTITY");
    expect(error.details["held"]).toBe(1);
  });
});
