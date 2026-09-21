import { describe, it, expect } from "vitest";
import {
  addItem,
  applyChanges,
  ConfigurationError,
  createItem,
  InsufficientQuantityError,
  Inventory,
  ItemError,
  MAX_ITEM_QUANTITY,
  moveItem,
  removeItem,
  ValidationError,
} from "../src/index.js";

const SWORD = createItem({ itemId: "sword", name: "Sword", stackable: false });
const POTION = createItem({ itemId: "potion", name: "Potion", maxStack: 10 });
const TROPHY = createItem({ itemId: "trophy", name: "Trophy", tradable: false });
const COIN_BAG = createItem({ itemId: "bag" });

describe("createItem", () => {
  it("defaults to a stackable, tradable item", () => {
    expect(COIN_BAG.stackable).toBe(true);
    expect(COIN_BAG.tradable).toBe(true);
    expect(COIN_BAG.maxStack).toBeNull();
    expect(COIN_BAG.name).toBe("bag");
  });

  it("caps a non-stackable item at one", () => {
    expect(SWORD.maxStack).toBe(1);
  });

  it("rejects impossible items", () => {
    expect(() => createItem({ itemId: "" })).toThrow(ConfigurationError);
    expect(() => createItem({ itemId: "x", maxStack: 0 })).toThrow(ConfigurationError);
    expect(() => createItem({ itemId: "x", maxStack: 1.5 })).toThrow(ConfigurationError);
    expect(() => createItem({ itemId: "x", stackable: false, maxStack: 5 })).toThrow(
      ConfigurationError,
    );
  });

  it("freezes its metadata", () => {
    const item = createItem({ itemId: "x", metadata: { rarity: "rare" } });
    expect(Object.isFrozen(item.metadata)).toBe(true);
    expect(item.metadata["rarity"]).toBe("rare");
  });
});

describe("Inventory", () => {
  it("starts empty", () => {
    const inventory = new Inventory();
    expect(inventory.isEmpty).toBe(true);
    expect(inventory.size).toBe(0);
    expect(inventory.quantityOf("sword")).toBe(0);
    expect(inventory.has("sword")).toBe(false);
  });

  it("reports its slots in a stable order", () => {
    const inventory = new Inventory([
      { itemId: "sword", quantity: 1 },
      { itemId: "bag", quantity: 3 },
      { itemId: "potion", quantity: 2 },
    ]);
    expect(inventory.slots.map((slot) => slot.itemId)).toEqual(["bag", "potion", "sword"]);
  });

  it("merges duplicate slots and drops empty ones", () => {
    const inventory = new Inventory([
      { itemId: "potion", quantity: 2 },
      { itemId: "potion", quantity: 3 },
      { itemId: "bag", quantity: 0 },
    ]);
    expect(inventory.quantityOf("potion")).toBe(5);
    expect(inventory.quantityOf("bag")).toBe(0);
    expect(inventory.size).toBe(1);
  });

  it("round-trips through JSON", () => {
    const inventory = new Inventory([{ itemId: "potion", quantity: 4 }]);
    const restored = Inventory.fromJSON(JSON.parse(JSON.stringify(inventory.toJSON())));
    expect(restored.quantityOf("potion")).toBe(4);
  });

  it("rejects stored data it cannot trust", () => {
    expect(() => Inventory.fromJSON("nope")).toThrow(ValidationError);
    expect(() => new Inventory([{ itemId: "", quantity: 1 }])).toThrow(ValidationError);
    expect(() => new Inventory([{ itemId: "x", quantity: -1 }])).toThrow(ValidationError);
    expect(() => new Inventory([{ itemId: "x", quantity: 1.5 }])).toThrow(ValidationError);
  });
});

