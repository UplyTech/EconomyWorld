/**
 * Everything a caller needs, in one runnable file.
 *
 *   npx vite-node examples/basic.ts
 */
import {
  acceptTrade,
  account,
  createCurrency,
  createEarnRule,
  createEarnState,
  createItem,
  createOffer,
  emptyAccount,
  EconomyEngine,
  InMemoryOperationLog,
  Inventory,
  isBalanced,
  maxPurchasable,
  memberAccount,
  proposeTrade,
  purchase,
  serializePosting,
  settleTrade,
  splitMinorUnits,
} from "../src/index.js";

const SCOPE = "guild-1";
const COIN = "COIN";
const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;

// ------------------------------------------------------------------ setup
const coin = createCurrency({
  code: COIN,
  name: "Coin",
  symbol: "c",
  maxBalance: 1_000_000,
});

const engine = new EconomyEngine({
  currencies: [coin],
  earnRules: [
    createEarnRule({
      key: "message",
      amount: 5,
      currency: COIN,
      cooldownSeconds: 60,
      periodCapAmount: 200,
    }),
    createEarnRule({ key: "daily", amount: 250, currency: COIN, cooldownSeconds: 86400 }),
  ],
});

const ana = memberAccount(SCOPE, "ana", COIN);
const ben = memberAccount(SCOPE, "ben", COIN);

// ---------------------------------------------- 1. currency into existence
console.log("1. The server gives ana a welcome gift");
const credit = engine.credit(emptyAccount(ana), 500, {
  now: NOW,
  operationId: "op-1",
  reason: "welcome gift",
});
console.log(`   ana: ${credit.balances["guild-1/ana/COIN"]}`);
console.log(
  `   mint: ${credit.balances["guild-1/system:mint/COIN"]}  <- what has been issued`,
);
console.log(`   posting balances: ${isBalanced(credit.posting)}`);

// ------------------------------------------------------------ 2. earning
console.log("\n2. ana earns for chatting, then hits her cooldown");
const first = engine.earn(account(ana, 500), "message", createEarnState(), {
  now: NOW,
  operationId: "op-2",
  reason: "message",
});
console.log(`   ${first.outcome}: +${first.amount} -> ${first.newBalance}`);

const blocked = engine.earn(account(ana, first.newBalance), "message", first.state, {
  now: NOW + 10_000,
  operationId: "op-3",
  reason: "message",
});
console.log(
  `   ${blocked.outcome}: ${Math.round(blocked.cooldownRemainingMs / 1000)}s to go, nothing booked`,
);

// ----------------------------------------------------------- 3. a transfer
console.log("\n3. ana sends ben 200");
const transfer = engine.transfer(account(ana, 505), account(ben, 0), 200, {
  now: NOW,
  operationId: "op-4",
  reason: "gift to ben",
});
console.log(
  `   ana: ${transfer.balances["guild-1/ana/COIN"]}, ben: ${transfer.balances["guild-1/ben/COIN"]}`,
);
console.log("   ^ these two updates MUST be written in one database transaction");

// --------------------------------------------------------------- 4. shop
console.log("\n4. ben buys two potions");
const potion = createItem({ itemId: "potion", name: "Potion", maxStack: 10 });
const offer = createOffer({
  offerId: "offer-potion",
  itemId: "potion",
  unitPrice: 50,
  currency: COIN,
  stock: 10,
  perMemberLimit: 5,
});
console.log(`   ben could afford ${maxPurchasable(offer, 200, 0, NOW)} at most`);

const bought = purchase(engine, {
  offer,
  item: potion,
  buyer: account(ben, 200),
  inventory: new Inventory(),
  quantity: 2,
  now: NOW,
  operationId: "op-5",
  reason: "shop purchase",
});
console.log(
  `   paid ${bought.totalPrice}, ben now has ${bought.booking.balances["guild-1/ben/COIN"]}`,
);
console.log(`   inventory: ${JSON.stringify(bought.inventory.inventory.toJSON())}`);
console.log(`   stock left: ${bought.offer.stock}`);

// -------------------------------------------------------------- 5. trade
console.log("\n5. ana and ben trade: 100 coins for one potion");
let trade = proposeTrade({
  tradeId: "trade-1",
  scope: SCOPE,
  currency: COIN,
  left: { owner: "ana", amount: 100, items: [] },
  right: { owner: "ben", amount: 0, items: [{ itemId: "potion", quantity: 1 }] },
  now: NOW,
});
console.log(`   proposed, expires in ${(trade.expiresAt - NOW) / 1000}s`);
trade = acceptTrade(acceptTrade(trade, "ana", NOW), "ben", NOW);
console.log(`   both accepted -> ${trade.state}`);

const settled = settleTrade(engine, {
  trade,
  leftAccount: account(ana, 305),
  rightAccount: account(ben, 100),
  leftInventory: new Inventory(),
  rightInventory: new Inventory([{ itemId: "potion", quantity: 2 }]),
  items: { potion },
  now: NOW + 1000,
  operationId: "op-6",
  reason: "trade settlement",
});
console.log(
  `   settled: ana ${settled.booking?.balances["guild-1/ana/COIN"]}, ` +
    `ben ${settled.booking?.balances["guild-1/ben/COIN"]}`,
);
console.log(`   ana's items: ${JSON.stringify(settled.leftInventory.inventory.toJSON())}`);
console.log(`   ben's items: ${JSON.stringify(settled.rightInventory.inventory.toJSON())}`);

// ----------------------------------------------------------- 6. reversal
console.log("\n6. Moderation undoes the gift from step 3");
const reversal = engine.reverse(
  transfer.posting,
  { "guild-1/ana/COIN": 205, "guild-1/ben/COIN": 200 },
  { now: NOW + 2000, operationId: "op-7", reason: "gift reversed by moderation" },
);
console.log(
  `   ana: ${reversal.balances["guild-1/ana/COIN"]}, ben: ${reversal.balances["guild-1/ben/COIN"]}`,
);
console.log(`   reverses: ${reversal.posting.reverses}`);

// -------------------------------------------------------------- 7. decay
console.log("\n7. A balance nobody touched for two months shrinks");
const decayed = engine.applyDecay(
  account(ana, 10_000),
  {
    amountPerPeriod: 0,
    permillePerPeriod: 10,
    periodSeconds: 86400,
    floor: 1000,
    graceSeconds: 30 * 86400,
  },
  {
    now: NOW + 60 * DAY_MS,
    operationId: "op-8",
    reason: "monthly demurrage",
    lastActivityAt: NOW,
  },
);
console.log(
  `   ${decayed.previousBalance} -> ${decayed.newBalance} over ${decayed.periods} periods`,
);

// -------------------------------------------------------- 8. idempotency
console.log("\n8. The same request arriving twice");
const log = new InMemoryOperationLog();
console.log(`   first time:  new? ${log.record("op-1")}`);
console.log(
  `   retry:       new? ${log.record("op-1")}   <- your UNIQUE constraint does this for real`,
);

// ------------------------------------------------------- 9. minor units
console.log("\n9. A currency with decimals");
const gold = createCurrency({ code: "GLD", name: "Gold", minorUnits: 2 });
const parts = splitMinorUnits(-123_456, gold);
console.log(
  `   -123456 stored = ${parts.negative ? "-" : ""}${parts.whole}.` +
    `${String(parts.fraction).padStart(2, "0")} ${gold.symbol}`,
);

// -------------------------------------------------- 10. what you store
console.log("\n10. What goes into your database");
console.log(
  "   " + JSON.stringify(serializePosting(transfer.posting), null, 2).replace(/\n/g, "\n   "),
);
