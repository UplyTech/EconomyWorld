/**
 * How a Discord bot wires EconomyWorld in — and where the transaction goes.
 *
 *   npx vite-node examples/discord-bot-integration.ts
 *
 * This file is deliberately *not* a working bot: it shows the seam, and above
 * all it shows the one obligation this package cannot take off your hands.
 *
 * **Every posting must be written in a single database transaction.** The
 * `Transaction` class below stands in for that. Look at how `commit` applies
 * every line at once and drops everything on failure — that shape, not the
 * details, is what your repository has to do.
 */
import {
  account,
  accountKey,
  createCurrency,
  createEarnRule,
  createItem,
  createOffer,
  deserializeEarnState,
  EarnOutcome,
  EconomyEngine,
  InsufficientFundsError,
  Inventory,
  isBalanced,
  memberAccount,
  purchase,
  serializeEarnState,
  serializePosting,
  type Account,
  type EarnState,
  type Item,
  type Offer,
  type Posting,
} from "../src/index.js";

const CURRENCY = "COIN";

// ---------------------------------------------------------------------------
// The bot's own storage. EconomyWorld never touches this.
// ---------------------------------------------------------------------------

interface Row {
  balance: number;
  earnState: string;
  inventory: string;
}

const emptyRow = (): Row => ({ balance: 0, earnState: "{}", inventory: "[]" });

/**
 * Stand-in for your database. A real schema would be roughly:
 *
 * ```sql
 * CREATE TABLE accounts (
 *   scope    TEXT   NOT NULL,
 *   owner    TEXT   NOT NULL,
 *   currency TEXT   NOT NULL,
 *   balance  BIGINT NOT NULL,
 *   PRIMARY KEY (scope, owner, currency)
 * );
 *
 * CREATE TABLE postings (
 *   operation_id TEXT PRIMARY KEY,   -- <<< the idempotency guarantee
 *   payload      JSONB NOT NULL,
 *   occurred_at  BIGINT NOT NULL
 * );
 * ```
 *
 * That `PRIMARY KEY` on `operation_id` is not decoration. It is the only thing
 * standing between a retried request and a double booking, and it has to be
 * inside the same transaction as the balance updates.
 */
class Store {
  private readonly rows = new Map<string, Row>();
  private readonly postings = new Map<string, unknown>();

  public balance(key: string): number {
    return this.rows.get(key)?.balance ?? 0;
  }

  public account(scope: string, owner: string): Account {
    const ref = memberAccount(scope, owner, CURRENCY);
    return account(ref, this.balance(accountKey(ref)));
  }

  public earnState(key: string): EarnState {
    return deserializeEarnState(JSON.parse(this.rows.get(key)?.earnState ?? "{}"));
  }

  public inventory(key: string): Inventory {
    return Inventory.fromJSON(JSON.parse(this.rows.get(key)?.inventory ?? "[]"));
  }

  public hasBooked(operationId: string): boolean {
    return this.postings.has(operationId);
  }

  public transaction(): Transaction {
    return new Transaction(this);
  }

  /** @internal — only the Transaction commits. */
  public row(key: string): Row {
    let row = this.rows.get(key);
    if (row === undefined) {
      row = emptyRow();
      this.rows.set(key, row);
    }
    return row;
  }

  /** @internal */
  public recordPostings(entries: Map<string, unknown>): void {
    for (const [id, payload] of entries) {
      this.postings.set(id, payload);
    }
  }
}

/**
 * What "one database transaction" means, in miniature.
 *
 * Nothing is visible in the store until {@link commit}, and a failure part way
 * through leaves the store exactly as it was. That is the whole point: a
 * posting is indivisible, and half of one is how currency appears from nowhere.
 */
class Transaction {
  private readonly balances = new Map<string, number>();
  private readonly earnStates = new Map<string, string>();
  private readonly inventories = new Map<string, string>();
  private readonly postings = new Map<string, unknown>();

  constructor(private readonly store: Store) {}