describe("addItem", () => {
  it("puts items in and reports the delta", () => {
    const change = addItem(new Inventory(), POTION, 3);
    expect(change.inventory.quantityOf("potion")).toBe(3);
    expect(change.deltas).toEqual([
      { itemId: "potion", delta: 3, quantityBefore: 0, quantityAfter: 3 },
    ]);
  });

  it("leaves the input inventory untouched", () => {
    const before = new Inventory([{ itemId: "potion", quantity: 1 }]);
    addItem(before, POTION, 3);
    expect(before.quantityOf("potion")).toBe(1);
  });

  it("respects the maximum stack", () => {
    const inventory = new Inventory([{ itemId: "potion", quantity: 8 }]);
    expect(() => addItem(inventory, POTION, 3)).toThrow(ItemError);
    expect(addItem(inventory, POTION, 2).inventory.quantityOf("potion")).toBe(10);
  });

  it("refuses a second copy of a non-stackable item", () => {
    const inventory = addItem(new Inventory(), SWORD, 1).inventory;
    expect(() => addItem(inventory, SWORD, 1)).toThrow(ItemError);
  });

  it("refuses an absurd quantity", () => {
    expect(() => addItem(new Inventory(), COIN_BAG, 0)).toThrow(ValidationError);
    expect(() => addItem(new Inventory(), COIN_BAG, -1)).toThrow(ValidationError);
    expect(() => addItem(new Inventory(), COIN_BAG, MAX_ITEM_QUANTITY + 1)).toThrow(
      ValidationError,
    );
  });

  it("refuses to exceed the global quantity ceiling", () => {
    const inventory = new Inventory([{ itemId: "bag", quantity: MAX_ITEM_QUANTITY }]);
    expect(() => addItem(inventory, COIN_BAG, 1)).toThrow(ItemError);
  });
});

describe("removeItem", () => {
  it("takes items out and reports the delta", () => {
    const inventory = new Inventory([{ itemId: "potion", quantity: 5 }]);
    const change = removeItem(inventory, "potion", 2);
    expect(change.inventory.quantityOf("potion")).toBe(3);
    expect(change.deltas[0]).toEqual({
      itemId: "potion",
      delta: -2,
      quantityBefore: 5,
      quantityAfter: 3,
    });
  });

  it("removes the slot entirely when it empties", () => {
    const inventory = new Inventory([{ itemId: "potion", quantity: 2 }]);
    const change = removeItem(inventory, "potion", 2);
    expect(change.inventory.isEmpty).toBe(true);
  });

  it("refuses to take more than is held", () => {
    const inventory = new Inventory([{ itemId: "potion", quantity: 1 }]);
    expect(() => removeItem(inventory, "potion", 2)).toThrow(InsufficientQuantityError);
    expect(() => removeItem(new Inventory(), "potion", 1)).toThrow(InsufficientQuantityError);
  });
});

describe("moveItem", () => {
  it("hands an item from one inventory to the other", () => {
    const from = new Inventory([{ itemId: "potion", quantity: 5 }]);
    const to = new Inventory();
    const moved = moveItem(from, to, POTION, 2);
    expect(moved.from.inventory.quantityOf("potion")).toBe(3);
    expect(moved.to.inventory.quantityOf("potion")).toBe(2);
  });

  it("conserves the total quantity", () => {
    const from = new Inventory([{ itemId: "potion", quantity: 5 }]);
    const to = new Inventory([{ itemId: "potion", quantity: 1 }]);
    const moved = moveItem(from, to, POTION, 3);
    expect(
      moved.from.inventory.quantityOf("potion") + moved.to.inventory.quantityOf("potion"),
    ).toBe(6);
  });

  it("refuses to move a bound item", () => {
    const from = new Inventory([{ itemId: "trophy", quantity: 1 }]);
    expect(() => moveItem(from, new Inventory(), TROPHY, 1)).toThrow(ItemError);
  });

  it("refuses when the sender does not hold it", () => {
    expect(() => moveItem(new Inventory(), new Inventory(), POTION, 1)).toThrow(
      InsufficientQuantityError,
    );
  });
});

describe("applyChanges", () => {
  it("applies several changes in order", () => {
    const change = applyChanges(new Inventory([{ itemId: "potion", quantity: 5 }]), [
      { item: POTION, quantity: 3 },
      { item: POTION, quantity: -6 },
      { item: COIN_BAG, quantity: 2 },
    ]);
    expect(change.inventory.quantityOf("potion")).toBe(2);
    expect(change.inventory.quantityOf("bag")).toBe(2);
    expect(change.deltas).toHaveLength(3);
  });

  it("fails as a whole if any step is impossible", () => {
    expect(() =>
      applyChanges(new Inventory(), [
        { item: POTION, quantity: 2 },
        { item: POTION, quantity: -5 },
      ]),
    ).toThrow(InsufficientQuantityError);
  });
});
