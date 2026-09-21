import { describe, it, expect } from "vitest";
import {
  acceptTrade,
  account,
  cancelTrade,
  ConfigurationError,
  createCurrency,
  createItem,
  EconomyEngine,
  emptyAccount,
  expireTrade,
  InsufficientFundsError,
  Inventory,
  isFinal,
  isOpen,
  ItemError,
  memberAccount,
  PostingKind,
  proposeTrade,
  revokeAcceptance,
  settleTrade,
  TradeState,
  TradeStateError,
  ValidationError,
  type Trade,
} from "../src/index.js";

const SCOPE = "guild-1";
const COIN = "COIN";
const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

const ANA = memberAccount(SCOPE, "ana", COIN);
const BEN = memberAccount(SCOPE, "ben", COIN);

const SWORD = createItem({ itemId: "sword", stackable: false });
const POTION = createItem({ itemId: "potion", maxStack: 10 });
const TROPHY = createItem({ itemId: "trophy", tradable: false });
const ITEMS = { sword: SWORD, potion: POTION, trophy: TROPHY };

const engine = () =>
  new EconomyEngine({ currencies: [createCurrency({ code: COIN, maxBalance: 1_000_000 })] });

function trade(overrides: Partial<Parameters<typeof proposeTrade>[0]> = {}): Trade {
  return proposeTrade({
    tradeId: "trade-1",
    scope: SCOPE,
    currency: COIN,
    left: { owner: "ana", amount: 100, items: [{ itemId: "sword", quantity: 1 }] },
    right: { owner: "ben", amount: 0, items: [{ itemId: "potion", quantity: 3 }] },
    now: NOW,
    ...overrides,
  });
}

function accepted(): Trade {
  return acceptTrade(acceptTrade(trade(), "ana", NOW), "ben", NOW);
}

const settlementOptions = {
  now: NOW + MINUTE,
  operationId: "op-trade-1",
  reason: "trade settlement",
};

describe("proposeTrade", () => {
  it("starts in PROPOSED with nothing moved", () => {
    const proposed = trade();
    expect(proposed.state).toBe(TradeState.Proposed);
    expect(proposed.acceptedBy).toEqual([]);
    expect(proposed.settledAt).toBeNull();
    expect(proposed.expiresAt).toBe(NOW + 300_000);
  });

  it("takes a custom lifetime", () => {
    expect(trade({ ttlSeconds: 60 }).expiresAt).toBe(NOW + 60_000);
  });

  it("refuses a trade with itself", () => {
    expect(() =>
      trade({
        left: { owner: "ana", amount: 100, items: [] },
        right: { owner: "ana", amount: 50, items: [] },
      }),
    ).toThrow(ValidationError);
  });

  it("refuses a trade where nobody offers anything", () => {
    expect(() =>
      trade({
        left: { owner: "ana", amount: 0, items: [] },
        right: { owner: "ben", amount: 0, items: [] },
      }),
    ).toThrow(ValidationError);
  });

  it("refuses malformed sides", () => {
    expect(() => trade({ tradeId: "" })).toThrow(ConfigurationError);
    expect(() => trade({ ttlSeconds: 0 })).toThrow(ConfigurationError);
    expect(() => trade({ now: Number.NaN })).toThrow(ValidationError);
    expect(() =>
      trade({ left: { owner: "", amount: 1, items: [] } }),
    ).toThrow(ValidationError);
    expect(() =>
      trade({ left: { owner: "ana", amount: -1, items: [] } }),
    ).toThrow(ValidationError);
    expect(() =>
      trade({ left: { owner: "ana", amount: 0, items: [{ itemId: "sword", quantity: 0 }] } }),
    ).toThrow(ValidationError);
    expect(() =>
      trade({
        left: {
          owner: "ana",
          amount: 0,
          items: [
            { itemId: "sword", quantity: 1 },
            { itemId: "sword", quantity: 1 },
          ],
        },
      }),
    ).toThrow(ValidationError);
  });
});