  /** Stage every line of a posting, plus the posting itself. */
  public writePosting(posting: Posting): void {
    // Belt and braces: the library already guarantees this, but an assertion at
    // the storage boundary costs nothing and catches hand-built postings.
    if (!isBalanced(posting)) {
      throw new Error("refusing to write an unbalanced posting");
    }
    if (this.store.hasBooked(posting.operationId) || this.postings.has(posting.operationId)) {
      // In a real database this is the UNIQUE violation, not an if.
      throw new Error(`operation ${posting.operationId} already booked`);
    }
    for (const line of posting.lines) {
      this.balances.set(accountKey(line.account), line.balanceAfter);
    }
    this.postings.set(posting.operationId, serializePosting(posting));
  }

  public writeEarnState(key: string, state: EarnState): void {
    this.earnStates.set(key, JSON.stringify(serializeEarnState(state)));
  }

  public writeInventory(key: string, inventory: Inventory): void {
    this.inventories.set(key, JSON.stringify(inventory.toJSON()));
  }

  /** Apply everything at once. */
  public commit(): void {
    for (const [key, balance] of this.balances) this.store.row(key).balance = balance;
    for (const [key, state] of this.earnStates) this.store.row(key).earnState = state;
    for (const [key, inv] of this.inventories) this.store.row(key).inventory = inv;
    this.store.recordPostings(this.postings);
  }
}

/** Run `work` and commit only if it completes. */
function inTransaction(store: Store, work: (tx: Transaction) => void): void {
  const tx = store.transaction();
  work(tx);
  // Reaching here means nothing threw, so the whole thing lands at once.
  tx.commit();
}

// ---------------------------------------------------------------------------
// The bot
// ---------------------------------------------------------------------------

class EconomyBot {
  private readonly engine = new EconomyEngine({
    currencies: [createCurrency({ code: CURRENCY, name: "Coin", maxBalance: 10_000_000 })],
    earnRules: [
      createEarnRule({
        key: "message",
        amount: 5,
        currency: CURRENCY,
        cooldownSeconds: 60,
        periodCapAmount: 200,
      }),
      createEarnRule({ key: "daily", amount: 250, currency: CURRENCY, cooldownSeconds: 86400 }),
    ],
  });

  private readonly items: Record<string, Item> = {
    potion: createItem({ itemId: "potion", name: "Potion", maxStack: 10 }),
    badge: createItem({ itemId: "badge", name: "Supporter Badge", tradable: false }),
  };

  private offers: Record<string, Offer> = {
    potion: createOffer({
      offerId: "offer-potion",
      itemId: "potion",
      unitPrice: 50,
      currency: CURRENCY,
      stock: 100,
    }),
  };

  constructor(private readonly store: Store) {}

  /**
   * What `client.on("messageCreate", ...)` would call.
   *
   * Note the operation id: it is derived from the *message*, so a retried
   * handler produces the same id and the unique constraint catches it. An id
   * from `randomUUID()` would defeat the whole mechanism.
   */
  public onMessage(guildId: string, memberId: string, messageId: string): string {
    const key = accountKey(memberAccount(guildId, memberId, CURRENCY));
    const result = this.engine.earn(
      this.store.account(guildId, memberId),
      "message",
      this.store.earnState(key),
      { now: Date.now(), operationId: `msg:${messageId}`, reason: "chat activity" },
    );

    if (result.outcome !== EarnOutcome.Earned || result.posting === null) {
      // Cooldown and daily ceiling are the common case. Nothing to write, which
      // is most of the database load saved.
      return `${result.outcome} (nothing booked)`;
    }

    const posting = result.posting;
    inTransaction(this.store, (tx) => {
      tx.writePosting(posting);
      tx.writeEarnState(key, result.state);
    });

    return `+${result.amount} -> ${result.newBalance}`;
  }

  /** The `/pay` command. */
  public onPayCommand(
    guildId: string,
    sender: string,
    recipient: string,
    amount: number,
    interactionId: string,
  ): string {
    let result;
    try {
      result = this.engine.transfer(
        this.store.account(guildId, sender),
        this.store.account(guildId, recipient),
        amount,
        {
          now: Date.now(),
          operationId: `pay:${interactionId}`,
          reason: `/pay from ${sender} to ${recipient}`,
        },
      );
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        // The error carries the numbers, so the bot can say something useful
        // rather than "an error occurred".
        return `You are ${error.shortfall} short.`;
      }
      throw error;
    }

