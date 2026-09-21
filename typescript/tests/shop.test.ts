import { describe, it, expect } from "vitest";
import {
  account,
  ConfigurationError,
  createCurrency,
  createItem,
  createOffer,
  CurrencyMismatchError,
  EconomyEngine,
  emptyAccount,
  InsufficientFundsError,
  Inventory,
  isAvailable,
  ItemError,
  maxPurchasable,
  memberAccount,
  OfferError,
  PostingKind,
  purchase,
  ValidationError,
} from "../src/index.js";

const SCOPE = "guild-1";
const COIN = "COIN";
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

const ANA = memberAccount(SCOPE, "ana", COIN);
const POTION = createItem({ itemId: "potion", name: "Potion", maxStack: 10 });

const engine = () =>
  new EconomyEngine({ currencies: [createCurrency({ code: COIN, maxBalance: 1_000_000 })] });

const offer = (overrides: Partial<Parameters<typeof createOffer>[0]> = {}) =>
  createOffer({
    offerId: "offer-potion",
    itemId: "potion",
    unitPrice: 50,
    currency: COIN,
    ...overrides,
  });

const options = { now: NOW, operationId: "op-1", reason: "shop purchase" };

describe("createOffer", () => {
  it("defaults to an unlimited, open offer", () => {
    const created = offer();
    expect(created.stock).toBeNull();
    expect(created.perMemberLimit).toBeNull();
    expect(created.enabled).toBe(true);
    expect(created.availableFrom).toBeNull();
  });

  it("rejects impossible offers", () => {
    expect(() => createOffer({ offerId: "", itemId: "x", unitPrice: 1, currency: COIN })).toThrow(ConfigurationError);
    expect(() => createOffer({ offerId: "o", itemId: "", unitPrice: 1, currency: COIN })).toThrow(ConfigurationError);
    expect(() => createOffer({ offerId: "o", itemId: "x", unitPrice: -1, currency: COIN })).toThrow(ConfigurationError);
    expect(() => createOffer({ offerId: "o", itemId: "x", unitPrice: 1, currency: COIN, stock: -1 })).toThrow(ConfigurationError);
    expect(() => createOffer({ offerId: "o", itemId: "x", unitPrice: 1, currency: COIN, perMemberLimit: 0 })).toThrow(ConfigurationError);
    expect(() =>
      createOffer({
        offerId: "o",
        itemId: "x",
        unitPrice: 1,
        currency: COIN,
        availableFrom: NOW + HOUR,
        availableUntil: NOW,
      }),
    ).toThrow(ConfigurationError);
  });
});