describe("the state machine", () => {
  it("needs both sides before it is accepted", () => {
    const half = acceptTrade(trade(), "ana", NOW);
    expect(half.state).toBe(TradeState.Proposed);
    expect(half.acceptedBy).toEqual(["ana"]);

    const full = acceptTrade(half, "ben", NOW);
    expect(full.state).toBe(TradeState.Accepted);
  });

  it("ignores a repeated acceptance", () => {
    const once = acceptTrade(trade(), "ana", NOW);
    expect(acceptTrade(once, "ana", NOW)).toBe(once);
  });

  it("lets a party take their agreement back", () => {
    const revoked = revokeAcceptance(accepted(), "ben", NOW);
    expect(revoked.state).toBe(TradeState.Proposed);
    expect(revoked.acceptedBy).toEqual(["ana"]);
  });

  it("lets either party walk away", () => {
    const cancelled = cancelTrade(accepted(), "ben", NOW + 1000);
    expect(cancelled.state).toBe(TradeState.Cancelled);
    expect(cancelled.settledAt).toBe(NOW + 1000);
    expect(isFinal(cancelled)).toBe(true);
  });

  it("expires once its time is up", () => {
    const expired = expireTrade(trade(), NOW + 301_000);
    expect(expired.state).toBe(TradeState.Expired);
    expect(isFinal(expired)).toBe(true);
  });

  it("refuses to expire a trade that still has time", () => {
    expect(() => expireTrade(trade(), NOW + 1000)).toThrow(TradeStateError);
  });

  it("leaves an already-final trade alone when expiring", () => {
    const cancelled = cancelTrade(trade(), "ana", NOW);
    expect(expireTrade(cancelled, NOW + 999_999)).toBe(cancelled);
  });

  it("refuses transitions out of a final state", () => {
    const cancelled = cancelTrade(trade(), "ana", NOW);
    expect(() => acceptTrade(cancelled, "ben", NOW)).toThrow(TradeStateError);
    expect(() => cancelTrade(cancelled, "ben", NOW)).toThrow(TradeStateError);
    expect(() => revokeAcceptance(cancelled, "ben", NOW)).toThrow(TradeStateError);
  });

  it("refuses transitions after expiry", () => {
    const stale = trade();
    expect(() => acceptTrade(stale, "ana", NOW + 400_000)).toThrow(TradeStateError);
    expect(isOpen(stale, NOW + 400_000)).toBe(false);
    expect(isOpen(stale, NOW + 1000)).toBe(true);
  });

  it("refuses anyone who is not a party", () => {
    expect(() => acceptTrade(trade(), "cai", NOW)).toThrow(ValidationError);
    expect(() => cancelTrade(trade(), "cai", NOW)).toThrow(ValidationError);
  });
});