    const posting = result.posting;
    inTransaction(this.store, (tx) => tx.writePosting(posting));

    const senderKey = accountKey(memberAccount(guildId, sender, CURRENCY));
    const recipientKey = accountKey(memberAccount(guildId, recipient, CURRENCY));
    return `Sent ${amount}. ${sender}: ${result.balances[senderKey]}, ${recipient}: ${result.balances[recipientKey]}`;
  }

  /** The `/buy` command. */
  public onBuyCommand(
    guildId: string,
    memberId: string,
    offerKey: string,
    quantity: number,
    interactionId: string,
  ): string {
    const offer = this.offers[offerKey] as Offer;
    const item = this.items[offer.itemId] as Item;
    const key = accountKey(memberAccount(guildId, memberId, CURRENCY));

    const result = purchase(this.engine, {
      offer,
      item,
      buyer: this.store.account(guildId, memberId),
      inventory: this.store.inventory(key),
      quantity,
      now: Date.now(),
      operationId: `buy:${interactionId}`,
      reason: `bought ${quantity}x ${item.name}`,
    });

    // Three things changed. All three go in one transaction: money, items and
    // stock. A purchase where the money left but the item never arrived is the
    // complaint you spend the rest of the week answering.
    inTransaction(this.store, (tx) => {
      tx.writePosting(result.booking.posting);
      tx.writeInventory(key, result.inventory.inventory);
      this.offers = { ...this.offers, [offerKey]: result.offer };
    });

    return (
      `Bought ${result.quantity}x ${item.name} for ${result.totalPrice}. ` +
      `Balance: ${result.booking.balances[key]}`
    );
  }

  /** The `/balance` command. */
  public onBalanceCommand(guildId: string, memberId: string): string {
    const key = accountKey(memberAccount(guildId, memberId, CURRENCY));
    const items = this.store
      .inventory(key)
      .slots.filter((slot) => this.items[slot.itemId] !== undefined)
      .map((slot) => `${slot.quantity}x ${(this.items[slot.itemId] as Item).name}`)
      .join(", ");
    return `${this.store.balance(key)} coins${items.length > 0 ? ` -- ${items}` : ""}`;
  }

  /** @internal — used by the demo below to seed a balance. */
  public seed(guildId: string, memberId: string, amount: number): void {
    const result = this.engine.credit(
      // Loaded, not invented: crediting an emptyAccount() would overwrite what
      // the member already has, because the posting would say "before: 0".
      this.store.account(guildId, memberId),
      amount,
      { now: Date.now(), operationId: `seed:${memberId}`, reason: "seed for the example" },
    );
    inTransaction(this.store, (tx) => tx.writePosting(result.posting));
  }
}

// ---------------------------------------------------------------------------
// A short run
// ---------------------------------------------------------------------------

const store = new Store();
const bot = new EconomyBot(store);
const guild = "guild-1";

console.log("ana chats a few times");
for (let index = 0; index < 3; index += 1) {
  console.log(`   msg ${index}: ${bot.onMessage(guild, "ana", `m${index}`)}`);
}
console.log("   (the second and third are inside the cooldown, so nothing is written)");

bot.seed(guild, "ana", 1000);

console.log(`\n/balance ana -> ${bot.onBalanceCommand(guild, "ana")}`);

console.log("\n/pay ana -> ben 300");
console.log(`   ${bot.onPayCommand(guild, "ana", "ben", 300, "i1")}`);

console.log("\n/pay ana -> ben 99999 (she cannot afford it)");
console.log(`   ${bot.onPayCommand(guild, "ana", "ben", 99_999, "i2")}`);

console.log("\n/buy ana 2 potions");
console.log(`   ${bot.onBuyCommand(guild, "ana", "potion", 2, "i3")}`);

console.log(`\n/balance ana -> ${bot.onBalanceCommand(guild, "ana")}`);

console.log("\nThe same /pay interaction arriving twice");
console.log(`   first:  ${bot.onPayCommand(guild, "ana", "ben", 10, "i4")}`);
try {
  bot.onPayCommand(guild, "ana", "ben", 10, "i4");
} catch (error) {
  console.log(`   retry:  refused -- ${(error as Error).message}`);
}
