import { MAX_ITEM_QUANTITY } from "./constants.js";
import {
  ConfigurationError,
  InsufficientQuantityError,
  ItemError,
  ValidationError,
} from "./errors.js";

/**
 * Something a member can own.
 *
 * Items are what makes a balance worth having. Without something to spend it
 * on, currency is a number that goes up.
 */
export interface Item {
  readonly itemId: string;
  readonly name: string;
  /**
   * Whether several of these share one inventory slot.
   *
   * A non-stackable item takes one slot per copy — the usual choice for
   * anything that should feel individual.
   */
  readonly stackable: boolean;
  /**
   * Whether members may hand it to each other.
   *
   * Setting this to `false` is the mechanism for anything that would break if
   * it were transferable: a reward for an achievement, a role token, a
   * one-per-member cosmetic.
   */
  readonly tradable: boolean;
  /** Largest quantity in one slot, for stackable items. */
  readonly maxStack: number | null;
  readonly metadata: Readonly<Record<string, string>>;
}

/** Loose input for {@link createItem}. */
export interface ItemInput {
  readonly itemId: string;
  readonly name?: string;
  readonly stackable?: boolean;
  readonly tradable?: boolean;
  readonly maxStack?: number | null;
  readonly metadata?: Record<string, string>;
}

/** Build a validated {@link Item}. */
export function createItem(input: ItemInput): Item {
  if (typeof input.itemId !== "string" || input.itemId.length === 0) {
    throw new ConfigurationError("An item needs a non-empty itemId", {
      itemId: input.itemId,
    });
  }
  const stackable = input.stackable ?? true;
  const maxStack = input.maxStack ?? null;
  if (maxStack !== null && (!Number.isSafeInteger(maxStack) || maxStack < 1)) {
    throw new ConfigurationError("maxStack must be a positive integer or null", {
      maxStack,
    });
  }
  if (!stackable && maxStack !== null && maxStack !== 1) {
    throw new ConfigurationError(
      "A non-stackable item cannot have a maxStack above 1",
      { itemId: input.itemId, maxStack },
    );
  }

  return Object.freeze({
    itemId: input.itemId,
    name: input.name ?? input.itemId,
    stackable,
    tradable: input.tradable ?? true,
    maxStack: stackable ? maxStack : 1,
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
}

/** How much of one item a member holds. */
export interface InventorySlot {
  readonly itemId: string;
  readonly quantity: number;
}

/** What an inventory change did, so the caller knows what to write. */
export interface InventoryDelta {
  readonly itemId: string;
  readonly delta: number;
  readonly quantityBefore: number;
  readonly quantityAfter: number;
}

/** The result of an inventory operation. */
export interface InventoryChange {
  /** The new inventory. The input is left untouched. */
  readonly inventory: Inventory;
  /** The rows the caller has to update. */
  readonly deltas: readonly InventoryDelta[];
}

/**
 * A member's holdings, as a value object.
 *
 * Immutable, like everything else the caller gets back: every operation returns
 * a new inventory rather than modifying this one, so a failed booking cannot
 * leave a half-applied change behind.
 */
export class Inventory {
  private readonly quantities: ReadonlyMap<string, number>;

  constructor(slots: readonly InventorySlot[] = []) {
    const quantities = new Map<string, number>();
    for (const slot of slots) {
      if (typeof slot.itemId !== "string" || slot.itemId.length === 0) {
        throw new ValidationError("An inventory slot needs a non-empty itemId", {});
      }
      if (!Number.isSafeInteger(slot.quantity) || slot.quantity < 0) {
        throw new ValidationError("An inventory quantity must be a non-negative integer", {
          itemId: slot.itemId,
          quantity: slot.quantity,
        });
      }
      if (slot.quantity > 0) {
        quantities.set(slot.itemId, (quantities.get(slot.itemId) ?? 0) + slot.quantity);
      }
    }
    this.quantities = quantities;
  }

  /** How many of this item the member holds. */
  public quantityOf(itemId: string): number {
    return this.quantities.get(itemId) ?? 0;
  }

  /** True when the member holds at least `quantity` of the item. */
  public has(itemId: string, quantity = 1): boolean {
    return this.quantityOf(itemId) >= quantity;
  }

  /** Every non-empty slot, sorted by item id for a stable order. */
  public get slots(): readonly InventorySlot[] {
    return [...this.quantities.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([itemId, quantity]) => ({ itemId, quantity }));
  }

  /** How many distinct items the member holds. */
  public get size(): number {
    return this.quantities.size;
  }

  /** True when the member holds nothing. */
  public get isEmpty(): boolean {
    return this.quantities.size === 0;
  }

  /** Plain-object form, ready for `JSON.stringify`. */
  public toJSON(): InventorySlot[] {
    return [...this.slots];
  }

  /** Rebuild an inventory from stored data. */
  public static fromJSON(raw: unknown): Inventory {
    if (!Array.isArray(raw)) {
      throw new ValidationError("A stored inventory must be an array of slots", {});
    }
    return new Inventory(raw as InventorySlot[]);
  }
}

/** Put items into an inventory. */
export function addItem(
  inventory: Inventory,
  item: Item,
  quantity = 1,
): InventoryChange {
  assertQuantity(quantity);
  const before = inventory.quantityOf(item.itemId);
  const after = before + quantity;

  if (after > MAX_ITEM_QUANTITY) {
    throw new ItemError("An inventory slot cannot hold that many", {
      itemId: item.itemId,
      quantity: after,
      limit: MAX_ITEM_QUANTITY,
    });
  }
  if (item.maxStack !== null && after > item.maxStack) {
    throw new ItemError(
      item.stackable
        ? "That would exceed the item's maximum stack"
        : "A non-stackable item cannot be held more than once",
      { itemId: item.itemId, quantity: after, maxStack: item.maxStack },
    );
  }

  return {
    inventory: replace(inventory, item.itemId, after),
    deltas: [
      { itemId: item.itemId, delta: quantity, quantityBefore: before, quantityAfter: after },
    ],
  };
}

/** Take items out of an inventory. */
export function removeItem(
  inventory: Inventory,
  itemId: string,
  quantity = 1,
): InventoryChange {
  assertQuantity(quantity);
  const before = inventory.quantityOf(itemId);
  if (before < quantity) {
    throw new InsufficientQuantityError({ itemId, held: before, required: quantity });
  }
  const after = before - quantity;
  return {
    inventory: replace(inventory, itemId, after),
    deltas: [{ itemId, delta: -quantity, quantityBefore: before, quantityAfter: after }],
  };
}

/**
 * Move items from one inventory to another.
 *
 * Returns both new inventories together, because a move that only half happened
 * is the inventory equivalent of a half-executed transfer. Write them in one
 * transaction, the same way you write a posting.
 */
export function moveItem(
  from: Inventory,
  to: Inventory,
  item: Item,
  quantity = 1,
): { from: InventoryChange; to: InventoryChange } {
  if (!item.tradable) {
    throw new ItemError("This item cannot be moved between members", {
      itemId: item.itemId,
    });
  }
  const removed = removeItem(from, item.itemId, quantity);
  const added = addItem(to, item, quantity);
  return { from: removed, to: added };
}

/** Apply several changes to one inventory in order. */
export function applyChanges(
  inventory: Inventory,
  changes: readonly { item: Item; quantity: number }[],
): InventoryChange {
  let current = inventory;
  const deltas: InventoryDelta[] = [];
  for (const change of changes) {
    const step =
      change.quantity >= 0
        ? addItem(current, change.item, change.quantity)
        : removeItem(current, change.item.itemId, -change.quantity);
    current = step.inventory;
    deltas.push(...step.deltas);
  }
  return { inventory: current, deltas };
}

function replace(inventory: Inventory, itemId: string, quantity: number): Inventory {
  const slots = inventory.slots.filter((slot) => slot.itemId !== itemId);
  if (quantity > 0) {
    slots.push({ itemId, quantity });
  }
  return new Inventory(slots);
}

function assertQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new ValidationError("A quantity must be a positive integer", { quantity });
  }
  if (quantity > MAX_ITEM_QUANTITY) {
    throw new ValidationError("A quantity above the supported maximum", {
      quantity,
      limit: MAX_ITEM_QUANTITY,
    });
  }
}