describe("purchase", () => {
  it("moves money and items together", () => {
    const result = purchase(engine(), {
      ...options,
      offer: offer({ stock: 5 }),
      item: POTION,
      buyer: account(ANA, 500),
      inventory: new Inventory(),
    });

    expect(result.totalPrice).toBe(50);
    expect(result.booking.balances["guild-1/ana/COIN"]).toBe(450);
    expect(result.booking.balances["guild-1/system:shop/COIN"]).toBe(50);
    expect(result.inventory.inventory.quantityOf("potion")).toBe(1);
    expect(result.offer.stock).toBe(4);
  });

  it("multiplies the price by the quantity", () => {
    const result = purchase(engine(), {
      ...options,
      offer: offer({ stock: 10 }),
      item: POTION,
      buyer: account(ANA, 500),
      inventory: new Inventory(),
      quantity: 3,
    });
    expect(result.totalPrice).toBe(150);
    expect(result.inventory.inventory.quantityOf("potion")).toBe(3);
    expect(result.offer.stock).toBe(7);
  });

  it("leaves an unlimited offer unlimited", () => {
    const result = purchase(engine(), {
      ...options,
      offer: offer(),
      item: POTION,
      buyer: account(ANA, 500),
      inventory: new Inventory(),
    });
    expect(result.offer.stock).toBeNull();
  });

  it("refuses when the buyer cannot pay", () => {
    expect(() =>
      purchase(engine(), {
        ...options,
        offer: offer(),
        item: POTION,
        buyer: account(ANA, 10),
        inventory: new Inventory(),
      }),
    ).toThrow(InsufficientFundsError);
  });

  it("refuses when the item would not fit", () => {
    expect(() =>
      purchase(engine(), {
        ...options,
        offer: offer(),
        item: POTION,
        buyer: account(ANA, 5000),
        inventory: new Inventory([{ itemId: "potion", quantity: 10 }]),
      }),
    ).toThrow(ItemError);
  });

  it("refuses a sold-out, disabled, unopened or closed offer", () => {
    const cases: Parameters<typeof offer>[0][] = [
      { stock: 0 },
      { enabled: false },
      { availableFrom: NOW + HOUR },
      { availableUntil: NOW },
    ];
    for (const patch of cases) {
      expect(() =>
        purchase(engine(), {
          ...options,
          offer: offer(patch),
          item: POTION,
          buyer: account(ANA, 5000),
          inventory: new Inventory(),
        }),
      ).toThrow(OfferError);
    }
  });

  it("refuses to sell more than is in stock", () => {
    expect(() =>
      purchase(engine(), {
        ...options,
        offer: offer({ stock: 2 }),
        item: POTION,
        buyer: account(ANA, 5000),
        inventory: new Inventory(),
        quantity: 3,
      }),
    ).toThrow(OfferError);
  });

  it("enforces the per-member limit", () => {
    const limited = offer({ perMemberLimit: 3 });
    expect(() =>
      purchase(engine(), {
        ...options,
        offer: limited,
        item: POTION,
        buyer: account(ANA, 5000),
        inventory: new Inventory(),
        quantity: 2,
        alreadyPurchased: 2,
      }),
    ).toThrow(OfferError);

    const allowed = purchase(engine(), {
      ...options,
      offer: limited,
      item: POTION,
      buyer: account(ANA, 5000),
      inventory: new Inventory(),
      alreadyPurchased: 2,
    });
    expect(allowed.quantity).toBe(1);
  });

  it("refuses a mismatched item or currency", () => {
    expect(() =>
      purchase(engine(), {
        ...options,
        offer: offer(),
        item: createItem({ itemId: "sword" }),
        buyer: account(ANA, 5000),
        inventory: new Inventory(),
      }),
    ).toThrow(ValidationError);

    expect(() =>
      purchase(engine(), {
        ...options,
        offer: offer({ currency: "GLD" }),
        item: POTION,
        buyer: account(ANA, 5000),
        inventory: new Inventory(),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it("refuses a nonsensical quantity", () => {
    for (const quantity of [0, -1, 1.5]) {
      expect(() =>
        purchase(engine(), {
          ...options,
          offer: offer(),
          item: POTION,
          buyer: account(ANA, 5000),
          inventory: new Inventory(),
          quantity,
        }),
      ).toThrow(ValidationError);
    }
  });

  it("still books a free offer, so it leaves a trail", () => {
    const result = purchase(engine(), {
      ...options,
      offer: offer({ unitPrice: 0 }),
      item: POTION,
      buyer: account(ANA, 0),
      inventory: new Inventory(),
    });
    expect(result.totalPrice).toBe(0);
    expect(result.booking.posting.kind).toBe(PostingKind.Purchase);
    expect(result.booking.posting.metadata["free"]).toBe("true");
    expect(result.inventory.inventory.quantityOf("potion")).toBe(1);
  });

  it("can send the money somewhere other than the shop account", () => {
    const treasury = memberAccount(SCOPE, "treasury", COIN);
    const result = purchase(engine(), {
      ...options,
      offer: offer(),
      item: POTION,
      buyer: account(ANA, 500),
      inventory: new Inventory(),
      shopAccount: emptyAccount(treasury),
    });
    expect(result.booking.balances["guild-1/treasury/COIN"]).toBe(50);
  });
});

describe("isAvailable", () => {
  it("reports whether the offer can be bought now", () => {
    expect(isAvailable(offer(), NOW)).toBe(true);
    expect(isAvailable(offer({ enabled: false }), NOW)).toBe(false);
    expect(isAvailable(offer({ stock: 0 }), NOW)).toBe(false);
    expect(isAvailable(offer({ availableFrom: NOW + HOUR }), NOW)).toBe(false);
    expect(isAvailable(offer({ availableUntil: NOW }), NOW)).toBe(false);
    expect(isAvailable(offer({ availableFrom: NOW - HOUR, availableUntil: NOW + HOUR }), NOW)).toBe(true);
  });
});

describe("maxPurchasable", () => {
  it("is limited by the balance", () => {
    expect(maxPurchasable(offer(), 175, 0, NOW)).toBe(3);
  });

  it("is limited by the stock", () => {
    expect(maxPurchasable(offer({ stock: 2 }), 5000, 0, NOW)).toBe(2);
  });

  it("is limited by the per-member allowance", () => {
    expect(maxPurchasable(offer({ perMemberLimit: 5 }), 5000, 4, NOW)).toBe(1);
    expect(maxPurchasable(offer({ perMemberLimit: 5 }), 5000, 5, NOW)).toBe(0);
  });

  it("is zero for an offer that cannot be bought", () => {
    expect(maxPurchasable(offer({ enabled: false }), 5000, 0, NOW)).toBe(0);
  });

  it("is unbounded for a free, unlimited offer", () => {
    expect(maxPurchasable(offer({ unitPrice: 0 }), 0, 0, NOW)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