describe("settleTrade", () => {
  const inventories = () => ({
    leftInventory: new Inventory([{ itemId: "sword", quantity: 1 }]),
    rightInventory: new Inventory([{ itemId: "potion", quantity: 5 }]),
  });

  it("moves both sides at once", () => {
    const settled = settleTrade(engine(), {
      ...settlementOptions,
      trade: accepted(),
      leftAccount: account(ANA, 500),
      rightAccount: account(BEN, 20),
      ...inventories(),
      items: ITEMS,
    });

    expect(settled.trade.state).toBe(TradeState.Completed);
    expect(settled.trade.settledAt).toBe(settlementOptions.now);

    // ana pays 100 and gives the sword; ben gives three potions.
    expect(settled.booking?.balances["guild-1/ana/COIN"]).toBe(400);
    expect(settled.booking?.balances["guild-1/ben/COIN"]).toBe(120);
    expect(settled.leftInventory.inventory.quantityOf("sword")).toBe(0);
    expect(settled.leftInventory.inventory.quantityOf("potion")).toBe(3);
    expect(settled.rightInventory.inventory.quantityOf("potion")).toBe(2);
    expect(settled.rightInventory.inventory.quantityOf("sword")).toBe(1);
  });

  it("nets the currency into a single movement", () => {
    const netted = settleTrade(engine(), {
      ...settlementOptions,
      trade: acceptTrade(
        acceptTrade(
          trade({
            left: { owner: "ana", amount: 100, items: [] },
            right: { owner: "ben", amount: 30, items: [] },
          }),
          "ana",
          NOW,
        ),
        "ben",
        NOW,
      ),
      leftAccount: account(ANA, 500),
      rightAccount: account(BEN, 500),
      leftInventory: new Inventory(),
      rightInventory: new Inventory(),
      items: ITEMS,
    });

    expect(netted.booking?.posting.amount).toBe(70);
    expect(netted.booking?.posting.kind).toBe(PostingKind.Trade);
    expect(netted.booking?.balances["guild-1/ana/COIN"]).toBe(430);
    expect(netted.booking?.balances["guild-1/ben/COIN"]).toBe(570);
  });

  it("books nothing when only items change hands", () => {
    const itemsOnly = acceptTrade(
      acceptTrade(
        trade({
          left: { owner: "ana", amount: 0, items: [{ itemId: "sword", quantity: 1 }] },
          right: { owner: "ben", amount: 0, items: [{ itemId: "potion", quantity: 1 }] },
        }),
        "ana",
        NOW,
      ),
      "ben",
      NOW,
    );
    const settled = settleTrade(engine(), {
      ...settlementOptions,
      trade: itemsOnly,
      leftAccount: account(ANA, 500),
      rightAccount: account(BEN, 500),
      ...inventories(),
      items: ITEMS,
    });
    expect(settled.booking).toBeNull();
  });

  it("conserves currency and items", () => {
    const before = 500 + 20;
    const settled = settleTrade(engine(), {
      ...settlementOptions,
      trade: accepted(),
      leftAccount: account(ANA, 500),
      rightAccount: account(BEN, 20),
      ...inventories(),
      items: ITEMS,
    });
    const after =
      (settled.booking?.balances["guild-1/ana/COIN"] ?? 0) +
      (settled.booking?.balances["guild-1/ben/COIN"] ?? 0);
    expect(after).toBe(before);

    const swords =
      settled.leftInventory.inventory.quantityOf("sword") +
      settled.rightInventory.inventory.quantityOf("sword");
    const potions =
      settled.leftInventory.inventory.quantityOf("potion") +
      settled.rightInventory.inventory.quantityOf("potion");
    expect(swords).toBe(1);
    expect(potions).toBe(5);
  });

  it("only settles an accepted trade", () => {
    expect(() =>
      settleTrade(engine(), {
        ...settlementOptions,
        trade: trade(),
        leftAccount: account(ANA, 500),
        rightAccount: account(BEN, 20),
        ...inventories(),
        items: ITEMS,
      }),
    ).toThrow(TradeStateError);
  });

  it("refuses to settle after expiry", () => {
    expect(() =>
      settleTrade(engine(), {
        ...settlementOptions,
        now: NOW + 400_000,
        trade: accepted(),
        leftAccount: account(ANA, 500),
        rightAccount: account(BEN, 20),
        ...inventories(),
        items: ITEMS,
      }),
    ).toThrow(TradeStateError);
  });

  it("refuses when a party cannot pay", () => {
    expect(() =>
      settleTrade(engine(), {
        ...settlementOptions,
        trade: accepted(),
        leftAccount: account(ANA, 10),
        rightAccount: account(BEN, 20),
        ...inventories(),
        items: ITEMS,
      }),
    ).toThrow(InsufficientFundsError);
  });

  it("refuses when a party does not hold what they offered", () => {
    expect(() =>
      settleTrade(engine(), {
        ...settlementOptions,
        trade: accepted(),
        leftAccount: account(ANA, 500),
        rightAccount: account(BEN, 20),
        leftInventory: new Inventory(),
        rightInventory: new Inventory([{ itemId: "potion", quantity: 5 }]),
        items: ITEMS,
      }),
    ).toThrow(ItemError);
  });

  it("refuses to trade a bound item", () => {
    const bound = acceptTrade(
      acceptTrade(
        trade({
          left: { owner: "ana", amount: 0, items: [{ itemId: "trophy", quantity: 1 }] },
          right: { owner: "ben", amount: 50, items: [] },
        }),
        "ana",
        NOW,
      ),
      "ben",
      NOW,
    );
    expect(() =>
      settleTrade(engine(), {
        ...settlementOptions,
        trade: bound,
        leftAccount: account(ANA, 500),
        rightAccount: account(BEN, 500),
        leftInventory: new Inventory([{ itemId: "trophy", quantity: 1 }]),
        rightInventory: new Inventory(),
        items: ITEMS,
      }),
    ).toThrow(ItemError);
  });

  it("needs every item it references", () => {
    expect(() =>
      settleTrade(engine(), {
        ...settlementOptions,
        trade: accepted(),
        leftAccount: account(ANA, 500),
        rightAccount: account(BEN, 20),
        ...inventories(),
        items: { sword: SWORD },
      }),
    ).toThrow(ItemError);
  });

  it("refuses accounts that do not match the trade", () => {
    const wrongOwner = memberAccount(SCOPE, "cai", COIN);
    expect(() =>
      settleTrade(engine(), {
        ...settlementOptions,
        trade: accepted(),
        leftAccount: emptyAccount(wrongOwner),
        rightAccount: account(BEN, 20),
        ...inventories(),
        items: ITEMS,
      }),
    ).toThrow(ValidationError);

    const wrongScope = memberAccount("guild-2", "ana", COIN);
    expect(() =>
      settleTrade(engine(), {
        ...settlementOptions,
        trade: accepted(),
        leftAccount: account(wrongScope, 500),
        rightAccount: account(BEN, 20),
        ...inventories(),
        items: ITEMS,
      }),
    ).toThrow(ValidationError);

    const wrongCurrency = memberAccount(SCOPE, "ana", "GLD");
    expect(() =>
      settleTrade(engine(), {
        ...settlementOptions,
        trade: accepted(),
        leftAccount: account(wrongCurrency, 500),
        rightAccount: account(BEN, 20),
        ...inventories(),
        items: ITEMS,
      }),
    ).toThrow(ValidationError);
  });

  it("accepts the item catalogue as a Map", () => {
    const settled = settleTrade(engine(), {
      ...settlementOptions,
      trade: accepted(),
      leftAccount: account(ANA, 500),
      rightAccount: account(BEN, 20),
      ...inventories(),
      items: new Map(Object.entries(ITEMS)),
    });
    expect(settled.trade.state).toBe(TradeState.Completed);
  });

  it("leaves no damage behind when it refuses", () => {
    const leftInventory = new Inventory([{ itemId: "sword", quantity: 1 }]);
    const rightInventory = new Inventory([{ itemId: "potion", quantity: 5 }]);
    try {
      settleTrade(engine(), {
        ...settlementOptions,
        trade: accepted(),
        leftAccount: account(ANA, 0),
        rightAccount: account(BEN, 20),
        leftInventory,
        rightInventory,
        items: ITEMS,
      });
    } catch {
      // expected
    }
    // The inputs are untouched: an abandoned trade costs nobody anything.
    expect(leftInventory.quantityOf("sword")).toBe(1);
    expect(rightInventory.quantityOf("potion")).toBe(5);
  });
});
